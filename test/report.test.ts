import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('report separates HTML and TypeScript comparisons, with visible failures and no synthetic zero samples', async () => {
  const root = await mkdtemp(join(tmpdir(), 'completion-report-test-'))
  try {
    await writeFile(join(root, 'results.json'), JSON.stringify({ metadata: { lvce: { version: 'test' }, vscode: { version: 'test' } }, trials: [
      { editor: 'lvce', language: 'html', status: 'passed', openingMs: 12, filteringMs: 8, render: null },
      { editor: 'lvce', language: 'typescript', status: 'passed', openingMs: 14, filteringMs: 9, render: null },
      { editor: 'vscode', language: 'html', repeat: 0, status: 'failed', openingMs: null, filteringMs: null, render: null, error: 'missing <items>' },
    ] }))
    const result = spawnSync(process.execPath, [resolve('src/report.ts'), '--input', root, '--output', join(root, 'site')])
    assert.equal(result.status, 1)
    const html = await readFile(join(root, 'site/index.html'), 'utf8')
    assert.equal((html.match(/<svg role="img"/g) ?? []).length, 12)
    assert.equal((html.match(/<h3>Completion opening<\/h3>/g) ?? []).length, 2)
    assert.ok(html.indexOf('HTML completions') < html.indexOf('TypeScript completions'))
    assert.match(html, /VS Code: no successful samples/)
    assert.match(html, /missing &lt;items&gt;/)
    assert.match(html, /raw\/.+-results.json/)
    assert.match(html, /12.00 \/ 12.00 ms \(n=1\)/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
