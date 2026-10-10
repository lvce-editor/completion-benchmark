# Completion filtering latency

Continued typing reuses the stored unfiltered completion list and makes zero completion-provider requests. Providers run when opening/loading the list. The combined editor-context RPC took about 0.80 ms and fuzzy filtering 1.09 ms in a diagnostic HTML trace; synchronous gutter decoration refresh took 28.73 ms. Renderer batch spacing from RPC completion could then miss the next animation frame. Combining the two context reads alone did not establish a meaningful latency improvement.

[Editor-worker #1621](https://github.com/lvce-editor/editor-worker/pull/1621) defers and coalesces gutter provider work outside the editing queue, rejects stale snapshots and suppresses unchanged-decoration renders. [App #15864](https://github.com/lvce-editor/lvce-editor/pull/15864) integrates that worker and spaces serialized renderer batch starts 16 ms apart. [Completion-worker #463](https://github.com/lvce-editor/completion-worker/pull/463) covers continued typing, empty results, backspace, reopen and acceptance.

## Official-package comparison

Same-host Linux x64 measurements use the unchanged HTML `<` → `h` and TypeScript `Arr` → `a` fixtures, pinned TypeScript provider 5.25.3, isolated XDG/user profiles, and a successful discarded warmup. The endpoint is the trusted filtering keydown to the matching row with updated query highlights through two animation frames. Separate traced runs measure paint/style and do not contribute to latency.

| Editor | HTML median / p95 (ms) | TypeScript median / p95 (ms) |
| --- | --- | --- |
| LVCE v0.121.18 control | 77.65 / 95.09 | 77.43 / 79.09 |
| LVCE v0.121.19 candidate | 61.75 / 68.98 | 61.66 / 75.03 |
| VS Code 1.141.0 | 46.60 / 61.00 | 43.50 / 49.20 |

All five latency and five rendering samples per editor/language passed. LVCE filtering medians improved approximately 20.5% in HTML and 20.4% in TypeScript, with lower observed p95 in both. LVCE is still slower than VS Code in this comparison; the fastest-editor aspiration is not achieved.

Each group has only five latency samples, so nearest-rank p95 is its largest sample. Shared-host load and animation-frame alignment affect results; these figures establish this measured comparison, not a universal ranking or precise population-tail estimate. The stage trace is diagnostic evidence, separate from the unmodified official-package latency measurements.

[Saved metadata and latency trials](completion-filtering-latency.json) include editor/package digests, fixture digests, provider versions and matching highlighted-row observations. Run `npm run setup`, then `xvfb-run -a npm run benchmark -- --editor lvce --repeats 5 --output results/lvce` and the equivalent command with `--editor vscode`. `npm run report` builds the comparison and links its raw screenshots/traces. To reproduce the control, use the v0.121.18 Debian asset and SHA-256 recorded in the saved metadata. Keep each LVCE version in separate report input directories; the report groups by editor/language, so mixing versions would aggregate distinct builds.

## Interaction acceptance

An isolated test provider using the packaged extension runtime exercised the unmodified official app. The [acceptance record](completion-filtering-acceptance.json) identifies its exact package checksum. The official v0.121.19 package passed continued typing with fresh highlights, no-match removal of items/highlights, backspace restoration, dismiss/reopen, keyboard selection and Enter acceptance. Unicode labels filter correctly with an ASCII prefix (`caf` → `café`) and accept without losing the accented character.

The existing word parser treats a typed `é` as a word boundary: both official v0.121.18 and v0.121.19 clear the prior highlights and show the list for an empty word. Backspacing restores the `caf` highlights. This optimization preserves that existing behavior; it does not add full non-ASCII word-token filtering. An additional assertion expecting a highlighted full `café` prefix failed identically on control and candidate and is retained in the local investigation evidence.
