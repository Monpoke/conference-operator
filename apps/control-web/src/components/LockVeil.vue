<script setup lang="ts">
import { Button } from '@cloudnord/components'
import { timeAgo } from '@cloudnord/format'
import { computed } from 'vue'
import { useGatewayStore } from '../stores/gateway.js'
import { useLockStore } from '../stores/lock.js'

/**
 * A state, and certainly not a button in a corner.
 *
 * Nothing it covers is usable: every command on the page would leave for the hub
 * only to be refused. A small "Reprendre" in a bar left a complete control app on
 * screen — the countdown, "Commencer", "Enregistrer" — all apparently active, all
 * doomed. One presses first and reads afterwards, and it is in the middle of a
 * talk that one discovers why nothing happened.
 *
 * The same reason as the pairing veil, and the same shape: it takes the screen for
 * as long as the condition lasts, disappears when it ends, and has no close button
 * — there is nothing behind it to let through.
 *
 * What it **does** let through is reading: the room's state stays visible
 * underneath, dimmed. Coming to look at a room a colleague is driving is a normal
 * use — it is even what somebody hesitating to take it over does.
 */
const gateway = useGatewayStore()
const lock = useLockStore()

/** Since when this holder has held the room. Recomputed on the page's tick. */
const props = defineProps<{ nowMs: number }>()

const since = computed(() =>
  lock.lock == null ? null : timeAgo(lock.lock.heldSince, props.nowMs),
)

const title = computed(() => {
  if (lock.unheld) return 'Cette salle n’est pas prise'
  return lock.myOtherSession
    ? 'Vous pilotez déjà cette salle ailleurs'
    : 'Cette salle est pilotée par quelqu’un d’autre'
})

/**
 * Two sentences, because these are not twice the same situation.
 *
 * One's own name shown as a third party's reads as a failure — one looks for the
 * second account, and it does not exist. Naming the other device closes the
 * question at once.
 */
const explanation = computed(() => {
  if (lock.unheld) {
    /*
     * The expired-lock case, and it has to be said without alarming anybody.
     *
     * Thirty seconds without news is enough: a phone locked in a pocket, a tunnel,
     * an application switch. Nothing is broken, the room is simply waiting to be
     * taken again.
     */
    return (
      'Personne ne la pilote à distance en ce moment — votre prise a expiré, ou ' +
      'vous ne l’aviez pas encore prise. Reprenez-la pour retrouver les commandes.'
    )
  }
  const when = since.value == null ? '' : ` depuis ${since.value}`
  return lock.myOtherSession
    ? `Un autre onglet ou appareil connecté avec votre compte tient la régie de cette salle${when}. ` +
        'Reprendre ici en retirera les commandes là-bas.'
    : `${lock.holder} tient la régie de cette salle${when}. ` +
        'Reprendre lui retirera les commandes, au milieu de ce qu’il est en train de faire.'
})

/** Taking a free room is not taking it back: the button does not lie. */
const action = computed(() => (lock.unheld ? 'Prendre le contrôle' : 'Reprendre le contrôle'))
</script>

<template>
  <div
    class="fixed inset-0 z-40 flex items-end justify-center bg-canvas/80 p-4 backdrop-blur-[2px] sm:items-center"
    data-role="lock-veil"
  >
    <div class="w-full max-w-[460px] rounded-2xl border border-edge bg-surface px-6 py-7 text-center">
      <h1 class="mb-2 text-lg font-semibold">{{ title }}</h1>
      <p class="mb-6 text-sm leading-relaxed text-dim" data-role="lock-veil-detail">
        {{ explanation }}
      </p>

      <div class="flex flex-col gap-2">
        <!--
          "Reprendre" first: it is the gesture one comes here for. It asks for no
          second confirmation — the veil *is* the question, and asking it again
          would turn it into a reflex click.
        -->
        <Button
          variant="primary"
          class="w-full py-3"
          data-role="lock-take"
          @click="gateway.roomId != null && lock.open(gateway.roomId, true)"
        >
          {{ action }}
        </Button>
        <Button class="w-full py-3" data-role="lock-leave" @click="lock.leave()">
          Choisir une autre salle
        </Button>
      </div>

      <p class="mt-5 text-xs leading-relaxed text-dim">
        La régie de la salle, elle, n’est pas concernée : l’opérateur qui s’y
        trouve garde toutes ses commandes.
      </p>
    </div>
  </div>
</template>
