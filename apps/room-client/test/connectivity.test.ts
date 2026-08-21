import { describe, expect, it, vi } from 'vitest'
import { ConnectivityTracker, probeConnectivity } from '../src/core/connectivity.js'

const okFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch
const errorFetch = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
const deadFetch = vi.fn(async () => {
  throw new Error('ECONNREFUSED')
}) as unknown as typeof fetch

describe('diagnostic de connectivité', () => {
  it('distingue un hub joignable d\'un réseau coupé', async () => {
    // Hub qui répond mais dont le temps réel est tombé : ce n'est pas la même
    // panne qu'un câble débranché, et l'opérateur doit pouvoir les distinguer.
    expect(await probeConnectivity({ hubOrigin: 'http://hub', fetchImpl: okFetch })).toBe('DEGRADED')
    expect(await probeConnectivity({ hubOrigin: 'http://hub', fetchImpl: deadFetch })).toBe('OFFLINE')
  })

  it('traite un hub en erreur comme injoignable', async () => {
    expect(await probeConnectivity({ hubOrigin: 'http://hub', fetchImpl: errorFetch })).toBe('OFFLINE')
  })

  it('ne notifie que les changements d\'état', async () => {
    const onChange = vi.fn()
    const tracker = new ConnectivityTracker({ hubOrigin: 'http://hub', fetchImpl: okFetch, onChange })

    tracker.markOnline()
    tracker.markOnline()
    await tracker.markRealtimeFailure()

    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['ONLINE', 'DEGRADED'])
    expect(tracker.value).toBe('DEGRADED')
  })

  it('ne lance pas plusieurs sondes en parallèle', async () => {
    const lent = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const tracker = new ConnectivityTracker({ hubOrigin: 'http://hub', fetchImpl: lent, onChange: () => {} })

    // Plusieurs échecs rapprochés ne doivent pas marteler le hub de sondes.
    await Promise.all([
      tracker.markRealtimeFailure(),
      tracker.markRealtimeFailure(),
      tracker.markRealtimeFailure(),
    ])
    expect(lent).toHaveBeenCalledTimes(1)
  })
})
