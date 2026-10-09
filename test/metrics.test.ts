import assert from 'node:assert/strict'
import test from 'node:test'
import { quantile, summarizeTrace } from '../src/metrics.ts'

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
