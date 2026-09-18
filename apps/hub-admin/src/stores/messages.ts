import type { Banner } from '@conference-operator/contract'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * What the hub says to the rooms, and what they say back.
 *
 * Three resources sit in one store because they share a single piece of state:
 * the room the operator is aiming at. Splitting them would mean either
 * duplicating that selection or lifting it into a fourth store that owns
 * nothing else.
 */
export interface RoomMessage {
  id: string
  roomId: string
  roomName?: string | null
  text: string
  level: string
  receivedAt: string
}

export interface BannerPass {
  message: Banner
  roomId: string | null
  issuedAt: string
  visible: boolean
}

export interface Room {
  id: string
  name: string
}

/** How many messages the list keeps — the same for the poll and the stream. */
const RECEIVED_LIMIT = 40

/** The pause before reopening a stream that dropped. */
export const RETRY_MS = 5_000

export const useMessagesStore = defineStore('messages', () => {
  const rooms = ref<Room[]>([])
  const received = ref<RoomMessage[]>([])
  const banners = ref<BannerPass[]>([])

  /** `null` means every room — the hub's own convention for `roomId`. */
  const target = ref<string>('')

  /**
   * Whether the received list is pushed right now.
   *
   * Shown next to the list: a console that silently fell back to the
   * ten-second poll would look live while a call for help waits.
   */
  const live = ref(false)

  const session = useSessionStore()

  function targetRoom(): string | null {
    return target.value === '' ? null : target.value
  }

  async function load(): Promise<void> {
    const [list, fromRooms, history] = await Promise.all([
      session.client.rpc.rooms.list(),
      session.client.rpc.messages.fromRooms({ limit: RECEIVED_LIMIT }),
      session.client.rpc.overlay.history({ roomId: targetRoom(), limit: 20 }),
    ])
    rooms.value = list as Room[]
    received.value = fromRooms as RoomMessage[]
    banners.value = history as BannerPass[]
  }

  let following: AbortController | null = null

  /**
   * Follows the rooms' messages as the hub pushes them, until `unfollow`.
   *
   * Reopened after a pause when it drops — a hub restart, a proxy cutting an
   * idle connection. The page's poll keeps the list roughly current meanwhile.
   */
  async function follow(): Promise<void> {
    if (following != null) return
    const abort = new AbortController()
    following = abort

    while (!abort.signal.aborted) {
      try {
        const stream = await session.client.rpc.messages.watch(
          { limit: RECEIVED_LIMIT },
          { signal: abort.signal },
        )
        for await (const list of stream) {
          live.value = true
          received.value = list as RoomMessage[]
        }
      } catch {
        // Already reported by the client's error hook, unless we closed it.
      }
      live.value = false
      if (abort.signal.aborted) return
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
    }
  }

  function unfollow(): void {
    following?.abort()
    following = null
    live.value = false
  }

  async function send(input: {
    text: string
    level: 'info' | 'warning' | 'urgent'
    audience: 'operator' | 'audience'
    minutes: number | null
  }): Promise<void> {
    await session.client.rpc.messages.send({
      roomId: targetRoom(),
      text: input.text,
      level: input.level,
      target: input.audience,
      /*
       * Minutes in, seconds out.
       *
       * The field is in minutes because that is the unit somebody types under
       * pressure; the contract counts seconds. An empty field means "until
       * something replaces it", which is `null` and not zero.
       */
      ttlSeconds: input.minutes != null && input.minutes > 0 ? Math.round(input.minutes * 60) : null,
    })
  }

  async function showBanner(message: Banner): Promise<void> {
    await session.client.rpc.overlay.show({ roomId: targetRoom(), message, ttlSeconds: null })
    await load()
  }

  async function hideBanner(): Promise<void> {
    await session.client.rpc.overlay.hide({ roomId: targetRoom() })
    await load()
  }

  return {
    rooms,
    received,
    banners,
    target,
    live,
    targetRoom,
    load,
    follow,
    unfollow,
    send,
    showBanner,
    hideBanner,
  }
})
