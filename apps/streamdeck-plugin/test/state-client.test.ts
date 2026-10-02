import { describe, expect, it, vi } from 'vitest'
import type { DisplayPayload } from '@conference-operator/contract/room-display'
import { StateClient } from '../src/core/state-client.js'

/** A response streaming these SSE chunks, then hanging until aborted. */
function stream(chunks: string[], signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      signal.addEventListener('abort', () => controller.error(new Error('aborted')))
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

describe('the state stream, in the plugin', () => {
  it('takes the snapshot, then lays the patches over it', async () => {
    const seen: (DisplayPayload | null)[] = []
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
      stream(
        [
          'data: {"state":{"recording":false,"sceneRole":"HOLD"},"roomName":"Track 1"}\n\n',
          ': ping\n\n',
          // Split across two chunks, as a socket may well deliver it.
          'event: patch\ndata: {"set":{},"merge":',
          '{"state":{"recording":true}}}\n\n',
        ],
        init!.signal!,
      ),
    )
    const client = new StateClient({ base: () => 'http://room', onState: (p) => seen.push(p), fetch: fetcher as never })
    client.start()
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    client.stop()

    expect(fetcher.mock.calls[0]![0]).toBe('http://room/display/state?vue=regie&partiel=1')
    expect(seen[0]?.state).toMatchObject({ recording: false })
    // The patch merges into `state`: the scene the snapshot gave is kept.
    expect(seen[1]?.state).toMatchObject({ recording: true, sceneRole: 'HOLD' })
    expect(seen[1]?.roomName).toBe('Track 1')
  })

  it('says the room is unreachable, then tries again', async () => {
    const seen: (DisplayPayload | null)[] = []
    let calls = 0
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1
      if (calls === 1) return stream(['data: {"state":{"recording":false}}\n\n'], init!.signal!)
      throw new Error('ECONNREFUSED')
    })
    const client = new StateClient({ base: () => 'http://room', onState: (p) => seen.push(p), fetch: fetcher as never, retryMs: 5 })
    client.start()
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    // The machine goes away: the stream is cut.
    client.restart()
    await vi.waitFor(() => expect(seen.at(-1)).toBeNull())
    await vi.waitFor(() => expect(calls).toBeGreaterThan(2))
    client.stop()
    // Offline once, not once per failed retry.
    expect(seen.filter((entry) => entry === null)).toHaveLength(1)
  })
})
