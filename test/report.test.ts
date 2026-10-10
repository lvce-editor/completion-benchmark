import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

function chartEditors(html: string, title: string): string[] {
  const heading = html.indexOf(`<h3>${title}</h3>`)
  assert.notEqual(heading, -1, `missing chart: ${title}`)
  const start = html.indexOf('<svg class="chart"', heading)
  const end = html.indexOf('</svg>', start)
  assert.notEqual(start, -1, `missing SVG for chart: ${title}`)
  assert.notEqual(end, -1, `unterminated SVG for chart: ${title}`)
  return [...html.slice(start, end).matchAll(/<text class="editor"[^>]*>(.*?)<\/text>/g)].map(([, editor]) => editor!)
}

test('report charts retain statistics, zero values, missing groups and failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'completion-report-test-'))
  try {
    await writeFile(join(root, 'results.json'), JSON.stringify({ metadata: {
      platform: 'linux', architecture: 'x64', node: 'test', host: {}, run: { id: 'run-id' }, measurement: {},
      lvce: { version: 'test' }, vscode: { version: 'test' }, fixtures: {},
    }, trials: [
      { editor: 'lvce', language: 'html', phase: 'latency', status: 'passed', openingMs: 0, filteringMs: 2, render: null },
      { editor: 'lvce', language: 'html', phase: 'latency', status: 'passed', openingMs: 100, filteringMs: 8, render: null },
      { editor: 'atom', language: 'html', phase: 'latency', status: 'passed', openingMs: 0, filteringMs: 3, render: { paintDurationMs: 2, paintCount: 0, styleRecalculationDurationMs: 3, styleRecalculationCount: 5 } },
      { editor: 'theia', language: 'html', phase: 'latency', status: 'passed', openingMs: null, filteringMs: 3, render: null },
      { editor: 'lvce', language: 'typescript', status: 'passed', openingMs: 14, filteringMs: 9, render: null },
      { editor: 'vscode', language: 'html', phase: 'latency', status: 'passed', openingMs: 12, filteringMs: 8, render: {
        paintDurationMs: 0, paintCount: 0, styleRecalculationDurationMs: 0, styleRecalculationCount: 0,
      } },
      { editor: 'vscode', language: 'html', repeat: 0, status: 'failed', openingMs: null, filteringMs: null, render: null, error: 'missing <items>' },
      { editor: 'lvce', language: 'html', phase: 'profile', status: 'passed', javascript: { frontendMs: 2, backendMs: 3, totalMs: 5, profiles: [{ side: 'frontend', identity: { type: 'page', targetId: 'page-1', isolateId: 'isolate-1' }, file: 'renderer.cpuprofile', javascriptMs: 2 }, { side: 'backend', identity: { role: 'main', pid: 123 }, file: 'main.cpuprofile', javascriptMs: 3 }], coverage: { targets: 1, workers: 0, backendProcesses: 1 }, samplingIntervalMicroseconds: 1000, captureStartedAt: '2026-01-01T00:00:00.000Z', captureEndedAt: '2026-01-01T00:00:01.000Z', captureBoundary: 'completion interaction' } },
    ] }))
    await writeFile(join(root, 'renderer.cpuprofile'), JSON.stringify({ nodes: [] }))
    await writeFile(join(root, 'main.cpuprofile'), JSON.stringify({ nodes: [] }))
    const result = spawnSync(process.execPath, [resolve('src/report.ts'), '--input', root, '--output', join(root, 'site')])
    assert.equal(result.status, 1)
    const html = await readFile(join(root, 'site/index.html'), 'utf8')
    assert.equal((html.match(/<svg class="chart" role="img"/g) ?? []).length, 18)
    assert.equal((html.match(/<h3>Completion opening<\/h3>/g) ?? []).length, 2)
    assert.ok(html.indexOf('HTML completions') < html.indexOf('TypeScript completions'))
    assert.match(html, /Validated editors: LVCE Editor test · VS Code test/)
    assert.doesNotMatch(html, /platform unknown|run unknown|fixtures unknown/)
    assert.match(html, /no validated samples: Eclipse Theia, Zed/)
    assert.match(html, /missing &lt;items&gt;/)
    assert.match(html, /raw\/.+-results.json/)
    assert.match(html, /12.00 \/ 12.00 ms \(n=1\)/)
    assert.match(html, /<link rel="icon" href="favicon\.svg" type="image\/svg\+xml">/)
    assert.equal(await readFile(join(root, 'site/favicon.svg'), 'utf8'), await readFile(resolve('assets/favicon.svg'), 'utf8'))
    assert.match(html, /Frontend JavaScript execution time/)
    assert.match(html, /Total JavaScript/)
    assert.match(html, /No successful samples/)
    assert.match(html, /Frontend · renderer and workers/)
    assert.match(html, /3\.00 \/ 3\.00 ms \(n=1\)/)
    assert.match(html, /CPU profiles/)
    assert.ok((await readFile(join(root, 'site/raw/index.json'), 'utf8')).includes('main.cpuprofile'))
    assert.match(html, /0\.00 \/ 100\.00 ms \(n=2\)/)
    assert.match(html, /0\.00 \/ 0\.00 events \(n=1\)/)
    assert.match(html, /median markers|Blue markers show the median/)
    assert.match(html, /chart-scroll\{overflow-x:auto/)
    assert.match(html, /rotate\(48\)/)
    assert.match(html, /class="grid"/)
    assert.deepEqual(chartEditors(html, 'Completion opening').slice(0, 3), ['Atom', 'LVCE Editor', 'VS Code'])
    assert.deepEqual(chartEditors(html, 'Live completion filtering').slice(0, 4), ['LVCE Editor', 'Atom', 'Eclipse Theia', 'VS Code'])
    assert.deepEqual(chartEditors(html, 'Live completion filtering').slice(-1), ['Zed'])
    assert.deepEqual(chartEditors(html, 'Paint duration').slice(0, 2), ['VS Code', 'Atom'])
    assert.deepEqual(chartEditors(html, 'Paint duration').slice(-3), ['Eclipse Theia', 'LVCE Editor', 'Zed'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('report rejects missing backend profile coverage and inconsistent total milliseconds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'completion-profile-report-test-'))
  try {
    const profile: any = { frontendMs: 2, backendMs: 3, totalMs: 5, profiles: [{ side: 'frontend', identity: { type: 'page' }, file: 'frontend.cpuprofile', javascriptMs: 2 }] }
    await writeFile(join(root, 'results.json'), JSON.stringify({ trials: [{ editor: 'lvce', language: 'html', phase: 'profile', status: 'passed', javascript: profile }] }))
    const result = spawnSync(process.execPath, [resolve('src/report.ts'), '--input', root, '--output', join(root, 'site')])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr.toString(), /Incomplete JavaScript process\/isolate coverage/)
    profile.profiles.push({ side: 'backend', identity: { role: 'main' }, file: 'backend.cpuprofile', javascriptMs: 3 })
    profile.totalMs = 99
    await writeFile(join(root, 'results.json'), JSON.stringify({ trials: [{ editor: 'lvce', language: 'html', phase: 'profile', status: 'passed', javascript: profile }] }))
    const mismatch = spawnSync(process.execPath, [resolve('src/report.ts'), '--input', root, '--output', join(root, 'site')])
    assert.notEqual(mismatch.status, 0)
    assert.match(mismatch.stderr.toString(), /Invalid JavaScript totals/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
