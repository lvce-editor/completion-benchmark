export interface TraceEvent { name?: string; ts?: number; dur?: number; args?: { data?: Record<string, unknown> } }

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

export function quantile(values: number[], fraction: number): number {
  if (values.length === 0) throw new Error('Cannot summarize an empty sample')
  if (fraction < 0 || fraction > 1) throw new Error(`Invalid quantile: ${fraction}`)
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.ceil(fraction * sorted.length) - 1
  return sorted[Math.max(0, index)]!
}
