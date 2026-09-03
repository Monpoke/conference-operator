import { describe, expect, it, vi } from 'vitest'
import { ConnectivityTracker, probeConnectivity } from '../src/core/connectivity.js'

const okFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch
const errorFetch = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
const deadFetch = vi.fn(async () => {
  throw new Error('ECONNREFUSED')
}) as unknown as typeof fetch

describe('connectivity diagnosis', () => {
  it('tells a reachable hub from a cut network', async () => {
    // A hub that answers but whose real time has gone down: it is not the same
    // failure as an unplugged cable, and the operator must be able to tell them
    // apart.
    expect(await probeConnectivity({ hubOrigin: 'http://hub', fetchImpl: okFetch })).toBe('DEGRADED')
    expect(await probeConnectivity({ hubOrigin: 'http://hub', fetchImpl: deadFetch })).toBe('OFFLINE')
  })

  it('treats a hub in error as unreachable', async () => {
    expect(await probeConnectivity({ hubOrigin: 'http://hub', fetchImpl: errorFetch })).toBe('OFFLINE')
  })

  it('only notifies state changes', async () => {
    const onChange = vi.fn()
    const tracker = new ConnectivityTracker({ hubOrigin: 'http://hub', fetchImpl: okFetch, onChange })

    tracker.markOnline()
    tracker.markOnline()
    await tracker.markRealtimeFailure()

    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['ONLINE', 'DEGRADED'])
    expect(tracker.value).toBe('DEGRADED')
  })

  it('does not launch several probes in parallel', async () => {
    const slow = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const tracker = new ConnectivityTracker({ hubOrigin: 'http://hub', fetchImpl: slow, onChange: () => {} })

    // Several failures close together must not hammer the hub with probes.
    await Promise.all([
      tracker.markRealtimeFailure(),
      tracker.markRealtimeFailure(),
      tracker.markRealtimeFailure(),
    ])
    expect(slow).toHaveBeenCalledTimes(1)
  })
})
