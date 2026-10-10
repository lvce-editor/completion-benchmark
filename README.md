# LVCE Editor completion benchmark

This repository measures completion opening, incremental filtering, browser paint work, CSS style recalculation and estimated JavaScript execution time in the official LVCE Editor and VS Code desktop applications. It runs HTML and TypeScript fixtures in fresh, isolated profiles. Results from successful runs on `main` are published through GitHub Pages.

## Run locally

Linux x64, Node 24.15+, npm, `dpkg-deb`, `tar`, an X server or Xvfb, and Electron's GTK/NSS/GBM/ALSA libraries are required. The CI workflow installs the system packages and uses Xvfb. Setup downloads the pinned editor binaries and TypeScript provider (about 450 MB total) and checks every archive against its SHA-256 digest.

```sh
npm ci
npm run setup
xvfb-run -a npm run benchmark -- --repeats 5
npm run report
# Serve site/ with any static HTTP server.
```

Use `--editor lvce|vscode`, `--language html|typescript`, `--repeats 1`, and `--output results/<name>` for a focused run. `.tmp/` holds downloaded applications and fixtures; `results/` holds JSON, screenshots, launch logs and Chromium trace events. `site/raw/` retains the evidence linked from the report.

## Measurements

The HTML fixture triggers tag completions after `<` and filters with `h`; the TypeScript fixture triggers the `Array`-prefixed globals after `Arr` and filters with `a`. Each fresh application process requires a successful discarded warmup request before measurement. If a provider has not registered when the first request arrives, readiness requests are retried within a 30-second startup deadline; the number of discarded requests is recorded. Timed interactions are never retried. VS Code also uses a fresh extensions directory, retaining only its bundled providers. Each trial uses a new editor profile with isolated XDG configuration, data, cache and state paths. The OS file cache is retained. Setup records SHA-256 digests of both committed fixture files.

Opening latency starts at the trusted renderer `keydown` for Ctrl+Space and ends when the expected item is visible and remains present through two animation frames. For live filtering, the harness types one more prefix character while the suggestion list is open and measures until the matching row displays the updated query through two animation frames. The character-to-updated-result interval includes provider/UI work and cannot end on unchanged stale highlights. Timing is observed entirely in the renderer, avoiding controller polling delay. Missing rows, stale highlights, timeouts and editor startup failures are failed samples; they never become zero. Filtering is not an isolated fuzzy-search CPU measurement.

The report uses the official LVCE Editor v0.121.19 package, its bundled HTML provider, the pinned TypeScript language-features v5.25.3 release, and VS Code 1.141.0 with its bundled HTML and TypeScript providers. LVCE completions on typing are enabled so its TypeScript list can refresh during live filtering. VS Code quick suggestions are disabled; its open suggestion list still filters on typing. Setup checks provider identities and versions and records them with every result. The HTML and TypeScript files are deterministic, small fixtures; they do not represent all project sizes or completion workloads.

Paint and CSS measurements use a separate Chromium tracing pass. Renderer timestamp markers bound the interval from the opening Ctrl+Space keydown through the query-qualified filtering endpoint; events after that interval are excluded, and completed durations crossing a boundary are clipped. Incomplete rendering events within the interval fail the sample. This prevents unrelated work interrupted by capture shutdown from corrupting the measurement. Paint duration and event count come from Chromium `Paint` events. CSS style-recalculation duration and event count sum `UpdateLayoutTree` and `RecalculateStyles` events. Tracing adds overhead, so these runs are kept out of latency charts. The Linux runs disable GPU acceleration; GPU rasterization, compositing and physical display latency are excluded. Missing paint or style evidence fails the traced sample rather than reporting a synthetic zero.

JavaScript estimates use another isolated profiling launch. V8's CPU profiler samples at 1 ms while completion opening and query-qualified filtering run. Frontend totals include each unique renderer and web-worker isolate. Backend totals include Electron's main process and every discovered live Electron utility or forked descendant process; raw profiles identify each by PID, command-line arguments and script path, including `tsserver.js` launched by the extension host. An instrumentation bootstrap preserves utility entry arguments and installs a recursive preload for their Node forks; a Linux descendant inventory rejects uninstrumented Node backend processes, and VS Code TypeScript samples require tsserver coverage. Before VS Code profiling, startup readiness waits for its observed perfBaseline worker to terminate; the observer starts at the first browser connection and retains its evidence. If a frontend target is confirmed destroyed during profiler setup before the completion interaction, the entire setup capture is discarded and restarted once with a fresh complete inventory. Both attempts retain lifecycle evidence; an exit during the interaction or a second setup failure fails the sample. Timed completion interactions are never retried. Frontend membership is checked at the target inventory acknowledgement immediately after the interaction endpoint and before profiler teardown, including transient targets observed during capture. Targets created after that inventory during teardown lie outside the recorded capture boundary. Sequential profiler start/stop introduces sampling tails around this endpoint. A missing child-process inspector, an uncovered backend process, an absent LVCE worker isolate or changed renderer/worker/process membership fails the sample. Each result records frontend, backend and total JavaScript milliseconds; total equals frontend plus backend. Active JavaScript samples contribute to those totals; idle and VM/garbage-collection samples are kept separately in raw summaries. Raw `.cpuprofile` files are published alongside results. Inspector instrumentation and profiling add overhead, and short operations may be undersampled, so these are estimates rather than latency measurements or exact CPU accounting.

The report separates HTML and TypeScript into distinct sections. Each section compares opening and live filtering latency, paint duration/count, CSS style recalculation duration/count, and frontend/backend/total JavaScript time, with median, p95 and sample count. Each chart states which editors have validated samples and which have no validated measurements. Raw trial JSON records every interaction, profiler coverage and pinned version; screenshots, Chromium trace events and V8 CPU profiles provide evidence. Hosted runner load, language providers and editor behavior affect comparisons, so small differences are not reliable rankings.

The [completion filtering investigation](docs/completion-filtering-latency.md) records the measured bottleneck, official-package before/after results and remaining gap to VS Code.

## Editor coverage

LVCE Editor and VS Code have validated desktop adapters and run for HTML and TypeScript. Atom, Zed and Eclipse Theia have no validated samples, and each chart labels this coverage. A checksum-verified Atom 1.60.0 Linux desktop launch was attempted in an isolated Xvfb profile, but its legacy Electron runtime terminated with `GPU process is not usable`, before measurements could be validated. Zed 1.18.1 uses a native renderer; the Chromium CDP harness cannot collect equivalent paint or CSS metrics, and no trusted-key-to-visible-completion-list adapter was validated. Eclipse Theia 1.75.0 launched with a Monaco workbench, but the bounded fixture probe closed the renderer before provider responses or query-qualified suggestions could be validated. These are feasibility outcomes, not zero-valued measurements.

## CI and publication

Pull requests run type checking, lint, focused measurement tests and one real desktop run for each editor/language pair, including CPU-profile capture and backend/frontend coverage validation. Main runs five repetitions for each pair, combines the JSON, trace and CPU-profile artifacts, creates the static report, and deploys it to GitHub Pages only after all four desktop jobs succeed.

## References

The launch isolation, trusted-key timing and Chromium tracing approach follows [lvce-quickpick-benchmark](https://github.com/levivilet/lvce-quickpick-benchmark). [lvce-typing-benchmark](https://github.com/lvce-editor/lvce-typing-benchmark) and [typescript-benchmark](https://github.com/lvce-editor/typescript-benchmark) were also inspected as benchmark references.
