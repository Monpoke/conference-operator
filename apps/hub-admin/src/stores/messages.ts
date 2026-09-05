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

export const useMessagesStore = defineStore('messages', () => {
  const rooms = ref<Room[]>([])
  const received = ref<RoomMessage[]>([])
  const banners = ref<BannerPass[]>([])

  /** `null` means every room — the hub's own convention for `roomId`. */
  const target = ref<string>('')

  const session = useSessionStore()

  function targetRoom(): string | null {
    return target.value === '' ? null : target.value
  }

  async function load(): Promise<void> {
    const [list, fromRooms, history] = await Promise.all([
      session.client.rpc.rooms.list(),
      session.client.rpc.messages.fromRooms({ limit: 40 }),
      session.client.rpc.overlay.history({ roomId: targetRoom(), limit: 20 }),
    ])
    rooms.value = list as Room[]
    received.value = fromRooms as RoomMessage[]
    banners.value = history as BannerPass[]
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

  return { rooms, received, banners, target, targetRoom, load, send, showBanner, hideBanner }
})
