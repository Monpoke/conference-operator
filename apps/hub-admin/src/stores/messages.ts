import type { Banner } from '@conference-operator/contract'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * What the hub says to the rooms.
 *
 * The messages and the banners sit in one store because they share a single
 * piece of state: the room the operator is aiming at. Splitting them would mean
 * either duplicating that selection or lifting it into a third store that owns
 * nothing else.
 */
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

/** A room screen's message, as the room reported it. See `screenMessageEntrySchema`. */
export interface ScreenMessage {
  roomId: string
  roomName: string | null
  action: 'shown' | 'cleared'
  text: string | null
  level: 'info' | 'warning' | 'urgent' | null
  source: 'regie' | 'hub' | null
  expiresAt: string | null
  occurredAt: string
}

export interface UrgentProof {
  method: 'password' | 'sso'
  fresh: boolean
}

export const useMessagesStore = defineStore('messages', () => {
  const rooms = ref<Room[]>([])
  const banners = ref<BannerPass[]>([])
  /** What each room's screen says right now, and the recent reports. */
  const onScreens = ref<ScreenMessage[]>([])
  const screenLog = ref<ScreenMessage[]>([])

  /** `null` means every room — the hub's own convention for `roomId`. */
  const target = ref<string>('')

  const session = useSessionStore()

  function targetRoom(): string | null {
    return target.value === '' ? null : target.value
  }

  async function load(): Promise<void> {
    const [list, history] = await Promise.all([
      session.client.rpc.rooms.list(),
      session.client.rpc.overlay.history({ roomId: targetRoom(), limit: 20 }),
    ])
    rooms.value = list as Room[]
    banners.value = history as BannerPass[]
  }

  async function send(input: {
    text: string
    level: 'info' | 'warning' | 'urgent'
    audience: 'operator' | 'audience'
    minutes: number | null
    /** An urgent message's proof, when the account has a password. */
    password?: string
  }): Promise<void> {
    await session.client.rpc.messages.send({
      ...(input.password != null ? { password: input.password } : {}),
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

  async function showBanner(message: Banner, password?: string): Promise<void> {
    await session.client.rpc.overlay.show({
      roomId: targetRoom(),
      message,
      ttlSeconds: null,
      ...(password != null ? { password } : {}),
    })
    await load()
  }

  /** How the signed-in operator confirms an urgent message. */
  async function urgentProof(): Promise<UrgentProof> {
    return (await session.client.rpc.messages.urgentProof()) as UrgentProof
  }

  /**
   * The room screens' messages — the control apps' as well as the console's.
   *
   * Polled by the view: the rooms report them through their outbox, a few
   * seconds after the fact, and nothing is pushed to the console for them.
   */
  async function loadScreens(): Promise<void> {
    const result = (await session.client.rpc.messages.screens({ limit: 30 })) as {
      current: ScreenMessage[]
      log: ScreenMessage[]
    }
    onScreens.value = result.current
    screenLog.value = result.log
  }

  async function hideBanner(): Promise<void> {
    await session.client.rpc.overlay.hide({ roomId: targetRoom() })
    await load()
  }

  return {
    rooms,
    banners,
    onScreens,
    screenLog,
    loadScreens,
    urgentProof,
    target,
    targetRoom,
    load,
    send,
    showBanner,
    hideBanner,
  }
})
