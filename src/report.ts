import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { quantile } from './metrics.ts'

const { values } = parseArgs({ options: { input: { type: 'string', default: 'results' }, output: { type: 'string', default: 'site' } } })
const input = resolve(values.input!)
const output = resolve(values.output!)
await mkdir(join(output, 'raw'), { recursive: true })
const files: string[] = []
async function collect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) await collect(file)
    else if (entry.name === 'results.json') files.push(file)
  }
}
await collect(input)
if (files.length === 0) throw new Error(`No benchmark results found under ${input}`)
const records = await Promise.all(files.map(async (file) => ({ file, data: JSON.parse(await readFile(file, 'utf8')) })))
const trials = records.flatMap(({ data }) => data.trials)
const groups = new Map<string, typeof trials>()
for (const trial of trials) {
  const key = `${trial.editor}/${trial.language}`
  groups.set(key, [...(groups.get(key) ?? []), trial])
}
const failures = trials.filter((trial) => trial.status !== 'passed')
const median = (numbers: number[]) => quantile(numbers, 0.5)
const p95 = (numbers: number[]) => quantile(numbers, 0.95)
const cards = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, samples]) => {
  const [editor, language] = key.split('/')
  const opening = samples.filter((sample) => sample.status === 'passed' && !sample.render).map((sample) => sample.openingMs).filter((value): value is number => typeof value === 'number')
  const filtering = samples.filter((sample) => sample.status === 'passed' && !sample.render).map((sample) => sample.filteringMs).filter((value): value is number => typeof value === 'number')
  const rendering = samples.filter((sample) => sample.status === 'passed' && sample.render).map((sample) => sample.render)
  const timing = (name: string, values: number[]) => values.length
    ? `<article><h3>${name}</h3><p class="number">${median(values).toFixed(2)} <small>ms median</small></p><p>p95 ${p95(values).toFixed(2)} ms · ${values.length} samples</p></article>`
    : `<article><h3>${name}</h3><p class="missing">No successful samples</p></article>`
  const paint = rendering.flatMap((sample) => sample ? [sample.paintDurationMs] : [])
  const paintCount = rendering.flatMap((sample) => sample ? [sample.paintCount] : [])
  const style = rendering.flatMap((sample) => sample ? [sample.styleRecalculationDurationMs] : [])
  const styleCount = rendering.flatMap((sample) => sample ? [sample.styleRecalculationCount] : [])
  const renderCard = (name: string, ms: number[], count: number[]) => ms.length
    ? `<article><h3>${name}</h3><p class="number">${median(ms).toFixed(2)} <small>ms median</small></p><p>p95 ${p95(ms).toFixed(2)} ms · ${count.length ? median(count).toFixed(0) : '—'} events median · ${ms.length} samples</p></article>`
    : `<article><h3>${name}</h3><p class="missing">No successful samples</p></article>`
  return `<section><h2>${editor === 'lvce' ? 'LVCE Editor' : 'VS Code'} · ${language === 'html' ? 'HTML' : 'TypeScript'}</h2><div class="grid">${timing('Ctrl+Space to visible suggestions', opening)}${timing('Character filtering to visible match', filtering)}${renderCard('Paint', paint, paintCount)}${renderCard('CSS style recalculation', style, styleCount)}</div></section>`
}).join('')

const chartDefinitions = [
  { title: 'Completion opening', key: 'openingMs', unit: 'ms', traced: false },
  { title: 'Live completion filtering', key: 'filteringMs', unit: 'ms', traced: false },
  { title: 'Paint duration', key: 'paintDurationMs', unit: 'ms', traced: true },
  { title: 'Paint count', key: 'paintCount', unit: 'events', traced: true },
  { title: 'CSS style recalculation duration', key: 'styleRecalculationDurationMs', unit: 'ms', traced: true },
  { title: 'CSS style recalculation count', key: 'styleRecalculationCount', unit: 'events', traced: true },
]
const charts = chartDefinitions.map(({ title, key, unit, traced }) => {
  const bars = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, samples]) => {
    const values = samples.filter((sample) => sample.status === 'passed' && Boolean(sample.render) === traced)
      .map((sample) => traced ? sample.render[key] : sample[key]).filter((value: unknown): value is number => typeof value === 'number' && Number.isFinite(value))
    return { label, values }
  })
  const max = Math.max(1, ...bars.flatMap(({ values }) => values.length ? [p95(values)] : []))
  const rows = bars.map(({ label, values }, index) => {
    const y = index * 58 + 30
    if (!values.length) return `<text x="0" y="${y + 18}">${label}: no samples</text>`
    const width = median(values) / max * 400
    const end = p95(values) / max * 400
    return `<text x="0" y="${y + 18}">${label}</text><rect x="170" y="${y}" width="${width}" height="24" fill="${label.startsWith('lvce') ? '#3186c7' : '#a65fb4'}"/><line x1="${170 + width}" x2="${170 + end}" y1="${y + 12}" y2="${y + 12}" stroke="currentColor"/><text x="${180 + end}" y="${y + 18}">${median(values).toFixed(2)} / ${p95(values).toFixed(2)} ${unit} (n=${values.length})</text>`
  }).join('')
  return `<section><h2>${title}</h2><p class="muted">Bars: median · line ends: p95 · Atom/Zed: unavailable</p><svg role="img" aria-label="${title} comparison" viewBox="0 0 900 ${bars.length * 58 + 45}"><title>${title} by editor and language</title>${rows}</svg></section>`
}).join('')

const failuresHtml = failures.length ? `<section class="failures"><h2>${failures.length} failed trials</h2><p>Failed samples remain visible here and are never represented as zero.</p><ul>${failures.map((trial) => `<li>${trial.editor} · ${trial.language} · repetition ${trial.repeat + 1}: ${escapeHtml(trial.error ?? 'unknown failure')}</li>`).join('')}</ul></section>` : ''
function escapeHtml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') }
const provenance = records.map(({ data }) => data.metadata).filter(Boolean)
const versions = provenance[0] ?? {}
const rawIndex: string[] = []
for (const { file } of records) {
  const directory = file.slice(0, -'results.json'.length)
  const group = relative(input, directory).split(/[\\/]/).filter(Boolean).join('-') || basename(directory)
  for (const name of await readdir(directory)) {
    if (!['.json', '.trace.json', '.png', '.log'].includes(extname(name)) && !name.endsWith('.trace.json')) continue
    const source = join(directory, name)
    const targetName = name === 'results.json' ? `${group}-results.json` : name
    const target = join(output, 'raw', targetName)
    await cp(source, target)
    rawIndex.push(targetName)
  }
}
const rawLinks = [...new Set(rawIndex)].sort().map((name) => `<li><a href="raw/${encodeURIComponent(name)}">${escapeHtml(name)}</a></li>`).join('')
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LVCE completion benchmark</title><style>
:root{color-scheme:light dark;font:16px/1.55 system-ui,sans-serif}body{max-width:1120px;margin:40px auto;padding:0 24px;color:CanvasText;background:Canvas}h1{font-size:2.5rem;line-height:1.1}h2{margin:34px 0 12px}.muted,small{color:GrayText}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}article{border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:10px;padding:16px}svg{width:100%;height:auto}svg text{fill:currentColor;font-size:14px}article h3{font-size:1rem;margin:0}.number{font-size:1.8rem;font-weight:650;margin:12px 0 0}.number small{font-size:.8rem;font-weight:400}.missing{color:#c66}section{margin:30px 0}.failures{border-left:4px solid #c66;padding-left:16px}a{color:LinkText}summary{cursor:pointer;font-weight:650}code{overflow-wrap:anywhere}footer{margin:40px 0;color:GrayText}@media(max-width:600px){body{margin:20px auto;padding:0 14px}h1{font-size:2rem}}
</style></head><body><main><p class="muted">Reproducible desktop completion measurements · Linux x64 · ${trials.length} raw trials</p><h1>How quickly do code completions appear?</h1><p>LVCE Editor ${escapeHtml(versions.lvce?.version ?? 'unknown')} and VS Code ${escapeHtml(versions.vscode?.version ?? 'unknown')} · ${new Date().toISOString().slice(0, 10)}</p><p>Each chart reports median, p95 and sample count. <a href="raw/index.json">Download raw trials, screenshots and traces</a>.</p>${charts}${cards}${failuresHtml}<details><summary>Measurement boundaries and coverage</summary><p>Opening starts at a trusted renderer keydown for Ctrl+Space. Live filtering starts at the trusted character keydown while the suggestion list is open, and measures the refreshed, query-highlighted row through two animation frames. Both end at a visible suggestion; samples include editor/provider scheduling and list rendering. Filtering is not isolated fuzzy-search CPU time. Providers are warmed by one discarded completion request in the same fresh editor process. Each repetition uses a new application profile, and the operating-system file cache is retained.</p><p>Paint events and CSS style recalculation (${`UpdateLayoutTree`} / RecalculateStyles) are summed between renderer trace markers from opening keydown through the filtering endpoint in a separate tracing pass. Capture-tail events after the endpoint are excluded, crossing durations are clipped, and incomplete rendering events within the interval fail the sample. Event counts are reported beside duration totals. Tracing adds overhead, so traced passes do not contribute to latency charts. GPU rasterization, compositing and physical display latency are outside these measurements. Missing trace events fail the sample rather than becoming zero.</p><p>HTML completion uses the built-in HTML provider. TypeScript uses LVCE language-features-typescript ${escapeHtml(versions.lvce?.typescriptProvider ?? 'pinned release')} and VS Code's bundled provider. Exact editor/provider versions and binary checksums are retained in each raw results.json. Zed is omitted because this harness requires Chromium CDP and no validated Zed instrumentation is available. Atom 1.60.0 was attempted but its legacy Electron GPU process failed before validated measurements could be collected.</p><p>Hosted runner load, provider behavior and result ordering affect comparisons; small differences are not reliable rankings.</p></details><details><summary>Raw evidence files</summary><ul>${rawLinks}</ul></details><footer>Source: <a href="https://github.com/lvce-editor/completion-benchmark">lvce-editor/completion-benchmark</a></footer></main></body></html>`
await writeFile(join(output, 'index.html'), html)
await writeFile(join(output, 'raw/index.json'), `${JSON.stringify(rawIndex.sort(), null, 2)}\n`)
console.log(`Generated ${join(output, 'index.html')} from ${files.length} input artifacts (${trials.length} trials; ${failures.length} failures)`)
if (failures.length) process.exitCode = 1
