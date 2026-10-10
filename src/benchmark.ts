import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { chromium, type Browser, type Page, type CDPSession } from 'playwright'
import { Protocol } from './protocol.ts'
import { TargetSession } from './target-session.ts'
import { processInstrumentation, utilityBootstrap, parseInspectorProcesses } from './process-instrumentation.ts'
import { ProfileSetupTargetExited, withFreshProfileSetup, assertProfileTargetMembership } from './profile-setup.ts'
import { summarizeCpuProfile, summarizeInteractionTrace, type TraceEvent } from './metrics.ts'
import { armCompletion, collectCompletion, completionUi, closeCompletions, warmCompletion } from './readiness.ts'

type EditorId = 'lvce' | 'vscode'
type Language = 'html' | 'typescript'
interface Trial {
  editor: EditorId
  language: Language
  repeat: number
  phase: 'latency' | 'render' | 'profile'
  status: 'passed' | 'failed'
  openingMs: number | null
  filteringMs: number | null
  render: ReturnType<typeof summarizeInteractionTrace> | null
  screenshot: string | null
  trace: string | null
  javascript?: { frontendMs: number; backendMs: number; totalMs: number; profiles: JavaScriptProfile[]; coverage: { targets: number; workers: number; backendProcesses: number }; samplingIntervalMicroseconds: number; captureStartedAt: string; captureEndedAt: string; captureBoundary: string }
  warmupRequests?: number
  observations?: { opening: { row: string; highlight: string }; filtering: { row: string; highlight: string } }
  error?: string
}

interface JavaScriptProfile { side: 'frontend' | 'backend'; identity: Record<string, unknown>; file: string; javascriptMs: number; idleMs: number; vmMs: number; samples: number; discardedSamples: number; durationMs: number }

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

async function launch(editor: EditorId, language: Language, outputPrefix: string, profiling = false) {
  const root = await mkdtemp(join(tmpdir(), `completion-benchmark-${editor}-${language}-`))
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state') }
  await Promise.all([env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME].map((path) => mkdir(path, { recursive: true })))
  const preload = join(root, 'process-instrumentation.cjs')
  const inspectorInventory = join(root, 'process-inspectors.jsonl')
  if (profiling) {
    await writeFile(preload, processInstrumentation)
    await writeFile(join(root, 'utility-bootstrap.cjs'), utilityBootstrap)
  }
  const userData = join(root, 'profile')
  await mkdir(join(userData, 'User'), { recursive: true })
  await writeFile(join(userData, 'User/settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'editor.minimap.enabled': false, 'editor.quickSuggestions': false }))
  if (editor === 'vscode') {
    await writeFile(join(userData, 'User/keybindings.json'), JSON.stringify([{ key: 'ctrl+space', command: 'editor.action.triggerSuggest', when: 'editorTextFocus' }]))
  }
  const binary = editor === 'lvce' ? setup.lvce.binary : setup.vscode.binary
  const workspace = resolve(`.tmp/fixture/${language}`)
  const file = join(workspace, language === 'html' ? 'index.html' : 'index.ts')
  const args = ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', ...(profiling ? ['--inspect-brk=0'] : []), `--user-data-dir=${userData}`]
  if (editor === 'lvce') {
    const extension = join(root, 'data/lvce/extensions/builtin.language-features-typescript')
    await mkdir(join(root, 'config/lvce'), { recursive: true })
    await mkdir(join(root, 'data/lvce/extensions'), { recursive: true })
    await writeFile(join(root, 'config/lvce/settings.json'), JSON.stringify({ 'editor.diagnostics': true, 'editor.completionsOnType': true }))
    await cp(join('.tmp/apps/typescript-extension'), extension, { recursive: true })
    args.push(workspace, file)
  } else {
    args.push(`--extensions-dir=${join(root, 'extensions')}`, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window', workspace, file)
  }
  const child = spawn(binary, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  let childError: Error | undefined
  child.on('error', (error) => { childError = error })
  child.stdout.on('data', (data) => { log += data })
  child.stderr.on('data', (data) => { log += data })
  let browser: Browser | undefined
  let main: Protocol | undefined
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    process.off('SIGINT', interrupted)
    process.off('SIGTERM', interrupted)
    if (child.pid) {
      for (const pid of await descendantsOf(child.pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ } }
    }
    main?.close()
    await browser?.close().catch(() => {})
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* The editor has already exited. */ }
      await Promise.race([new Promise<void>((done) => child.once('exit', () => done())), delay(1000)])
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* The process group has exited. */ }
    }
    if (profiling) await cp(inspectorInventory, `${outputPrefix}-backend-inspectors.jsonl`).catch(() => {})
    await writeFile(`${outputPrefix}.log`, log)
    await cp(join(userData, 'logs'), `${outputPrefix}-logs`, { recursive: true }).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
  const interrupted = () => { void close().finally(() => process.exit(130)) }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  try {
    const deadline = Date.now() + 60000
    if (profiling) {
      let inspector = ''
      while (Date.now() < deadline && !inspector) {
        if (childError) throw childError
        if (child.exitCode !== null) throw new Error(`Editor exited during inspector startup (${child.exitCode})`)
        inspector = log.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1] ?? ''
        if (!inspector) await delay(50)
      }
      if (!inspector) throw new Error('Timed out waiting for main-process inspector')
      main = await Protocol.connect(inspector)
      await main.send('Debugger.enable')
      const paused = main.event('Debugger.paused')
      await main.send('Runtime.runIfWaitingForDebugger')
      await paused
      const instrumented = await main.send('Runtime.evaluate', { expression: `(()=>{ const load=process.getBuiltinModule('module').createRequire(process.cwd()+'/completion-benchmark.cjs'); load(${JSON.stringify(preload)}); return true; })()`, returnByValue: true })
      if (instrumented.exceptionDetails || instrumented.result.value !== true) throw new Error(`Inspector process instrumentation failed: ${JSON.stringify(instrumented)}`)
      await main.send('Debugger.resume')
      await main.send('Debugger.disable')
    }
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
    return { page, browser, close, editor, language, main, inspectorInventory }
  } catch (error) {
    await close()
    throw error
  }
}

async function profileWorkload(app: Awaited<ReturnType<typeof launch>>, prefix: string, action: () => Promise<unknown>) {
  return withFreshProfileSetup((attempt) => captureProfileWorkload(app, `${prefix}-capture-${attempt}`, action))
}

async function captureProfileWorkload(app: Awaited<ReturnType<typeof launch>>, prefix: string, action: () => Promise<unknown>) {
  if (!app.main) throw new Error('Missing main-process inspector')
  const root = await app.browser!.newBrowserCDPSession()
  const pageSession = await app.page.context().newCDPSession(app.page)
  const sessions: { session: { send(method: string, params?: Record<string, unknown>): Promise<any> }; side: 'frontend' | 'backend'; identity: Record<string, unknown>; owned?: { close(): void | Promise<void> } }[] = []
  const beforeTargets: any[] = []
  const started: typeof sessions = []
  let captureStartedAt = ''
  let captureEndedAt = ''
  let profilerStage = 'page auto-attach'
  let interactionStarted = false
  const destroyedTargets = new Set<string>()
  const targetChanges: { kind: 'created' | 'destroyed'; targetId: string; observedAt: number }[] = []
  let captureStart = 0
  let captureEnd = 0
  const lifecycle: Record<string, unknown>[] = []
  const record = (event: string, details: Record<string, unknown> = {}) => {
    lifecycle.push({ at: new Date().toISOString(), elapsedMs: performance.now(), stage: profilerStage, event, ...details })
  }
  const listeners = [root, pageSession].flatMap((session, index) =>
    (['Target.attachedToTarget', 'Target.detachedFromTarget', 'Target.targetCreated', 'Target.targetDestroyed', 'Target.targetInfoChanged'] as const).map((event) => {
      const listener = (details: Record<string, unknown>) => {
        if (index === 0 && event === 'Target.targetDestroyed' && typeof details.targetId === 'string') {
          destroyedTargets.add(details.targetId)
          targetChanges.push({ kind: 'destroyed', targetId: details.targetId, observedAt: performance.now() })
        }
        if (index === 0 && event === 'Target.targetCreated') {
          const target = details.targetInfo as { type: string; targetId: string }
          if (['page', 'worker', 'shared_worker', 'service_worker', 'iframe'].includes(target.type)) targetChanges.push({ kind: 'created', targetId: target.targetId, observedAt: performance.now() })
        }
        record(event, { source: index === 0 ? 'browser' : 'page', ...details })
      }
      session.on(event, listener)
      return { session, event, listener }
    }))
  const snapshot = async (label: string) => {
    const { targetInfos } = await root.send('Target.getTargets')
    record('target inventory', { label, targetInfos })
    return targetInfos
  }
  const command = async (entry: typeof sessions[number], method: string, params: Record<string, unknown> = {}) => {
    record('command sent', { method, side: entry.side, identity: entry.identity })
    try {
      const result = await entry.session.send(method, params)
      record('command completed', { method, side: entry.side, identity: entry.identity })
      return result
    } catch (error) {
      record('command failed', { method, side: entry.side, identity: entry.identity, error: String(error) })
      throw error
    }
  }
  try {
    await root.send('Target.setDiscoverTargets', { discover: true })
    await pageSession.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    profilerStage = 'read application target'
    const { targetInfo: applicationTarget } = await pageSession.send('Target.getTargetInfo')
    if (!applicationTarget?.targetId || applicationTarget.type !== 'page') throw new Error('Missing application page target')
    const supported = ['page', 'worker', 'shared_worker', 'service_worker', 'iframe']
    profilerStage = 'discover frontend targets'
    const discoveredTargets = (await root.send('Target.getTargets')).targetInfos.filter((target: any) => supported.includes(target.type))
    beforeTargets.push(...discoveredTargets)
    record('initial target inventory', { targets: beforeTargets })
    if (!beforeTargets.some((target) => target.targetId === applicationTarget.targetId)) throw new Error('Missing application page target coverage')
    const isolateIds = new Set<string>()
    for (const target of beforeTargets) {
      let targetSession: TargetSession | undefined
      let sessionId: string | undefined
      profilerStage = `attach frontend target ${target.type} ${target.targetId}`
      try {
        ({ sessionId } = await root.send('Target.attachToTarget', { targetId: target.targetId, flatten: false }))
        record('target attached', { target, sessionId })
        targetSession = new TargetSession(root, sessionId!)
        const { id } = await targetSession.send('Runtime.getIsolateId')
        if (isolateIds.has(id)) { await targetSession.close(); continue }
        isolateIds.add(id)
        sessions.push({ session: targetSession, side: 'frontend', identity: { type: target.type, targetId: target.targetId, url: target.url, isolateId: id, sessionId }, owned: targetSession })
      } catch (error) {
        await targetSession?.close().catch(() => {})
        const currentTargets = (await root.send('Target.getTargets')).targetInfos.filter((entry: any) => supported.includes(entry.type))
        throw new Error(`Failed to attach frontend target ${JSON.stringify(target)} with session ${sessionId ?? 'none'}; target still present: ${currentTargets.some((entry: any) => entry.targetId === target.targetId)}; current targets: ${JSON.stringify(currentTargets)}; cause: ${String(error)}`)
      }
    }
    profilerStage = 'identify Electron main process'
    const mainInfo = (await app.main.send('Runtime.evaluate', { expression: '({pid:process.pid,argv:process.argv})', returnByValue: true })).result.value
    if (!Number.isSafeInteger(mainInfo?.pid)) throw new Error('Could not identify the Electron main process')
    sessions.push({ session: app.main, side: 'backend', identity: { role: 'main', ...mainInfo } })
    profilerStage = 'inventory backend processes'
    const inventory = async () => {
      const records = parseInspectorProcesses(await readFile(app.inspectorInventory, 'utf8'))
      const live = []
      for (const record of records) {
        try { await readFile(`/proc/${record.pid}/stat`, 'utf8'); live.push(record) } catch { /* Exited before capture. */ }
      }
      const descendants = await descendantsOf(mainInfo.pid)
      const uncovered = []
      for (const pid of descendants) {
        try {
          const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean)
          const chromiumType = argv.find((arg) => arg.startsWith('--type='))
          const nodeBackend = chromiumType ? argv.some((arg) => /^--utility-sub-type=.*NodeService$/.test(arg)) : argv.some((arg) => /\.(?:c?js|mjs)$/.test(arg))
          if (nodeBackend && !live.some((record) => record.pid === pid)) uncovered.push({ pid, argv })
        } catch { /* A process exited during the snapshot. */ }
      }
      if (uncovered.length) throw new Error(`Uninstrumented backend descendants: ${JSON.stringify(uncovered)}`)
      return live.filter((record) => record.pid !== mainInfo.pid)
    }
    const beforeProcesses = await inventory()
    record('backend inventory', { label: 'before capture', processes: beforeProcesses })
    if (app.editor === 'vscode' && app.language === 'typescript' && !beforeProcesses.some((record) => record.argv.some((arg) => arg.endsWith('/tsserver.js')))) throw new Error('Missing VS Code tsserver backend coverage')
    for (const process of beforeProcesses) {
      const session = await Protocol.connect(process.url)
      sessions.push({ session, side: 'backend', identity: { ...process, file: process.argv.find((arg) => /\.(?:c?js|mjs)$/.test(arg)) }, owned: session })
      const actual = (await session.send('Runtime.evaluate', { expression: 'process.pid', returnByValue: true })).result.value
      if (actual !== process.pid) throw new Error(`Backend inspector PID mismatch: expected ${process.pid}, got ${actual}`)
    }
    if (!sessions.some((entry) => entry.side === 'frontend' && entry.identity.type === 'worker') && app.editor === 'lvce') throw new Error('Missing LVCE frontend worker coverage')
    for (const entry of sessions) {
      profilerStage = `enable profiler for ${entry.side} ${JSON.stringify(entry.identity)}`
      try {
        await command(entry, 'Profiler.enable')
        await command(entry, 'Profiler.setSamplingInterval', { interval: 1000 })
      } catch (error) { throw new Error(`${profilerStage}: ${String(error)}`) }
    }
    await snapshot('before profiler start')
    captureStart = performance.now()
    captureStartedAt = new Date().toISOString()
    record('capture start', { captureStartedAt })
    for (const entry of sessions) {
      profilerStage = `start profiler for ${entry.side} ${JSON.stringify(entry.identity)}`
      try { await command(entry, 'Profiler.start'); started.push(entry) }
      catch (error) { throw new Error(`${profilerStage}: ${String(error)}`) }
    }
    profilerStage = 'run completion interaction'
    const interactionTargets = (await snapshot('before interaction')).filter((target: any) => supported.includes(target.type))
    if (beforeTargets.map((target) => target.targetId).sort().join() !== interactionTargets.map((target: any) => target.targetId).sort().join()) throw new Error('Frontend target membership changed during profiler setup')
    interactionStarted = true
    record('interaction start')
    const actionResult = await action()
    record('interaction end')
    const afterTargets = (await snapshot('interaction endpoint')).filter((target: any) => supported.includes(target.type))
    captureEnd = performance.now()
    captureEndedAt = new Date().toISOString()
    record('capture end', { captureEndedAt })
    assertProfileTargetMembership(beforeTargets.map((target) => target.targetId), afterTargets.map((target: any) => target.targetId), targetChanges, captureStart, captureEnd)
    const afterProcesses = await inventory()
    record('backend inventory', { label: 'interaction endpoint', processes: afterProcesses })
    if (beforeProcesses.map((process) => process.pid).sort().join() !== afterProcesses.map((process) => process.pid).sort().join()) throw new Error(`Profiler backend membership changed during interaction: ${JSON.stringify({ beforeProcesses, afterProcesses })}`)
    const profiles: JavaScriptProfile[] = []
    for (const [index, entry] of sessions.entries()) {
      profilerStage = `stop profiler for ${entry.side} ${JSON.stringify(entry.identity)}`
      let profile: unknown
      try { ({ profile } = await command(entry, 'Profiler.stop')) }
      catch (error) { throw new Error(`${profilerStage}: ${String(error)}`) }
      const file = `${basename(prefix)}-${entry.side}-${index}.cpuprofile`
      await writeFile(join(output, file), JSON.stringify(profile))
      profiles.push({ side: entry.side, identity: entry.identity, file, ...summarizeCpuProfile(profile as Parameters<typeof summarizeCpuProfile>[0]) })
      started.splice(started.indexOf(entry), 1)
    }
    const frontendMs = profiles.filter((profile) => profile.side === 'frontend').reduce((sum, profile) => sum + profile.javascriptMs, 0)
    const backendMs = profiles.filter((profile) => profile.side === 'backend').reduce((sum, profile) => sum + profile.javascriptMs, 0)
    return { actionResult, profiles, frontendMs, backendMs, totalMs: frontendMs + backendMs, coverage: { targets: beforeTargets.length, workers: beforeTargets.filter((target) => target.type === 'worker').length, backendProcesses: beforeProcesses.length + 1 }, samplingIntervalMicroseconds: 1000, captureStartedAt, captureEndedAt, captureBoundary: 'Profiler start immediately before opening Ctrl+Space keydown through query-qualified filtering endpoint after two animation frames and endpoint target inventory acknowledgement' }
  } catch (error) {
    record('failure', { error: String(error) })
    const currentTargets = await snapshot('failure').catch((snapshotError) => {
      record('inventory failed', { error: String(snapshotError) })
      return undefined
    })
    const exitedTargets = beforeTargets.filter((target) => destroyedTargets.has(target.targetId) && currentTargets && !currentTargets.some((current: any) => current.targetId === target.targetId))
    if (!interactionStarted && exitedTargets.length) {
      record('discarded setup capture', { exitedTargets, reason: 'Verified target destruction before completion interaction; restart with a fresh complete inventory' })
      throw new ProfileSetupTargetExited(`Target exited before interaction: ${JSON.stringify(exitedTargets)}; cause: ${String(error)}`)
    }
    throw new Error(`Profiler setup failed at ${profilerStage}: ${String(error)}`)
  } finally {
    // Persist before teardown so cleanup detach events cannot be mistaken for the failure.
    for (const { session, event, listener } of listeners) session.off(event, listener)
    try {
      await writeFile(`${prefix}-profiler-lifecycle.json`, JSON.stringify({ captureStartedAt, captureEndedAt, captureStart, captureEnd, targetChanges, lifecycle }, null, 2))
    } finally {
      await Promise.allSettled(started.map((entry) => entry.session.send('Profiler.stop')))
      await Promise.allSettled(sessions.map((entry) => entry.owned?.close()))
      await pageSession.detach().catch(() => {})
      await root.detach().catch(() => {})
    }
  }
}

async function measure(editor: EditorId, language: Language, repeat: number, phase: Trial['phase']): Promise<Trial> {
  const prefix = join(output, `${editor}-${language}-${repeat + 1}-${phase}`)
  const traced = phase === 'render'
  const profiling = phase === 'profile'
  let app: Awaited<ReturnType<typeof launch>> | undefined
  let page: Page | undefined
  let session: CDPSession | undefined
  const events: TraceEvent[] = []
  let stage = 'launch'
  try {
    app = await launch(editor, language, prefix, profiling)
    page = app.page
    const expected = language === 'html' ? 'a' : 'Array'
    const filteredExpected = language === 'html' ? 'h1' : 'Array'
    const filterKey = language === 'html' ? 'h' : 'a'
    const filterCode = language === 'html' ? 'KeyH' : 'KeyA'
    await page.keyboard.press('Control+End')
    stage = 'warmup'
    const warmupRequests = await warmCompletion(page, editor, expected)
    await closeCompletions(page, editor)
    stage = profiling ? 'profiler setup' : 'interaction'
    if (traced) {
      session = await page.context().newCDPSession(page)
      session.on('Tracing.dataCollected', (data: { value: TraceEvent[] }) => events.push(...data.value))
      await session.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing', transferMode: 'ReportEvents' })
    }
    const interaction = async () => {
      stage = 'opening'
      await armCompletion(page!, editor, expected, 'Space', undefined, { traceMarkers: traced })
      await page!.keyboard.press('Control+Space')
      const opening = await collectCompletion(page!)
      stage = 'filtering'
      await armCompletion(page!, editor, filteredExpected, filterCode, language === 'html' ? 'h' : 'Arra', { traceMarkers: traced })
      await page!.keyboard.press(filterKey)
      const filtering = await collectCompletion(page!)
      if (opening.milliseconds === undefined || filtering.milliseconds === undefined) throw new Error('A timed completion interaction did not include its trusted keydown timestamp')
      return { opening, filtering }
    }
    const profileResult = profiling ? await profileWorkload(app, prefix, interaction) : undefined
    const timings = (profileResult?.actionResult ?? await interaction()) as Awaited<ReturnType<typeof interaction>>
    const openingMs = timings?.opening.milliseconds ?? (profiling ? null : undefined)
    const filteringMs = timings?.filtering.milliseconds ?? (profiling ? null : undefined)
    let render = null
    let trace: string | null = null
    stage = 'trace summary'
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
    return { editor, language, repeat, phase, status: 'passed', warmupRequests, openingMs: openingMs ?? null, filteringMs: filteringMs ?? null, observations: profiling && timings ? { opening: timings.opening, filtering: timings.filtering } : undefined, render, screenshot, trace, javascript: profileResult ? { frontendMs: profileResult.frontendMs, backendMs: profileResult.backendMs, totalMs: profileResult.totalMs, profiles: profileResult.profiles, coverage: profileResult.coverage, samplingIntervalMicroseconds: profileResult.samplingIntervalMicroseconds, captureStartedAt: profileResult.captureStartedAt, captureEndedAt: profileResult.captureEndedAt, captureBoundary: profileResult.captureBoundary } : undefined }
  } catch (error) {
    if (page) {
      const evidence = await page.evaluate(() => ({
        title: document.title,
        url: location.href,
        body: (document.body?.innerText ?? '').slice(0, 5000),
        activeElement: document.activeElement?.outerHTML.slice(0, 500),
        completionRows: [...document.querySelectorAll('.EditorCompletionItem, .suggest-widget .monaco-list-row')].slice(0, 30).map((node) => ({ text: node.textContent, visible: Boolean(node.getClientRects().length), html: node.outerHTML.slice(0, 500) })),
      })).catch(() => ({ title: '', url: '', body: '', activeElement: '', completionRows: [] }))
      await writeFile(`${prefix}-failure.json`, JSON.stringify({ stage, error: String(error), evidence }, null, 2)).catch(() => {})
      await page.screenshot({ path: `${prefix}-failure.png` }).catch(() => {})
    }
    return { editor, language, repeat, phase, status: 'failed', openingMs: null, filteringMs: null, render: null, screenshot: null, trace: null, error: `${stage}: ${String(error)}` }
  } finally {
    await session?.detach().catch(() => {})
    await app?.close().catch(() => {})
  }
}

for (const editor of editors) for (const language of languages) for (let repeat = 0; repeat < repeats; repeat++) {
  const latency = await measure(editor, language, repeat, 'latency')
  trials.push(latency)
  if (latency.status === 'passed') {
    trials.push(await measure(editor, language, repeat, 'render'))
    trials.push(await measure(editor, language, repeat, 'profile'))
  }
  await writeFile(join(output, 'results.json'), `${JSON.stringify({ schemaVersion: 1, metadata: setup, trials }, null, 2)}\n`)
  console.log(trials.at(-1))
}
if (trials.some((trial) => trial.status !== 'passed')) process.exitCode = 1
