import { describe, expect, it } from 'vitest'
import { RoomChanges } from '../src/services/changes.js'

const TRACK_1 = 'track-1-teilhard-de-chardin'
const TRACK_2 = 'track-2-colbert'

/**
 * Waits for the next wake-up, without losing it if it arrives late.
 *
 * The pending `next()` is kept between calls: a wake-up that lands just after a
 * "quiet" verdict is still there for the following one.
 */
function listen(iterator: AsyncIterator<void>) {
  let pending: Promise<IteratorResult<void>> | null = null
  return async (ms: number): Promise<'woke' | 'quiet' | 'done'> => {
    pending ??= iterator.next()
    const settled = await Promise.race([
      pending,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ])
    if (settled == null) return 'quiet'
    pending = null
    return settled.done === true ? 'done' : 'woke'
  }
}

describe('RoomChanges', () => {
  it('wakes once for a burst, not once per touch', async () => {
    const changes = new RoomChanges(10)
    const next = listen(changes.watch(TRACK_1))

    changes.touch(TRACK_1)
    changes.touch(TRACK_1)
    changes.touch(TRACK_1)

    expect(await next(200)).toBe('woke')
    // The three touches were one change: a second read would repeat the first.
    expect(await next(60)).toBe('quiet')
  })

  it('counts a touch made before the first read', async () => {
    /*
     * The watcher reads the view right after subscribing. A change landing between
     * the two must still wake it — otherwise the phone keeps a view from before
     * until the ten-second floor.
     */
    const changes = new RoomChanges(10)
    const iterator = changes.watch(TRACK_1)
    changes.touch(TRACK_1)

    expect(await listen(iterator)(200)).toBe('woke')
  })

  it('ignores the other rooms, but not a change concerning all of them', async () => {
    const changes = new RoomChanges(10)
    const next = listen(changes.watch(TRACK_1))

    changes.touch(TRACK_2)
    expect(await next(60)).toBe('quiet')

    changes.touch(null)
    expect(await next(200)).toBe('woke')
  })

  it('ends when the watcher leaves', async () => {
    const changes = new RoomChanges(10)
    const abort = new AbortController()
    const next = listen(changes.watch(TRACK_1, abort.signal))

    const waiting = next(500)
    abort.abort()
    expect(await waiting).toBe('done')
  })

  it('wakes the message watchers on a message, not on a room change', async () => {
    // Every heartbeat touches its room: the console must not re-read on each.
    const changes = new RoomChanges(10)
    const next = listen(changes.watchMessages())

    changes.touch(TRACK_1)
    changes.touch(null)
    expect(await next(60)).toBe('quiet')

    changes.messageArrived()
    expect(await next(200)).toBe('woke')
  })
})
