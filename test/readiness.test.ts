import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'
import { armCompletion, collectCompletion, warmCompletion } from '../src/readiness.ts'

test('renderer observation rejects stale rows and observes trusted keys through two frames', async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setContent('<div class="EditorInput"><textarea></textarea></div><div class="EditorCompletionItem">Array<span class="EditorCompletionItemHighlight">Arr</span></div>')
    await page.locator('textarea').focus()
    await armCompletion(page, 'lvce', 'Array', 'KeyA', 'Arra', { timeoutMs: 1000 })
    await page.keyboard.press('a')
    const sample = collectCompletion(page)
    let settled = false
    void sample.then(() => { settled = true })
    // Let several frames pass: the old highlight must never finish the sample.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))))
    assert.equal(settled, false)
    await page.locator('.EditorCompletionItemHighlight').evaluate((node) => { node.textContent = 'Arra' })
    const result = await sample
    assert.equal(result.highlight, 'Arra')
    assert.ok(result.milliseconds > 0)
    assert.equal(await page.evaluate(() => Boolean((window as typeof window & { cancelCompletionSample?: unknown }).cancelCompletionSample)), false)

    await armCompletion(page, 'lvce', 'Array', 'Space', undefined, { timeoutMs: 100 })
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', ctrlKey: true })))
    await assert.rejects(collectCompletion(page), /trusted key missing/)
    assert.equal(await page.evaluate(() => Boolean((window as typeof window & { cancelCompletionSample?: unknown }).cancelCompletionSample)), false)

    await armCompletion(page, 'lvce', 'Array', 'Space', undefined, { timeoutMs: 1000 })
    await page.keyboard.press('Control+Space')
    assert.ok((await collectCompletion(page)).milliseconds > 0)
  } finally {
    await browser.close()
  }
})


test('warmup waits for provider registration without retrying a measured interaction', async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setContent('<div class="EditorInput"><textarea></textarea></div>')
    await page.locator('textarea').focus()
    await page.evaluate(() => {
      let requests = 0
      document.addEventListener('keydown', (event) => {
        if (event.code !== 'Space' || !event.ctrlKey) return
        if (++requests === 2) {
          const row = document.createElement('div')
          row.className = 'EditorCompletionItem'
          row.textContent = 'Array'
          document.body.append(row)
        }
      })
    })
    assert.equal(await warmCompletion(page, 'lvce', 'Array', 2000, 100), 2)
  } finally { await browser.close() }
})
