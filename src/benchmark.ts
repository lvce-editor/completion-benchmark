import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { chromium, type Browser, type Page, type CDPSession } from 'playwright'
import { summarizeInteractionTrace, type TraceEvent } from './metrics.ts'
import { armCompletion, collectCompletion, completionUi } from './readiness.ts'

type EditorId = 'lvce' | 'vscode'
type Language = 'html' | 'typescript'
interface Trial {
  editor: EditorId
  language: Language
  repeat: number
  phase: 'latency' | 'render'
  status: 'passed' | 'failed'
  openingMs: number | null
  filteringMs: number | null
  render: ReturnType<typeof summarizeInteractionTrace> | null
  screenshot: string | null
  trace: string | null
  observations?: { opening: { row: string; highlight: string }; filtering: { row: string; highlight: string } }
  error?: string
}

const { values } = parseArgs({ options: {
  editor: { type: 'string' }, language: { type: 'string' }, repeats: { type: 'string', default: '3' }, output: { type: 'string', default: 'results' },
} })
const editors = (values.editor ? [values.editor] : ['lvce', 'vscode']) as EditorId[]
const languages = (values.language ? [values.language] : ['html', 'typescript']) as Language[]
if (editors.some((editor) => !['lvce', 'vscode'].includes(editor))) throw new Error('--editor must be lvce or vscode')
if (languages.some((language) => !['html', 'typescript'].includes(language))) throw new Error('--language must be html or typescript')
const repeats = Number(values.repeats)
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeats must be between 1 and 20')
const setup = JSON.parse(await readFile('.tmp/setup.json', 'utf8'))
const output = resolve(values.output!)
await mkdir(output, { recursive: true })
const trials: Trial[] = []

async function descendantsOf(rootPid: number): Promise<number[]> {
  const parents = new Map<number, number[]>()
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8')
      const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      parents.set(parent, [...(parents.get(parent) ?? []), Number(entry)])
    } catch { /* A process exited during the snapshot. */ }
  }
  const result: number[] = []
  const visit = (pid: number) => { for (const child of parents.get(pid) ?? []) { visit(child); result.push(child) } }
  visit(rootPid)
  return result
}

async function launch(editor: EditorId, language: Language, outputPrefix: string) {
  const root = await mkdtemp(join(tmpdir(), `completion-benchmark-${editor}-${language}-`))
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state') }
  await Promise.all([env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME].map((path) => mkdir(path, { recursive: true })))
  const userData = join(root, 'profile')
  await mkdir(join(userData, 'User'), { recursive: true })
  await writeFile(join(userData, 'User/settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'editor.minimap.enabled': false, 'editor.quickSuggestions': false }))
  if (editor === 'vscode') {
    await writeFile(join(userData, 'User/keybindings.json'), JSON.stringify([{ key: 'ctrl+space', command: 'editor.action.triggerSuggest', when: 'editorTextFocus' }]))
  }
  const binary = editor === 'lvce' ? setup.lvce.binary : setup.vscode.binary
  const workspace = resolve(`.tmp/fixture/${language}`)
  const file = join(workspace, language === 'html' ? 'index.html' : 'index.ts')
  const args = ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${userData}`]
  if (editor === 'lvce') {
    const extension = join(root, 'data/lvce/extensions/builtin.language-features-typescript')
    await mkdir(join(root, 'config/lvce'), { recursive: true })
    await mkdir(join(root, 'data/lvce/extensions'), { recursive: true })
    await writeFile(join(root, 'config/lvce/settings.json'), JSON.stringify({ 'editor.diagnostics': true, 'editor.completionsOnType': true }))
    await cp(join('.tmp/apps/typescript-extension'), extension, { recursive: true })
    args.push(workspace, file)
  } else {
    args.push('--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window', workspace, file)
  }
  const child = spawn(binary, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  let childError: Error | undefined
  child.on('error', (error) => { childError = error })
  child.stdout.on('data', (data) => { log += data })
  child.stderr.on('data', (data) => { log += data })
  let browser: Browser | undefined
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    process.off('SIGINT', interrupted)
    process.off('SIGTERM', interrupted)
    if (child.pid) {
      for (const pid of await descendantsOf(child.pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ } }
    }
    await browser?.close().catch(() => {})
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* The editor has already exited. */ }
      await Promise.race([new Promise<void>((done) => child.once('exit', () => done())), delay(1000)])
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* The process group has exited. */ }
    }
    await writeFile(`${outputPrefix}.log`, log)
    await cp(join(userData, 'logs'), `${outputPrefix}-logs`, { recursive: true }).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
  const interrupted = () => { void close().finally(() => process.exit(130)) }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  try {
    const deadline = Date.now() + 60000
    let endpoint = ''
    while (Date.now() < deadline && !endpoint) {
      if (childError) throw childError
      if (child.exitCode !== null) throw new Error(`Editor exited during launch (${child.exitCode})`)
      endpoint = log.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1] ?? ''
      if (!endpoint) await delay(50)
    }
    if (!endpoint) throw new Error(`Timed out waiting for CDP endpoint; output: ${log.slice(-1500)}`)
    browser = await chromium.connectOverCDP(endpoint, { timeout: 30000 })
    let page: Page | undefined
    while (Date.now() < deadline && !page) {
      page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url() !== 'about:blank')
      if (!page) await delay(100)
    }
    if (!page) throw new Error('Editor did not open a workbench page')
    page.setDefaultTimeout(30000)
    await page.setViewportSize({ width: 1280, height: 900 })
    const input = page.locator(completionUi(editor).input)
    await input.waitFor({ state: 'attached' })
    if (editor === 'vscode') {
      await page.locator('#workbench\\.parts\\.editor .view-lines').click({ position: { x: 90, y: 80 } })
      await input.focus()
    } else {
      await input.focus()
    }
    if (!await input.evaluate((element) => document.activeElement === element)) {
      const active = await page.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 500), text: (document.body?.innerText ?? '').slice(0, 1200) }))
      await page.screenshot({ path: `${outputPrefix}-focus-failure.png` }).catch(() => {})
      await writeFile(`${outputPrefix}-focus-failure.json`, JSON.stringify(active, null, 2)).catch(() => {})
      throw new Error('Editor input did not receive focus')
    }
    return { page, close, editor, language }
  } catch (error) {
    await close()
    throw error
  }
}

async function measure(editor: EditorId, language: Language, repeat: number, traced: boolean): Promise<Trial> {
  const prefix = join(output, `${editor}-${language}-${repeat + 1}-${traced ? 'render' : 'latency'}`)
  let app: Awaited<ReturnType<typeof launch>> | undefined
  let page: Page | undefined
  let session: CDPSession | undefined
  const events: TraceEvent[] = []
  try {
    app = await launch(editor, language, prefix)
    page = app.page
    const expected = language === 'html' ? 'a' : 'Array'
    const filteredExpected = language === 'html' ? 'h1' : 'Array'
    const filterKey = language === 'html' ? 'h' : 'a'
    const filterCode = language === 'html' ? 'KeyH' : 'KeyA'
    await page.keyboard.press('Control+End')
    await armCompletion(page, editor, expected, 'Space')
    await page.keyboard.press('Control+Space')
    await collectCompletion(page)
    await page.keyboard.press('Escape')
    if (await page.locator(completionUi(editor).rows).first().isVisible()) await page.keyboard.press('Control+Space')
    await page.waitForFunction((rows) => ![...document.querySelectorAll(rows)].some((row) => row.getClientRects().length), completionUi(editor).rows)
    if (traced) {
      session = await page.context().newCDPSession(page)
      session.on('Tracing.dataCollected', (data: { value: TraceEvent[] }) => events.push(...data.value))
      await session.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing', transferMode: 'ReportEvents' })
    }
    await armCompletion(page, editor, expected, 'Space', undefined, { traceMarkers: traced })
    await page.keyboard.press('Control+Space')
    const opening = await collectCompletion(page)
    const openingMs = opening.milliseconds
    await armCompletion(page, editor, filteredExpected, filterCode, language === 'html' ? 'h' : 'Arra', { traceMarkers: traced })
    await page.keyboard.press(filterKey)
    const filtering = await collectCompletion(page)
    const filteringMs = filtering.milliseconds
    if (openingMs === undefined || filteringMs === undefined) throw new Error('A timed completion interaction did not include its trusted keydown timestamp')
    let render = null
    let trace: string | null = null
    if (traced && session) {
      const completed = new Promise<void>((resolve) => session!.once('Tracing.tracingComplete', () => resolve()))
      await session.send('Tracing.end')
      await completed
      trace = `${editor}-${language}-${repeat + 1}.trace.json`
      await writeFile(join(output, trace), JSON.stringify(events))
      render = summarizeInteractionTrace(events)
    }
    const screenshot = `${editor}-${language}-${repeat + 1}-${traced ? 'render' : 'latency'}.png`
    await page.screenshot({ path: join(output, screenshot) })
    return { editor, language, repeat, phase: traced ? 'render' : 'latency', status: 'passed', openingMs, filteringMs, observations: { opening, filtering }, render, screenshot, trace }
  } catch (error) {
    if (page) {
      const evidence = await page.evaluate(() => ({
        title: document.title,
        url: location.href,
        body: (document.body?.innerText ?? '').slice(0, 5000),
        activeElement: document.activeElement?.outerHTML.slice(0, 500),
        completionRows: [...document.querySelectorAll('.EditorCompletionItem, .suggest-widget .monaco-list-row')].slice(0, 30).map((node) => ({ text: node.textContent, visible: Boolean(node.getClientRects().length), html: node.outerHTML.slice(0, 500) })),
      })).catch(() => ({ title: '', url: '', body: '', activeElement: '', completionRows: [] }))
      await writeFile(`${prefix}-failure.json`, JSON.stringify({ error: String(error), evidence }, null, 2)).catch(() => {})
      await page.screenshot({ path: `${prefix}-failure.png` }).catch(() => {})
    }
    return { editor, language, repeat, phase: traced ? 'render' : 'latency', status: 'failed', openingMs: null, filteringMs: null, render: null, screenshot: null, trace: null, error: String(error) }
  } finally {
    await session?.detach().catch(() => {})
    await app?.close().catch(() => {})
  }
}

for (const editor of editors) for (const language of languages) for (let repeat = 0; repeat < repeats; repeat++) {
  const latency = await measure(editor, language, repeat, false)
  trials.push(latency)
  if (latency.status === 'passed') trials.push(await measure(editor, language, repeat, true))
  await writeFile(join(output, 'results.json'), `${JSON.stringify({ schemaVersion: 1, metadata: setup, trials }, null, 2)}\n`)
  console.log(trials.at(-1))
}
if (trials.some((trial) => trial.status !== 'passed')) process.exitCode = 1
