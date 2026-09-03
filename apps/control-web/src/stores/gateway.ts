import { controlPath, controlRoomIdFromPath, type ControlLock } from '@cloudnord/contract'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { BootScope } from '../boot.js'
import {
  remoteGateway,
  localGateway,
  type ActionResult,
  type StateSink,
  type ControlGateway,
} from '../lib/gateway.js'
import { useSessionStore } from './session.js'

/**
 * The transport, and nothing but.
 *
 * This store owns the gateway: it knows where the state comes from and where the
 * gestures go. `room` and `actions` go through it without ever knowing which of
 * the two gateways is open, which is the whole reason the panels are reused
 * as they are.
 *
 * It imports neither `room` nor `actions` — the dependency runs one way only,
 * and that is what avoids the cycle a store "that pushes into another" would
 * have created.
 */
export const useGatewayStore = defineStore('gateway', () => {
  // `portee` and `salles` are the boot contract's own names: not renamed.
  const boot = ref<BootScope>({
    portee: 'locale',
    roomId: null,
    salles: [],
    google: null,
  })

  /**
   * The room being driven. Comes from the boot payload, then from the address.
   *
   * `shallowRef` for the gateway, as for the client: it carries a timer and a
   * stream, not data.
   */
  const roomId = ref<string | null>(null)
  const gateway = shallowRef<ControlGateway | null>(null)

  /**
   * The open room's lock, refreshed on every poll.
   *
   * Taken from the view and not from the room list: the latter only reloads on
   * the choice screen, so a room taken over while one drives it would have been
   * visible nowhere. This is the field that must react within the second — it is
   * what lifts the veil.
   */
  const currentLock = shallowRef<ControlLock | null>(null)
  let sink: StateSink | null = null
  /** The last opening's substitutions, replayed on every room change. */
  let opening: Opening = {}

  const remote = computed(() => boot.value.portee === 'distante')
  /** The choice screen: remotely, as long as no room is named. */
  const roomChoice = computed(() => remote.value && roomId.value == null)

  function start(value: BootScope): void {
    boot.value = value
    roomId.value = value.roomId
    if (value.portee === 'distante') useSessionStore().start(value)
  }

  /**
   * What can be substituted into the gateway, and why.
   *
   * `openStream` for the local gateway: happy-dom supplies an `EventSource`, but
   * a real stream does not break on request — and the only behaviour that counts
   * is precisely what happens when it does break.
   *
   * `now` and `wait` for the remote gateway: the confirmation by observation is
   * bounded by a guard delay, and exercising it in real time would make the test
   * suite sleep five seconds to check a rule that fits in three lines.
   */
  interface Opening {
    openStream?: Parameters<typeof localGateway>[0]
    now?: () => number
    wait?: (ms: number) => Promise<void>
  }

  /** Builds the current scope's gateway, without opening it. */
  function build(options: Opening): ControlGateway | null {
    if (!remote.value) return localGateway(options.openStream)
    const room = roomId.value
    // Nothing to drive with no room: the choice screen commands nobody.
    if (room == null) return null
    return remoteGateway({
      client: useSessionStore().client,
      roomId: room,
      onView: (view) => {
        currentLock.value = view.lock
      },
      now: options.now,
      wait: options.wait,
    })
  }

  /**
   * Remembers how to build the gateway, without opening it.
   *
   * Separate from `open` because the gestures do not wait for the stream: a
   * gateway is also built on the first button pressed, and it must then use the
   * same substitutions. Without that separation, a gesture made before the
   * opening fell back on the default values.
   */
  function configure(options: Opening): void {
    opening = options
  }

  /** Opens the transport and keeps it open. */
  function open(subscription: StateSink, options: Opening = opening): void {
    sink = subscription
    opening = options
    if (gateway.value != null) return

    gateway.value = build(options)
    gateway.value?.start(subscription)
  }

  function close(): void {
    gateway.value?.stop()
    gateway.value = null
  }

  /**
   * Changes room without reloading the page.
   *
   * The address follows, because **every screen is an address**: the refreshed
   * page reopens the room one was driving, the link can be bookmarked, and the
   * Back button returns to the choice rather than leaving. Two states do not
   * justify a router — `pushState` and `popstate` are enough, and `vue-router`
   * does not go into a bundle a room machine also serves.
   */
  function choose(room: string | null, push = true): void {
    if (room === roomId.value) return
    close()
    // The lock of the room being left says nothing about the one being opened:
    // keeping it would flash a veil for the duration of the first poll.
    currentLock.value = null
    roomId.value = room
    if (push) globalThis.history.pushState({}, '', controlPath(room))
    if (sink != null) open(sink, opening)
  }

  /** Follows the browser's Back button. Returned so it can be removed on unmount. */
  function followHistory(): () => void {
    const onBack = (): void => choose(controlRoomIdFromPath(globalThis.location.pathname), false)
    globalThis.addEventListener('popstate', onBack)
    return () => globalThis.removeEventListener('popstate', onBack)
  }

  async function act(gesture: Record<string, unknown>): Promise<ActionResult> {
    /*
     * The gateway opens on the first gesture if the stream has not opened it.
     *
     * A gesture made before the stream is plugged in must leave all the same:
     * tying it to the stream's opening would make the commands depend on an
     * `EventSource`, which has nothing to do with them. Remotely, `build`
     * returns `null` while no room is open, and the refusal below says so.
     */
    if (gateway.value == null) gateway.value = build(opening)

    const active = gateway.value
    if (active == null) {
      /*
       * Remotely, with no room open: said rather than attempted.
       *
       * The choice screen's case, where nothing is being driven. A gesture that
       * left for `/control/action` from a phone would collect a 404 from the hub,
       * and nobody could say why.
       */
      return { ok: false, message: "Aucune salle n'est ouverte" }
    }
    return active.act(gesture)
  }

  return {
    boot,
    roomId,
    currentLock,
    remote,
    roomChoice,
    start,
    configure,
    open,
    close,
    choose,
    followHistory,
    act,
  }
})
