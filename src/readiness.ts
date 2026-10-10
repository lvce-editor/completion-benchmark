import type { Page } from 'playwright'

// Theia attaches its shell and trust dialog before registering global keyboard
// listeners. FrontendApplication.revealShell removes the preload indicator;
// registration follows in the same task, before our next keyboard command.
export async function waitTheiaWorkbench(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(document.querySelector('.theia-ApplicationShell')) && !document.querySelector('.theia-preload'))
}

export const completionUi = (editor: 'lvce' | 'vscode' | 'atom' | 'theia') => editor === 'lvce'
  ? { input: '.EditorInput textarea', rows: '.EditorCompletionItem', highlights: '.EditorCompletionItemHighlight' }
  : editor === 'atom' ? { input: 'atom-text-editor:not([mini]) .hidden-input', rows: 'autocomplete-suggestion-list li .word', highlights: '.character-match' }
  : editor === 'theia' ? { input: '.theia-editor .monaco-editor .native-edit-context, .theia-editor .monaco-editor textarea.inputarea', rows: '.suggest-widget .monaco-list-row', highlights: '.suggest-widget .highlight' }
  // Modern Monaco uses EditContext. Its readonly IME textarea is not the editor input.
  : { input: '#workbench\\.parts\\.editor .monaco-editor .native-edit-context, #workbench\\.parts\\.editor .monaco-editor textarea.inputarea', rows: '.suggest-widget .monaco-list-row', highlights: '.suggest-widget .highlight' }

export interface Observation {
  milliseconds: number
  row: string
  highlight: string
}

export async function armCompletion(page: Page, editor: 'lvce' | 'vscode' | 'atom' | 'theia', expected: string, code: string, highlight?: string, options: { timeoutMs?: number; traceMarkers?: boolean } = {}): Promise<void> {
  await page.evaluate(({ selectors, expected, code, highlight, timeoutMs, traceMarkers }) => {
    type Host = typeof window & { completionSample?: Promise<{ milliseconds: number; row: string; highlight: string }>; cancelCompletionSample?: () => void }
    const host = window as Host
    host.cancelCompletionSample?.()
    host.completionSample = new Promise((resolve, reject) => {
      let start: number | undefined
      let frame = 0
      let consecutive = 0
      const clean = () => {
        clearTimeout(timer)
        cancelAnimationFrame(frame)
        document.removeEventListener('keydown', keydown, true)
        host.cancelCompletionSample = undefined
      }
      const cancel = () => { clean(); reject(new Error('Completion observation cancelled')) }
      host.cancelCompletionSample = cancel
      const timer = setTimeout(() => { clean(); reject(new Error(`Completion timeout: ${expected}, query ${highlight ?? '(opening)'}, trusted key ${start === undefined ? 'missing' : 'observed'}`)) }, timeoutMs)
      const keydown = (event: KeyboardEvent) => {
        if (event.isTrusted && event.code === code && (code !== 'Space' || event.ctrlKey) && start === undefined) {
          start = performance.now()
          if (traceMarkers && code === 'Space') console.timeStamp('completion-benchmark:start')
        }
      }
      document.addEventListener('keydown', keydown, true)
      const visible = (node: Element) => Boolean(node.getClientRects().length)
      const tick = () => {
        const row = [...document.querySelectorAll(selectors.rows)].filter(visible).find((node) => {
          // Require the expected label at the beginning, rather than matching descriptions.
          if (!(node.textContent ?? '').trim().toLowerCase().startsWith(expected.toLowerCase())) return false
          const query = [...node.querySelectorAll(selectors.highlights)].filter(visible).map((node) => node.textContent ?? '').join('')
          return !highlight || query.toLowerCase() === highlight.toLowerCase()
        })
        const input = document.querySelector(selectors.input)
        const focused = input === document.activeElement
        consecutive = start !== undefined && focused && row ? consecutive + 1 : 0
        if (consecutive >= 2 && row) {
          const observation = { milliseconds: performance.now() - start!, row: row.textContent ?? '', highlight: [...row.querySelectorAll(selectors.highlights)].filter(visible).map((node) => node.textContent ?? '').join('') }
          if (traceMarkers && highlight) console.timeStamp('completion-benchmark:end')
          clean()
          resolve(observation)
        } else frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    })
    host.completionSample.catch(() => {})
  }, { selectors: completionUi(editor), expected, code, highlight, timeoutMs: options.timeoutMs ?? 30000, traceMarkers: options.traceMarkers ?? false })
}

export const collectCompletion = (page: Page): Promise<Observation> => page.evaluate(() => (window as typeof window & { completionSample: Promise<Observation> }).completionSample)

export async function closeCompletions(page: Page, editor: 'lvce' | 'vscode' | 'atom' | 'theia'): Promise<void> {
  const rows = completionUi(editor).rows
  await page.keyboard.press('Escape')
  if (editor !== 'atom' && await page.evaluate((rows) => [...document.querySelectorAll(rows)].some((row) => row.getClientRects().length), rows)) await page.keyboard.press('Control+Space')
  await page.waitForFunction((rows) => ![...document.querySelectorAll(rows)].some((row) => row.getClientRects().length), rows)
}

// The first request can arrive before a language provider registers. Retry only
// discarded readiness requests; a measured interaction is never retried.
export async function warmCompletion(page: Page, editor: 'lvce' | 'vscode' | 'atom' | 'theia', expected: string, timeoutMs = 30000, requestTimeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let requests = 0
  while (Date.now() < deadline) {
    await closeCompletions(page, editor)
    await armCompletion(page, editor, expected, 'Space', undefined, { timeoutMs: Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())) })
    await page.keyboard.press('Control+Space')
    requests++
    try {
      await collectCompletion(page)
      return requests
    } catch (error) {
      if (!String(error).includes('Completion timeout:')) throw error
    }
  }
  throw new Error(`Provider warmup failed after ${requests} discarded requests: ${expected}`)
}
