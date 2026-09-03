import { describe, expect, it, vi } from 'vitest'
import {
  PairingError,
  runPairing,
  type PairingTransport,
} from '../src/core/pairing.js'

const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'

/** Scripted transport: each call consumes the next response in the list. */
function scriptedTransport(
  responses: ({ ok: true; body: unknown } | { ok: false; error: string })[],
  code: Record<string, unknown> = {},
): PairingTransport & { calls: number } {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    requestCode: async () => ({
      device_code: 'dev-code',
      user_code: 'ABCD-1234',
      interval: 5,
      expires_in: 1800,
      ...code,
    }),
    requestToken: async () => {
      const next = responses[calls]
      calls += 1
      if (next == null) throw new Error('transport out of scripted responses')
      return next
    },
  }
}

/** Simulated clock: the test never actually waits. */
function fakeClock() {
  let currentMs = 0
  const waits: number[] = []
  return {
    waits,
    now: () => currentMs,
    sleep: async (ms: number) => {
      waits.push(ms)
      currentMs += ms
    },
  }
}

describe('pairing the machine', () => {
  it('returns the token as soon as the operator has approved', async () => {
    const clock = fakeClock()
    const transport = scriptedTransport([
      { ok: false, error: 'authorization_pending' },
      { ok: true, body: { access_token: 'machine-token', token_type: 'Bearer' } },
    ])

    const onCode = vi.fn()
    const result = await runPairing(transport, CLIENT_ID, { ...clock, onCode })

    expect(result.accessToken).toBe('machine-token')
    // The code goes to the screen immediately, before any polling.
    expect(onCode).toHaveBeenCalledWith(expect.objectContaining({ user_code: 'ABCD-1234' }))
  })

  it('waits before the first poll', async () => {
    const clock = fakeClock()
    const transport = scriptedTransport([{ ok: true, body: { access_token: 'x' } }])
    await runPairing(transport, CLIENT_ID, clock)

    // Polling straight away can only return `authorization_pending`: the hub has
    // just issued the code, nobody could have approved it.
    expect(clock.waits[0]).toBe(5_000)
  })

  it('honours the interval imposed by the hub', async () => {
    const clock = fakeClock()
    const transport = scriptedTransport(
      [
        { ok: false, error: 'authorization_pending' },
        { ok: false, error: 'authorization_pending' },
        { ok: true, body: { access_token: 'x' } },
      ],
      { interval: 3 },
    )
    await runPairing(transport, CLIENT_ID, clock)
    expect(clock.waits).toEqual([3_000, 3_000, 3_000])
  })

  it('slows down by 5 s on `slow_down` (RFC 8628 §3.5)', async () => {
    const clock = fakeClock()
    const transport = scriptedTransport([
      { ok: false, error: 'slow_down' },
      { ok: false, error: 'slow_down' },
      { ok: true, body: { access_token: 'x' } },
    ])
    await runPairing(transport, CLIENT_ID, clock)

    // Insisting at the same cadence would keep the machine stuck: each
    // `slow_down` must add 5 s, not be ignored.
    expect(clock.waits).toEqual([5_000, 10_000, 15_000])
  })

  it('gives up when the operator refuses', async () => {
    const clock = fakeClock()
    const transport = scriptedTransport([{ ok: false, error: 'access_denied' }])
    await expect(runPairing(transport, CLIENT_ID, clock)).rejects.toThrow(PairingError)
    await expect(
      runPairing(scriptedTransport([{ ok: false, error: 'access_denied' }]), CLIENT_ID, fakeClock()),
    ).rejects.toMatchObject({ code: 'access_denied' })
  })

  it('gives up when the code has expired on the hub side', async () => {
    const clock = fakeClock()
    const transport = scriptedTransport([{ ok: false, error: 'expired_token' }])
    await expect(runPairing(transport, CLIENT_ID, clock)).rejects.toMatchObject({
      code: 'expired_token',
    })
  })

  it('does not insist forever past `expires_in`', async () => {
    const clock = fakeClock()
    const transport = scriptedTransport(
      Array.from({ length: 20 }, () => ({ ok: false as const, error: 'authorization_pending' })),
      { interval: 5, expires_in: 12 },
    )
    await expect(runPairing(transport, CLIENT_ID, clock)).rejects.toMatchObject({
      code: 'expired_token',
    })
    // 5 s, 10 s, then 15 s goes past the validity: we stop rather than hammer the
    // hub with a dead code.
    expect(transport.calls).toBe(2)
  })

  it('keeps the operator informed of the wait', async () => {
    const clock = fakeClock()
    const onPending = vi.fn()
    const transport = scriptedTransport([
      { ok: false, error: 'authorization_pending' },
      { ok: true, body: { access_token: 'x' } },
    ])
    await runPairing(transport, CLIENT_ID, { ...clock, onPending })
    expect(onPending).toHaveBeenCalledTimes(2)
    expect(onPending).toHaveBeenNthCalledWith(1, { attempt: 1, nextDelayMs: 5_000 })
  })
})
