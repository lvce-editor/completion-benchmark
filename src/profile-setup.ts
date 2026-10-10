// Only a verified target exit before the interaction permits a fresh capture.
export class ProfileSetupTargetExited extends Error {}

export async function withFreshProfileSetup<T>(capture: (attempt: number) => Promise<T>): Promise<T> {
  try {
    return await capture(1)
  } catch (error) {
    if (!(error instanceof ProfileSetupTargetExited)) throw error
    // The failed attempt must dispose all sessions before this callback returns.
    // A second failure is surfaced; interaction errors never use this error type.
    return capture(2)
  }
}

interface TargetChange { kind: 'created' | 'destroyed'; targetId: string; observedAt: number }

// Capture ends at the endpoint inventory acknowledgement, before profiler teardown.
// Reject even transient targets whose creation/destruction was observed in-window.
export function assertProfileTargetMembership(before: string[], after: string[], changes: TargetChange[], captureStart: number, captureEnd: number): void {
  const changedInsideCapture = changes.some((change) => change.observedAt >= captureStart && change.observedAt <= captureEnd)
  if (changedInsideCapture || [...new Set(before)].sort().join() !== [...new Set(after)].sort().join()) throw new Error('Profiler target membership changed during capture or lacks endpoint lifecycle evidence')
}
