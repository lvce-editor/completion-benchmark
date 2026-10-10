import assert from 'node:assert/strict'
import test from 'node:test'
import { quantile, summarizeCpuProfile, summarizeTrace, summarizeInteractionTrace } from '../src/metrics.ts'

test('summarizes Chromium paint and CSS recalculation count and duration', () => {
  assert.deepEqual(summarizeTrace([
    { name: 'Paint', dur: 1200 },
    { name: 'UpdateLayoutTree', dur: 700 },
    { name: 'Paint', dur: 800 },
    { name: 'RecalculateStyles', dur: 300 },
  ]), { paintCount: 2, paintDurationMs: 2, styleRecalculationCount: 2, styleRecalculationDurationMs: 1 })
})

test('missing trace evidence and invalid durations fail rather than appearing as zero', () => {
  assert.throws(() => summarizeTrace([]), /no Paint events/)
  assert.throws(() => summarizeTrace([{ name: 'Paint', dur: 1 }]), /no style recalculation/)
  assert.throws(() => summarizeTrace([{ name: 'Paint' }, { name: 'UpdateLayoutTree', dur: 1 }]), /Invalid duration/)
})

test('reports nearest-rank median and p95', () => {
  assert.equal(quantile([9, 1, 3, 7, 5], 0.5), 5)
  assert.equal(quantile([9, 1, 3, 7, 5], 0.95), 9)
  assert.throws(() => quantile([], 0.5), /empty sample/)
})

test('estimates active JavaScript samples separately from idle and VM time', () => {
  assert.deepEqual(summarizeCpuProfile({
    nodes: [
      { id: 1, callFrame: { functionName: 'render', url: 'app.js' } },
      { id: 2, callFrame: { functionName: '(idle)', url: '' } },
      { id: 3, callFrame: { functionName: '(garbage collector)', url: '' } },
    ],
    samples: [1, 2, 3, 1], timeDeltas: [1000, 2000, 3000, -20], startTime: 10, endTime: 6010,
  }), { javascriptMs: 1, idleMs: 2, vmMs: 3, samples: 3, discardedSamples: 1, durationMs: 6 })
})

test('rejects incomplete or malformed CPU profiles instead of reporting zero', () => {
  assert.throws(() => summarizeCpuProfile({ nodes: [], samples: [], timeDeltas: [], startTime: 1, endTime: 2 }), /Missing or inconsistent/)
  assert.throws(() => summarizeCpuProfile({ nodes: [{ id: 1, callFrame: { functionName: 'run', url: '' } }], samples: [2], timeDeltas: [1], startTime: 1, endTime: 2 }), /Invalid CPU sample/)
  assert.throws(() => summarizeCpuProfile({ nodes: [{ id: 1, callFrame: { functionName: 'run', url: '' } }], samples: [1, 1], timeDeltas: [1], startTime: 1, endTime: 2 }), /Missing or inconsistent/)
  assert.throws(() => summarizeCpuProfile({ nodes: [{ id: 1, callFrame: { functionName: 'run', url: '' } }], samples: [1], timeDeltas: [1], startTime: 2, endTime: 1 }), /boundaries/)
})

const marker = (message: string, ts: number) => ({ name: 'TimeStamp', ts, args: { data: { message } } })

test('interaction markers exclude incomplete capture-tail work but retain strict in-window evidence', () => {
  const events = [
    marker('completion-benchmark:start', 1000),
    { name: 'Paint', ph: 'X', ts: 1100, dur: 300 },
    { name: 'UpdateLayoutTree', ph: 'X', ts: 1400, dur: 700 },
    marker('completion-benchmark:end', 2000),
    { name: 'UpdateLayoutTree', ph: 'B', ts: 2200 },
  ]
  assert.deepEqual(summarizeInteractionTrace(events), { paintCount: 1, paintDurationMs: 0.3, styleRecalculationCount: 1, styleRecalculationDurationMs: 0.6 })
  assert.throws(() => summarizeInteractionTrace([...events, { name: 'Paint', ph: 'B', ts: 1500 }]), /Incomplete rendering event/)
  assert.throws(() => summarizeInteractionTrace(events.slice(1)), /exactly one/)
  assert.throws(() => summarizeInteractionTrace(events.filter((event) => event.name !== 'Paint')), /no Paint events/)
})
