import type { DisplayPayload } from '@conference-operator/contract'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { StateStream } from '../lib/gateway.js'
import { useClockStore } from './clock.js'
import { useGatewayStore } from './gateway.js'

export type { StateStream }

/**
 * Past this, an outage stops being a reconnection and becomes a dead screen.
 *
 * Taken over as-is from the original page: `EventSource` reconnects on its own
 * and raises nothing, so a room machine restarted under an open window leaves
 * that window apparently alive — the clock ticks, the countdown descends — and
 * in fact frozen, on the state from before the cut. The grace period avoids
 * crying out on every one-second reconnection, which nobody needs to see.
 *
 * Holds for both gateways. Remotely it is the poll that fails: a phone losing
 * the network must say so as loudly as a control app whose machine restarted.
 */
export const STREAM_DEAD_MS = 4000

/**
 * The room's state, and the stream that keeps it up to date.
 *
 * A single writer, and that is the point: **no control action writes here**.
 * Pressing "LIVE" posts the action and waits for the delta; the page does not
 * paint ahead. That is what guarantees an active button on screen describes OBS
 * and not what OBS was asked to do — the distinction matters on the day the
 * switch fails and nobody notices.
 *
 * Where the state comes from is `gateway`'s business: the room machine's SSE
 * stream, or the hub's polling. This store does not know, and neither do the
 * panels.
 */
export const useRoomStore = defineStore('room', () => {
  const payload = ref<DisplayPayload | null>(null)

  /**
   * Since when the stream has been cut, or `null` if it holds.
   *
   * Distinct from the connectivity shown beside it, which says whether the
   * **room** reaches the hub. This one says whether the **page** reaches its
   * source — two different failures, and the second was mute until it was named.
   */
  const cutSince = ref<number | null>(null)

  const clock = useClockStore()
  const gateway = useGatewayStore()

  /** The room's time, the hub's offset included. */
  const now = computed(() => clock.real + (payload.value?.state.serverTimeOffsetMs ?? 0))

  /**
   * Measured on the beat, on both sides, and deliberately so.
   *
   * The instant of the cut and the comparison both read the same one-second
   * clock: the gap is therefore exact to within one beat, and the error always
   * falls on the same side — the warning appears between four and five seconds
   * after the cut, never before four. A "frozen screen" shown too early on a
   * one-second reconnection costs more than one shown a second too late.
   */
  const dead = computed(
    () => cutSince.value != null && clock.real - cutSince.value > STREAM_DEAD_MS,
  )

  /** The state embedded in the shell, laid down before the stream's first byte. */
  function seed(initial: DisplayPayload | null): void {
    if (initial != null) payload.value = initial
  }

  function connect(openStream?: (url: string) => StateStream): void {
    if (openStream != null) gateway.configure({ openStream })
    gateway.open(
      {
        onPayload: (received, complete) => {
          if (complete) {
            payload.value = received as DisplayPayload
            return
          }
          /*
           * A delta on its own describes a room whose rest is unknown.
           *
           * Painting it half-way would be worse than waiting for the snapshot,
           * which follows every reconnection anyway.
           */
          if (payload.value == null) return
          payload.value = { ...payload.value, ...(received as Partial<DisplayPayload>) }
        },
        onOutage: (cut) => {
          if (cut) cutSince.value ??= clock.real
          else cutSince.value = null
        },
      },
    )
  }

  function disconnect(): void {
    gateway.close()
  }

  /**
   * Starts over on another room.
   *
   * The previous one's state must leave with it: keeping the `payload` for the
   * duration of the first poll would show, for a second, the title, the countdown
   * and the recording state of the room just left — on the page of the one being
   * opened.
   */
  function forget(): void {
    payload.value = null
    cutSince.value = null
  }

  return { payload, cutSince, now, dead, seed, connect, disconnect, forget }
})
