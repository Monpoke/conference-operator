import { useToast } from '@cloudnord/components'
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
}

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
      if (!result.ok) toast.fail(message)
      else if (options.silent !== true) toast.say(message)
      return result
    } finally {
      pending.value -= 1
    }
  }

  return { pending, act }
})
