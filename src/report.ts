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
const chartDefinitions = [
  { title: 'Completion opening', key: 'openingMs', unit: 'ms', traced: false },
  { title: 'Live completion filtering', key: 'filteringMs', unit: 'ms', traced: false },
  { title: 'Paint duration', key: 'paintDurationMs', unit: 'ms', traced: true },
  { title: 'Paint count', key: 'paintCount', unit: 'events', traced: true },
  { title: 'CSS style recalculation duration', key: 'styleRecalculationDurationMs', unit: 'ms', traced: true },
  { title: 'CSS style recalculation count', key: 'styleRecalculationCount', unit: 'events', traced: true },
  { title: 'Frontend JavaScript execution time', key: 'frontendMs', unit: 'ms', traced: false, phase: 'profile' },
  { title: 'Backend JavaScript execution time', key: 'backendMs', unit: 'ms', traced: false, phase: 'profile' },
  { title: 'Total JavaScript execution time', key: 'totalMs', unit: 'ms', traced: false, phase: 'profile' },
]
const editorNames: Record<string, string> = { lvce: 'LVCE Editor', vscode: 'VS Code', theia: 'Eclipse Theia', atom: 'Atom', zed: 'Zed' }
const editorName = (editor: string) => editorNames[editor] ?? editor
const knownEditors = Object.keys(editorNames)
const languageSections = ['html', 'typescript'].map((language) => {
  const languageGroups = [...groups.entries()].filter(([key]) => key.endsWith(`/${language}`)).sort(([a], [b]) => a.localeCompare(b))
  const charts = chartDefinitions.map(({ title, key, unit, traced, phase }) => {
    const samplesByEditor = new Map(languageGroups.map(([group, samples]) => [group.split('/')[0], samples]))
    const editors = [...new Set([...knownEditors, ...samplesByEditor.keys()])]
    const bars = editors.map((editor) => {
      const samples = samplesByEditor.get(editor) ?? []
      const numbers = samples.filter((sample) => sample.status === 'passed' && (phase ? sample.phase === phase : traced ? Boolean(sample.render) : sample.phase === 'latency'))
        .map((sample) => phase ? sample.javascript?.[key] : traced ? sample.render[key] : sample[key])
        .filter((value: unknown): value is number => typeof value === 'number' && Number.isFinite(value))
      return { editor, numbers }
    })
    const maximum = Math.max(0, ...bars.flatMap(({ numbers }) => numbers.length ? [p95(numbers)] : []))
    const axisMax = maximum > 0 ? maximum * 1.1 : 1
    const width = 1000
    const height = 450
    const left = 90
    const right = 24
    const top = 48
    const bottom = 300
    const plotWidth = width - left - right
    const plotHeight = bottom - top
    const xStep = plotWidth / bars.length
    const yFor = (value: number) => bottom - value / axisMax * plotHeight
    const ticks = Array.from({ length: 5 }, (_, index) => {
      const value = axisMax * index / 4
      const y = yFor(value)
      return `<line class="grid" x1="${left}" y1="${y.toFixed(2)}" x2="${width - right}" y2="${y.toFixed(2)}"/><text class="tick" x="${left - 10}" y="${(y + 5).toFixed(2)}" text-anchor="end">${value.toFixed(2)} ${unit}</text>`
    }).join('')
    const markers = bars.map(({ editor, numbers }, index) => {
      const x = left + xStep * (index + 0.5)
      const name = escapeHtml(editorName(editor))
      if (!numbers.length) return `<text class="missing" x="${x.toFixed(2)}" y="${bottom - 12}" text-anchor="middle">no samples</text>`
      const medianValue = median(numbers)
      const p95Value = p95(numbers)
      const medianY = yFor(medianValue)
      const p95Y = yFor(p95Value)
      const labelY = Math.max(top + 14, p95Y - 12)
      return `<line class="stem" x1="${x.toFixed(2)}" y1="${bottom}" x2="${x.toFixed(2)}" y2="${medianY.toFixed(2)}"/><line class="p95-whisker" x1="${x.toFixed(2)}" y1="${p95Y.toFixed(2)}" x2="${x.toFixed(2)}" y2="${medianY.toFixed(2)}"/><line class="p95-cap" x1="${(x - 6).toFixed(2)}" y1="${p95Y.toFixed(2)}" x2="${(x + 6).toFixed(2)}" y2="${p95Y.toFixed(2)}"/><circle class="marker" cx="${x.toFixed(2)}" cy="${medianY.toFixed(2)}" r="5"><title>${name}: median ${medianValue.toFixed(2)} ${unit}; p95 ${p95Value.toFixed(2)} ${unit}; ${numbers.length} samples</title></circle><text class="value" x="${x.toFixed(2)}" y="${labelY.toFixed(2)}" text-anchor="middle">${medianValue.toFixed(2)} / ${p95Value.toFixed(2)} ${unit} (n=${numbers.length})</text>`
    }).join('')
    const categories = bars.map(({ editor }, index) => {
      const x = left + xStep * (index + 0.5)
      return `<text class="editor" transform="translate(${x.toFixed(2)} ${bottom + 12}) rotate(48)" text-anchor="start">${escapeHtml(editorName(editor))}</text>`
    }).join('')
    const covered = bars.filter(({ numbers }) => numbers.length).map(({ editor }) => editorName(editor))
    const uncovered = bars.filter(({ numbers }) => !numbers.length).map(({ editor }) => editorName(editor))
    return `<section><h3>${title}</h3><p class="muted">Blue markers show the median; stems reach zero and whiskers extend to p95. Labels show median / p95 and sample count. Coverage: ${escapeHtml(covered.join(', ') || 'none')}; no validated samples: ${escapeHtml(uncovered.join(', ') || 'none')}.</p><div class="chart-scroll"><svg class="chart" role="img" aria-label="${title} comparison for ${language}" viewBox="0 0 ${width} ${height}"><title>${title} by editor</title><text class="axis-label" x="${left}" y="${top - 16}">${title} (${unit})</text>${ticks}${markers}${categories}</svg></div></section>`
  }).join('')
  const cards = languageGroups.map(([group, samples]) => {
    const editor = group.split('/')[0]
    const latency = samples.filter((sample) => sample.status === 'passed' && !sample.render)
    const rendering = samples.filter((sample) => sample.status === 'passed' && sample.render).map((sample) => sample.render!)
    const profiles = samples.filter((sample) => sample.status === 'passed' && sample.phase === 'profile').map((sample) => sample.javascript).filter(Boolean)
    for (const profile of profiles) {
      if (!Array.isArray(profile.profiles) || !profile.profiles.length || !profile.profiles.some((entry: any) => entry.side === 'frontend') || !profile.profiles.some((entry: any) => entry.side === 'backend')) throw new Error(`Incomplete JavaScript process/isolate coverage for ${group}`)
      if (![profile.frontendMs, profile.backendMs, profile.totalMs].every((value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0) || Math.abs(profile.totalMs - profile.frontendMs - profile.backendMs) > 0.000001) throw new Error(`Invalid JavaScript totals for ${group}`)
      if (profile.profiles.some((entry: any) => !entry.identity || !entry.file || !Number.isFinite(entry.javascriptMs) || entry.javascriptMs < 0)) throw new Error(`Malformed JavaScript profile evidence for ${group}`)
    }
    const timing = (name: string, values: number[]) => values.length
      ? `<article><h4>${name}</h4><p class="number">${median(values).toFixed(2)} <small>ms median</small></p><p>p95 ${p95(values).toFixed(2)} ms · ${values.length} samples</p></article>`
      : `<article><h4>${name}</h4><p class="missing">No successful samples</p></article>`
    const renderCard = (name: string, ms: number[], count: number[]) => ms.length
      ? `<article><h4>${name}</h4><p class="number">${median(ms).toFixed(2)} <small>ms median</small></p><p>p95 ${p95(ms).toFixed(2)} ms · ${median(count).toFixed(0)} events median · ${ms.length} samples</p></article>`
      : `<article><h4>${name}</h4><p class="missing">No successful samples</p></article>`
    const javascriptCard = (name: string, key: 'frontendMs' | 'backendMs' | 'totalMs') => {
      const values = profiles.map((profile) => profile[key])
      return values.length ? `<article><h4>${name}</h4><p class="number">${median(values).toFixed(2)} <small>ms median</small></p><p>p95 ${p95(values).toFixed(2)} ms · ${values.length} samples</p></article>` : `<article><h4>${name}</h4><p class="missing">No successful samples</p></article>`
    }
    return `<section class="editor"><h3>${escapeHtml(editorName(editor))}</h3><div class="grid">${timing('Ctrl+Space to visible suggestions', latency.filter((sample) => sample.phase === 'latency').map((sample) => sample.openingMs).filter((value): value is number => typeof value === 'number'))}${timing('Character filtering to visible match', latency.filter((sample) => sample.phase === 'latency').map((sample) => sample.filteringMs).filter((value): value is number => typeof value === 'number'))}${renderCard('Paint', rendering.map((sample) => sample.paintDurationMs), rendering.map((sample) => sample.paintCount))}${renderCard('CSS style recalculation', rendering.map((sample) => sample.styleRecalculationDurationMs), rendering.map((sample) => sample.styleRecalculationCount))}</div><h4>Estimated JavaScript execution time</h4><div class="grid">${javascriptCard('Frontend · renderer and workers', 'frontendMs')}${javascriptCard('Backend · Electron main and child processes', 'backendMs')}${javascriptCard('Total JavaScript', 'totalMs')}</div></section>`
  }).join('')
  const heading = language === 'html' ? 'HTML completions' : 'TypeScript completions'
  return `<section class="language"><h2>${heading}</h2><p>Editor comparisons for completion opening, live filtering, paint and CSS style recalculation.</p>${charts}${cards}</section>`
}).join('')

const failuresHtml = failures.length ? `<section class="failures"><h2>${failures.length} failed trials</h2><p>Failed samples remain visible here and are never represented as zero.</p><ul>${failures.map((trial) => `<li>${trial.editor} · ${trial.language} · repetition ${trial.repeat + 1}: ${escapeHtml(trial.error ?? 'unknown failure')}</li>`).join('')}</ul></section>` : ''
function escapeHtml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') }
const provenance = records.map(({ data }) => data.metadata).filter(Boolean)
const versions: Record<string, { version?: string; [key: string]: unknown }> = provenance[0] ?? {}
const editorVersions = Object.entries(versions).filter(([id, value]) => editorNames[id] && typeof value.version === 'string')
const rawIndex: string[] = []
for (const { file } of records) {
  const directory = file.slice(0, -'results.json'.length)
  const group = relative(input, directory).split(/[\\/]/).filter(Boolean).join('-') || basename(directory)
  for (const name of await readdir(directory)) {
    if (!['.json', '.trace.json', '.png', '.log', '.cpuprofile'].includes(extname(name)) && !name.endsWith('.trace.json')) continue
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
:root{color-scheme:light dark;font:16px/1.55 system-ui,sans-serif}body{max-width:1120px;margin:40px auto;padding:0 24px;color:CanvasText;background:Canvas}h1{font-size:2.5rem;line-height:1.1}h2{margin:34px 0 12px}.muted,small{color:GrayText}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}article{border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:10px;padding:16px}.chart-scroll{overflow-x:auto;background:#fff;border:1px solid #d7e0e8;border-radius:.5rem;margin:1rem 0}.chart{display:block;width:100%;min-width:820px;height:auto}.chart .grid{stroke:#d7e0e8;stroke-width:1}.chart .tick,.chart .axis-label,.chart .editor,.chart .value,.chart .missing{font:12px system-ui,sans-serif;fill:#17212b}.chart .axis-label{font-size:13px;font-weight:600}.chart .stem{stroke:#4780ad;stroke-width:2}.chart .p95-whisker,.chart .p95-cap{stroke:#4780ad;stroke-width:1.5;stroke-dasharray:3 2}.chart .marker{fill:#0759a5;stroke:white;stroke-width:2}.chart .value{font-weight:600}.chart .missing{fill:#a04444}article h4{font-size:1rem;margin:0}.number{font-size:1.8rem;font-weight:650;margin:12px 0 0}.number small{font-size:.8rem;font-weight:400}.missing{color:#c66}section{margin:30px 0}.language{border-top:2px solid color-mix(in srgb,CanvasText 20%,transparent);padding-top:16px}.editor{border-top:1px solid color-mix(in srgb,CanvasText 15%,transparent);padding-top:8px}.failures{border-left:4px solid #c66;padding-left:16px}a{color:LinkText}summary{cursor:pointer;font-weight:650}code{overflow-wrap:anywhere}footer{margin:40px 0;color:GrayText}@media(max-width:600px){body{margin:20px auto;padding:0 14px}h1{font-size:2rem}}
</style></head><body><main><p class="muted">Reproducible desktop completion measurements · Linux x64 · ${trials.length} raw trials</p><h1>How quickly do code completions appear?</h1><p>Validated editors: ${editorVersions.map(([id, value]) => `${escapeHtml(editorName(id))} ${escapeHtml(value.version!)}`).join(' · ')} · ${new Date().toISOString().slice(0, 10)}</p><p>Each chart reports median, p95 and sample count. HTML and TypeScript have separate sections. <a href="raw/index.json">Download raw trials, screenshots, traces and CPU profiles</a>.</p>${languageSections}${failuresHtml}<details><summary>Measurement boundaries and coverage</summary><p>Opening starts at a trusted renderer keydown for Ctrl+Space. Live filtering starts at the trusted character keydown while the suggestion list is open, and measures the refreshed, query-highlighted row through two animation frames. Both end at a visible suggestion; samples include editor/provider scheduling and list rendering. Filtering is not isolated fuzzy-search CPU time. Providers must answer a discarded completion request in the same fresh editor process before measurement; startup readiness requests can be retried within 30 seconds and their count is recorded. Timed requests are never retried. Each repetition uses a new application profile, and the operating-system file cache is retained.</p><p>Paint events and CSS style recalculation (${`UpdateLayoutTree`} / RecalculateStyles) are summed between renderer trace markers from opening keydown through the filtering endpoint in a separate tracing pass. Capture-tail events after the endpoint are excluded, crossing durations are clipped, and incomplete rendering events within the interval fail the sample. Event counts are reported beside duration totals. Tracing adds overhead, so traced passes do not contribute to latency charts. GPU rasterization, compositing and physical display latency are outside these measurements. Missing trace events fail the sample rather than becoming zero.</p><p>JavaScript execution time is estimated from 1 ms V8 CPU sampling during a separate profiling launch. The capture starts immediately before the opening keydown and ends at the query-qualified filtering endpoint. Frontend totals sum unique renderer and worker isolates; backend totals include the Electron main process and every instrumented live Electron utility process, including tsserver when it is launched as a utility process. Raw results identify each process/isolate and link its .cpuprofile. Missing child-process inspector coverage or process/target membership changes fail a sample. Totals include active JavaScript samples; idle and VM/garbage-collection sample time is separately recorded in each raw trial. Profiling and main-process instrumentation add overhead, and 1 ms sampling can miss short work, so these are estimates rather than wall-clock latency or precise accounting.</p><p>HTML completion uses the built-in HTML provider. TypeScript uses LVCE language-features-typescript ${escapeHtml(String(versions.lvce?.typescriptProvider ?? 'pinned release'))} and each other editor's bundled provider unless raw provenance names a pinned package. Exact editor/provider versions and binary checksums are retained in each raw results.json. Atom 1.60.0 failed its prior isolated launch because its legacy Electron GPU process was unusable. Zed 1.18.1 uses native rendering; this report's paint and CSS metrics require Chromium CDP events, and no trusted-key-to-visible-completion-list adapter was validated. Eclipse Theia 1.75.0 launched with a Monaco workbench, but the bounded fixture probe closed the renderer before provider responses or query-qualified suggestions could be validated. These editors therefore have no validated samples in any chart.</p><p>Hosted runner load, provider behavior and result ordering affect comparisons; small differences are not reliable rankings.</p></details><details><summary>Raw evidence files</summary><ul>${rawLinks}</ul></details><footer>Source: <a href="https://github.com/lvce-editor/completion-benchmark">lvce-editor/completion-benchmark</a></footer></main></body></html>`
await writeFile(join(output, 'index.html'), html)
await writeFile(join(output, 'raw/index.json'), `${JSON.stringify(rawIndex.sort(), null, 2)}\n`)
console.log(`Generated ${join(output, 'index.html')} from ${files.length} input artifacts (${trials.length} trials; ${failures.length} failures)`)
if (failures.length) process.exitCode = 1
