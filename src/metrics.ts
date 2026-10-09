export interface TraceEvent { name?: string; ph?: string; pid?: number; tid?: number; ts?: number; dur?: number; args?: { data?: Record<string, unknown> } }

export interface TraceSummary {
  paintCount: number
  paintDurationMs: number
  styleRecalculationCount: number
  styleRecalculationDurationMs: number
}

export function summarizeTrace(events: TraceEvent[]): TraceSummary {
  const paints = events.filter((event) => event.name === 'Paint')
  const styles = events.filter((event) => event.name === 'UpdateLayoutTree' || event.name === 'RecalculateStyles')
  if (paints.length === 0) throw new Error('Rendering trace has no Paint events')
  if (styles.length === 0) throw new Error('Rendering trace has no style recalculation events')
  const duration = (event: TraceEvent): number => {
    if (typeof event.dur !== 'number' || !Number.isFinite(event.dur) || event.dur < 0) throw new Error(`Invalid duration for ${event.name ?? 'trace event'}`)
    return event.dur / 1000
  }
  return {
    paintCount: paints.length,
    paintDurationMs: paints.reduce((sum, event) => sum + duration(event), 0),
    styleRecalculationCount: styles.length,
    styleRecalculationDurationMs: styles.reduce((sum, event) => sum + duration(event), 0),
  }
}

// Chromium can flush a begin-only event for work still running when Tracing.end
// cuts the capture. Scope metrics to renderer markers, excluding later work while
// retaining strict validation for every rendering event within the interaction.
export function summarizeInteractionTrace(events: TraceEvent[]): TraceSummary {
  const marker = (label: string) => events.filter((event) => event.name === 'TimeStamp' && event.args?.data?.message === label)
  const starts = marker('completion-benchmark:start')
  const ends = marker('completion-benchmark:end')
  if (starts.length !== 1 || ends.length !== 1) throw new Error('Trace must contain exactly one interaction start and end marker')
  const start = starts[0]!.ts
  const end = ends[0]!.ts
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Invalid trace interaction boundaries')
  const measured = events.filter((event) => ['Paint', 'UpdateLayoutTree', 'RecalculateStyles'].includes(event.name ?? '')).flatMap((event) => {
    if (typeof event.ts !== 'number' || !Number.isFinite(event.ts)) throw new Error(`Missing trace timestamp for ${event.name}`)
    if (event.ts >= end) return []
    if (typeof event.dur !== 'number' || !Number.isFinite(event.dur) || event.dur < 0) throw new Error(`Incomplete rendering event within interaction: ${event.name}`)
    const stop = Math.min(end, event.ts + event.dur)
    if (stop < start) return []
    return [{ ...event, dur: stop - Math.max(start, event.ts) }]
  })
  return summarizeTrace(measured)
}

export function quantile(values: number[], fraction: number): number {
  if (values.length === 0) throw new Error('Cannot summarize an empty sample')
  if (fraction < 0 || fraction > 1) throw new Error(`Invalid quantile: ${fraction}`)
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.ceil(fraction * sorted.length) - 1
  return sorted[Math.max(0, index)]!
}
