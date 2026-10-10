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
