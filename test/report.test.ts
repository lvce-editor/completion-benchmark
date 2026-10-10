import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('report charts retain statistics, zero values, missing groups and failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'completion-report-test-'))
  try {
    await writeFile(join(root, 'results.json'), JSON.stringify({ metadata: {
      platform: 'linux', architecture: 'x64', node: 'test', host: {}, run: { id: 'run-id' }, measurement: {},
      lvce: { version: 'test' }, vscode: { version: 'test' }, fixtures: {},
    }, trials: [
      { editor: 'lvce', language: 'html', status: 'passed', openingMs: 0, filteringMs: 2, render: null },
      { editor: 'lvce', language: 'html', status: 'passed', openingMs: 100, filteringMs: 8, render: null },
      { editor: 'lvce', language: 'typescript', status: 'passed', openingMs: 14, filteringMs: 9, render: null },
      { editor: 'vscode', language: 'html', status: 'passed', openingMs: 12, filteringMs: 8, render: {
        paintDurationMs: 0, paintCount: 0, styleRecalculationDurationMs: 0, styleRecalculationCount: 0,
      } },
      { editor: 'vscode', language: 'html', repeat: 0, status: 'failed', openingMs: null, filteringMs: null, render: null, error: 'missing <items>' },
    ] }))
    const result = spawnSync(process.execPath, [resolve('src/report.ts'), '--input', root, '--output', join(root, 'site')])
    assert.equal(result.status, 1)
    const html = await readFile(join(root, 'site/index.html'), 'utf8')
    assert.equal((html.match(/<svg class="chart" role="img"/g) ?? []).length, 12)
    assert.equal((html.match(/<h3>Completion opening<\/h3>/g) ?? []).length, 2)
    assert.ok(html.indexOf('HTML completions') < html.indexOf('TypeScript completions'))
    assert.match(html, /Validated editors: LVCE Editor test · VS Code test/)
    assert.doesNotMatch(html, /platform unknown|run unknown|fixtures unknown/)
    assert.match(html, /no validated samples: VS Code, Eclipse Theia, Atom, Zed/)
    assert.match(html, /missing &lt;items&gt;/)
    assert.match(html, /raw\/.+-results.json/)
    assert.match(html, /0\.00 \/ 100\.00 ms \(n=2\)/)
    assert.match(html, /0\.00 \/ 0\.00 events \(n=1\)/)
    assert.match(html, /median markers|Blue markers show the median/)
    assert.match(html, /chart-scroll\{overflow-x:auto/)
    assert.match(html, /rotate\(48\)/)
    assert.match(html, /class="grid"/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
