import { describe, expect, it, vi } from 'vitest'
import {
  PairingError,
  runPairing,
  type PairingTransport,
} from '../src/core/pairing.js'

const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'

/** Transport scripté : chaque appel consomme la réponse suivante de la liste. */
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
      if (next == null) throw new Error('transport à court de réponses scriptées')
      return next
    },
  }
}

/** Horloge simulée : le test n'attend jamais réellement. */
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

describe('appairage de la machine', () => {
  it('rend le jeton dès que l\'opérateur a approuvé', async () => {
    const clock = fakeClock()
    const transport = scriptedTransport([
      { ok: false, error: 'authorization_pending' },
      { ok: true, body: { access_token: 'jeton-machine', token_type: 'Bearer' } },
    ])

    const onCode = vi.fn()
    const result = await runPairing(transport, CLIENT_ID, { ...clock, onCode })

    expect(result.accessToken).toBe('jeton-machine')
    // Le code part à l'écran immédiatement, avant tout sondage.
    expect(onCode).toHaveBeenCalledWith(expect.objectContaining({ user_code: 'ABCD-1234' }))
  })

  it('attend avant le premier sondage', async () => {
    const clock = fakeClock()
    const transport = scriptedTransport([{ ok: true, body: { access_token: 'x' } }])
    await runPairing(transport, CLIENT_ID, clock)

    // Sonder immédiatement ne peut que renvoyer `authorization_pending` :
    // le hub vient d'émettre le code, personne n'a pu l'approuver.
    expect(clock.waits[0]).toBe(5_000)
  })

  it('respecte l\'intervalle imposé par le hub', async () => {
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

  it('ralentit de 5 s sur `slow_down` (RFC 8628 §3.5)', async () => {
    const clock = fakeClock()
    const transport = scriptedTransport([
      { ok: false, error: 'slow_down' },
      { ok: false, error: 'slow_down' },
      { ok: true, body: { access_token: 'x' } },
    ])
    await runPairing(transport, CLIENT_ID, clock)

    // Insister à la même cadence maintiendrait la machine bloquée : chaque
    // `slow_down` doit ajouter 5 s, pas être ignoré.
    expect(clock.waits).toEqual([5_000, 10_000, 15_000])
  })

  it('abandonne sur refus de l\'opérateur', async () => {
    const clock = fakeClock()
    const transport = scriptedTransport([{ ok: false, error: 'access_denied' }])
    await expect(runPairing(transport, CLIENT_ID, clock)).rejects.toThrow(PairingError)
    await expect(
      runPairing(scriptedTransport([{ ok: false, error: 'access_denied' }]), CLIENT_ID, fakeClock()),
    ).rejects.toMatchObject({ code: 'access_denied' })
  })

  it('abandonne quand le code a expiré côté hub', async () => {
    const clock = fakeClock()
    const transport = scriptedTransport([{ ok: false, error: 'expired_token' }])
    await expect(runPairing(transport, CLIENT_ID, clock)).rejects.toMatchObject({
      code: 'expired_token',
    })
  })

  it('n\'insiste pas indéfiniment après `expires_in`', async () => {
    const clock = fakeClock()
    const transport = scriptedTransport(
      Array.from({ length: 20 }, () => ({ ok: false as const, error: 'authorization_pending' })),
      { interval: 5, expires_in: 12 },
    )
    await expect(runPairing(transport, CLIENT_ID, clock)).rejects.toMatchObject({
      code: 'expired_token',
    })
    // 5 s, 10 s, puis 15 s dépasse la validité : on arrête au lieu de marteler
    // le hub avec un code mort.
    expect(transport.calls).toBe(2)
  })

  it('tient l\'opérateur informé de l\'attente', async () => {
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
