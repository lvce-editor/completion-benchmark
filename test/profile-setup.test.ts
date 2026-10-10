import assert from 'node:assert/strict'
import test from 'node:test'
import { ProfileSetupTargetExited, withFreshProfileSetup } from '../src/profile-setup.ts'

test('discards verified pre-interaction target exit and measures only a fresh capture', async () => {
  const captures: number[] = []
  let interactions = 0
  let disposed = false
  const value = await withFreshProfileSetup(async (attempt) => {
    captures.push(attempt)
    if (attempt === 1) {
      try { throw new ProfileSetupTargetExited('worker destroyed before interaction') }
      finally { disposed = true }
    }
    assert.equal(disposed, true)
    interactions++
    return { targets: ['page', 'live-worker'], totalMs: 3 }
  })
  assert.deepEqual(captures, [1, 2])
  assert.equal(interactions, 1)
  assert.deepEqual(value, { targets: ['page', 'live-worker'], totalMs: 3 })
})

test('does not retry interaction, live-session errors or repeated setup exits', async () => {
  for (const error of [new Error('interaction failure'), new Error('live worker missing session'), new ProfileSetupTargetExited('target destroyed')]) {
    let captures = 0
    await assert.rejects(withFreshProfileSetup(async () => { captures++; throw error }), (caught) => caught === error)
    assert.equal(captures, error instanceof ProfileSetupTargetExited ? 2 : 1)
  }
})
