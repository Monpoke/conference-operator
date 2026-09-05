import { useToast } from '@conference-operator/components'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ActionResult } from '../lib/gateway.js'
import { useGatewayStore } from './gateway.js'

export type { ActionResult }

/** What can be asked of an action, beyond posting it. */
export interface ActOptions {
  /**
   * Do not announce success.
   *
   * For gestures whose effect **is** the answer: dismissing a notice makes it
   * disappear, and a "Fait" reappearing a second later — in the same place on
   * screen, since the stack and the toasts share the bottom — reads as a new
   * notice. One would have closed something in order to open another.
   *
   * Failure, on the other hand, always speaks: it has no visible effect to say
   * it in its place.
   */
  silent?: boolean
  /**
   * Announce this in place of the last notice carrying the same key.
   *
   * For a gesture one repeats: the last word is the only one worth reading, and
   * the earlier ones stand between the operator and the room. Failures are
   * keyed too — a switch that fails three times is one refusal restated, not
   * three incidents.
   */
  key?: string
}

/**
 * Switching the shot: the gesture one repeats.
 *
 * Locally the machine that serves the page is the machine that drives OBS: the
 * answer comes back in milliseconds and the button repaints itself. "Scène :
 * LIVE" therefore says nothing the operator is not already looking at, and
 * hunting for a shot during a talk left four green rectangles stacked at the
 * bottom of the screen, in a dark room. It stays quiet.
 *
 * From a phone the round trip costs seconds, and the notice is the only sign
 * the gesture was heard: it speaks, but keyed — a second switch takes the first
 * one's place rather than piling on it.
 *
 * A failure always speaks, near or far: it has no visible effect to say it in
 * its place.
 */
const SCENE = 'scene.set'

/**
 * The control commands, and the rule that governs them all.
 *
 * **No action writes into the room's state.** Pressing "LIVE" posts the command
 * and stops there: it is the stream's delta that will repaint the button, once
 * OBS has really switched. Painting ahead would give an active button describing
 * what was asked rather than what is — the difference is invisible while
 * everything works, and it matters on exactly the day the switch fails.
 *
 * The price is one round trip of latency on every gesture. In the room it is
 * measured in milliseconds: the machine serves the page and drives OBS from the
 * same box. From a phone it is measured in seconds — hence the uplink queue's
 * wake-up on the room side, without which a button would spend ten seconds
 * describing the previous state and get pressed a second time.
 */
export const useActionsStore = defineStore('actions', () => {
  const toast = useToast()
  const gateway = useGatewayStore()

  /** Commands in flight, per action. Used to disarm a button for the gesture's duration. */
  const pending = ref(0)

  async function act(
    gesture: Record<string, unknown>,
    options: ActOptions = {},
  ): Promise<ActionResult> {
    pending.value += 1
    try {
      /*
       * The transport lives in the gateway; here we keep only what is seen.
       *
       * Both gateways return the same shape and never fail by exception: a
       * failure comes back to the operator as a message, not as a broken page in
       * the middle of an intervention.
       */
      const result = await gateway.act(gesture)
      const message = result.message ?? (result.ok ? 'Fait' : 'Échec')
      const scene = gesture.action === SCENE
      const notice = { key: options.key ?? (scene ? SCENE : undefined) }
      const quiet = options.silent === true || (scene && !gateway.remote)
      if (!result.ok) toast.fail(message, notice)
      else if (!quiet) toast.say(message, notice)
      return result
    } finally {
      pending.value -= 1
    }
  }

  return { pending, act }
})
