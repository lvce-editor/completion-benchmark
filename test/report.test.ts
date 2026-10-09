import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('report includes six comparisons, evidence links and visible failures without zero samples', async () => {
  const root = await mkdtemp(join(tmpdir(), 'completion-report-test-'))
  try {
    await writeFile(join(root, 'results.json'), JSON.stringify({ metadata: { lvce: { version: 'test' }, vscode: { version: 'test' } }, trials: [
      { editor: 'lvce', language: 'html', status: 'passed', openingMs: 12, filteringMs: 8, render: null },
      { editor: 'vscode', language: 'html', repeat: 0, status: 'failed', openingMs: null, filteringMs: null, render: null, error: 'missing <items>' },
    ] }))
    const result = spawnSync(process.execPath, [resolve('src/report.ts'), '--input', root, '--output', join(root, 'site')])
    assert.equal(result.status, 1)
    const html = await readFile(join(root, 'site/index.html'), 'utf8')
    assert.equal((html.match(/<svg role="img"/g) ?? []).length, 6)
    assert.match(html, /vscode\/html: no samples/)
    assert.match(html, /missing &lt;items&gt;/)
    assert.match(html, /raw\/.+-results.json/)
    assert.match(html, /12.00 \/ 12.00 ms \(n=1\)/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
