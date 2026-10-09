import type { Page } from 'playwright'

export const completionUi = (editor: 'lvce' | 'vscode') => editor === 'lvce'
  ? { input: '.EditorInput textarea', rows: '.EditorCompletionItem', highlights: '.EditorCompletionItemHighlight' }
  // Modern Monaco uses EditContext. Its readonly IME textarea is not the editor input.
  : { input: '#workbench\\.parts\\.editor .monaco-editor .native-edit-context, #workbench\\.parts\\.editor .monaco-editor textarea.inputarea', rows: '.suggest-widget .monaco-list-row', highlights: '.suggest-widget .highlight' }

export interface Observation {
  milliseconds: number
  row: string
  highlight: string
}

export async function armCompletion(page: Page, editor: 'lvce' | 'vscode', expected: string, code: string, highlight?: string, timeoutMs = 30000): Promise<void> {
  await page.evaluate(({ selectors, expected, code, highlight, timeoutMs }) => {
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
        if (event.isTrusted && event.code === code && (code !== 'Space' || event.ctrlKey) && start === undefined) start = performance.now()
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
          clean()
          resolve(observation)
        } else frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    })
    host.completionSample.catch(() => {})
  }, { selectors: completionUi(editor), expected, code, highlight, timeoutMs })
}

export const collectCompletion = (page: Page): Promise<Observation> => page.evaluate(() => (window as typeof window & { completionSample: Promise<Observation> }).completionSample)
