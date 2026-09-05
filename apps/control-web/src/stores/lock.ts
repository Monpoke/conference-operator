import type { ControlLock, ControlRoom } from '@conference-operator/contract'
import { useToast } from '@conference-operator/components'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useGatewayStore } from './gateway.js'
import { useRoomStore } from './room.js'
import { thisTabSession, useSessionStore } from './session.js'

/**
 * Who holds the room, and how one takes it.
 *
 * A single mobile control app drives a room at a time. **The room's own control
 * app is never restrained**: the operator who is physically there must not
 * depend on a phone gone off down a corridor, nor on a lock somebody forgot to
 * release. The lock only excludes mobiles from one another.
 *
 * The heartbeat does not live here: it travels in the state poll (`regie.view`),
 * which renews its holder's grip. A second timer would be a second thing to
 * remember to stop, and a lock that outlives the page that held it.
 */
export const useLockStore = defineStore('lock', () => {
  const gateway = useGatewayStore()
  const room = useRoomStore()
  const session = useSessionStore()
  const toast = useToast()

  /** The rooms and their lock, for the choice screen. */
  const rooms = ref<ControlRoom[]>([])
  const loading = ref(false)

  /**
   * The open room's lock, as the last poll saw it.
   *
   * Read from the view rather than kept here: a single source, and one already
   * refreshed every second. A second copy would end up saying something other
   * than the one displayed beside it.
   */
  const lock = computed<ControlLock | null>(() => lockView())

  const holder = computed(() => lock.value?.holder ?? null)

  /**
   * Does this tab hold the room?
   *
   * On the **session**, not on the address. The same person opens the control app
   * on their phone and then on a tablet: comparing accounts would make both
   * believe they are driving, and two contradictory scene switches would leave
   * with no screen saying so.
   */
  const iHold = computed(() => lock.value?.holderId === thisTabSession())

  /**
   * The room is held, but not here. This is what lifts the veil.
   *
   * Distinct from "nobody holds it": that one is taken with a single gesture,
   * this one requires dispossessing somebody — even oneself, on another device.
   */
  const heldElsewhere = computed(() => lock.value != null && !iHold.value)

  /**
   * An open room this tab does not hold. This is what lifts the veil.
   *
   * Three situations behind it, and the veil names them separately: nobody holds
   * it — the case of a lock expired while the phone slept —, another of your own
   * tabs, or somebody else. All three call for the same gesture, but not for the
   * same sentence.
   */
  const blocked = computed(() => gateway.roomId != null && !iHold.value)

  /** Nobody holds it: it can be taken without dispossessing anyone. */
  const unheld = computed(() => blocked.value && lock.value == null)

  /**
   * The holder is me — elsewhere.
   *
   * This happens more often than one would think: the control app is opened on
   * the phone, then on the tablet at the control desk. Saying so changes the
   * veil's wording: "regie@… tient la salle" against one's own account reads as a
   * failure, when the answer is "it is you, in another tab".
   */
  const myOtherSession = computed(
    () => heldElsewhere.value && holder.value === session.identity,
  )

  /**
   * The lock, taken where it is freshest.
   *
   * **From the poll** when a room is open: it arrives every second, and that is
   * what is needed — a room taken over while one drives it must be visible at
   * once, not at the next listing. From the list otherwise, which is the choice
   * screen's only source.
   */
  function lockView(): ControlLock | null {
    if (gateway.roomId != null) return gateway.currentLock
    const room = rooms.value.find((row) => row.roomId === gateway.roomId)
    return room?.lock ?? null
  }

  async function load(): Promise<void> {
    if (!gateway.remote) return
    loading.value = true
    try {
      rooms.value = await session.client.rpc.regie.locks()
    } catch {
      /*
       * Silent: the list reloads on the next round.
       *
       * The choice screen keeps what it was showing — room names, which do not
       * move all day. A list emptied on every network hiccup would suggest a hub
       * with no program.
       */
    } finally {
      loading.value = false
    }
  }

  /**
   * Takes the room. `force` dispossesses the current holder.
   *
   * Without `force`, a refusal names who holds the room: "refused" without saying
   * by whom sends people looking for a fault where there is only a colleague at
   * the other end of the building.
   */
  async function take(roomId: string, force = false): Promise<boolean> {
    try {
      /*
       * The response **is** the lock: we set it without waiting for the poll.
       *
       * Without this, the second following a take passes with no known lock, and
       * the veil flashes over the very room one has just obtained.
       */
      gateway.currentLock = await session.client.rpc.regie.hold({ roomId, force })
      await load()
      return true
    } catch (cause) {
      toast.fail((cause as Error).message || 'Salle déjà tenue')
      return false
    }
  }

  /** Releases the room. No effect if it was not held — the hub checks. */
  async function release(roomId: string): Promise<void> {
    try {
      await session.client.rpc.regie.release({ roomId })
      await load()
    } catch {
      // Releasing is a gesture one does not retry: expiry will take care of it
      // within thirty seconds anyway.
    }
  }

  /**
   * Opens a room: takes the lock, then switches the screen.
   *
   * The take **before** the opening, and not the other way round: opening first
   * would show, for a second, buttons one has no right to use — and that is the
   * second in which one presses them.
   */
  async function open(roomId: string, force = false): Promise<void> {
    if (!(await take(roomId, force))) return
    room.forget()
    gateway.choose(roomId)
  }

  /**
   * Opens a room **without taking it**.
   *
   * The normal path from the choice screen: one enters, one looks, and it is the
   * veil that carries the decision to take — once, in the same place, whether one
   * arrives at a free room, one held by a colleague or one held by one's own
   * phone. Asking before entering forced a decision on the strength of a list
   * row, without seeing what is happening in the room.
   */
  function watch(roomId: string): void {
    room.forget()
    gateway.choose(roomId)
  }

  /** Returns to the choice screen, releasing the room. */
  async function leave(): Promise<void> {
    const current = gateway.roomId
    if (current != null && iHold.value) await release(current)
    room.forget()
    gateway.choose(null)
    await load()
  }

  /**
   * Releases the room when the page goes away.
   *
   * `pagehide` rather than `beforeunload`: it is the only event mobile browsers
   * emit reliably when a tab is closed or when one switches application.
   * `keepalive` makes the request leave even during teardown.
   *
   * It is only a courtesy shortcut: expiry covers every case where it does not
   * leave — flat battery, tunnel, application killed.
   */
  function releaseOnLeave(): () => void {
    const onLeave = (): void => {
      const room_ = gateway.roomId
      if (room_ == null || !iHold.value) return
      void session.client.rpc.regie.release({ roomId: room_ }).catch(() => {})
    }
    globalThis.addEventListener('pagehide', onLeave)
    return () => globalThis.removeEventListener('pagehide', onLeave)
  }

  return {
    rooms,
    loading,
    lock,
    holder,
    iHold,
    heldElsewhere,
    myOtherSession,
    blocked,
    unheld,
    load,
    take,
    release,
    open,
    watch,
    leave,
    releaseOnLeave,
  }
})
