<script setup lang="ts">
import type { DisplayPayload } from '@conference-operator/contract'
import { Button } from '@conference-operator/components'
import { computed } from 'vue'
import { useActionsStore } from '../stores/actions.js'

/**
 * A state, and certainly not a modal.
 *
 * Nothing it covers is usable: an unpaired machine has no room, no program and no
 * OBS to drive. A modal closes — on Escape, on a click beside it — and would leave
 * a complete control app on screen, every button of which would fail without
 * saying why. The veil takes the screen for as long as the condition lasts, and
 * disappears when it ends. It has no close button because there is nothing behind
 * it.
 *
 * It lays down no keyboard layer either: it is the page that removes its own while
 * the veil is there. The shortcuts act on a talk and an OBS this machine does not
 * know yet.
 */
const TITLES: Record<string, string> = {
  idle: 'Appairage de la salle',
  waiting: 'Appairage de la salle',
  // A refused token is not a first start-up: saying so avoids believing in a new
  // machine when it has in fact been revoked, or the hub's database recreated.
  expired: 'Cette machine doit être réappairée',
  failed: 'Appairage impossible',
}

const props = defineProps<{ pairing: DisplayPayload['pairing'] }>()

const actions = useActionsStore()

const rooms = computed(() => props.pairing?.rooms ?? [])

const requested = computed(
  () => rooms.value.find((room) => room.id === props.pairing?.requestedRoomId) ?? null,
)

/**
 * A room is being chosen while none is chosen — and not while no code is shown.
 *
 * The distinction cost dearly. A code lives two minutes; pairing one room and then
 * a second is enough to let the first die, and the supervision loop asks for
 * another within fifteen seconds. During that gap there is no code, and the screen
 * went back to asking which room this machine serves — a question already settled,
 * whose answer still travels in `requestedRoomId`. One clicked the room again,
 * which restarted the pairing and gave the impression the click had fixed it.
 */
const choosing = computed(() => props.pairing?.requestedRoomId == null)

/**
 * Room chosen, no code yet: a new one is coming.
 *
 * The only state the screen did not name. Without it, a pairing that repairs
 * itself looks like a broken pairing.
 */
const waiting = computed(() => !choosing.value && props.pairing?.userCode == null)

const title = computed(() => {
  if (choosing.value) return 'Quelle salle dessert ce poste ?'
  if (waiting.value) return 'Nouveau code en préparation'
  return TITLES[props.pairing?.status ?? ''] ?? 'Appairage de la salle'
})
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-canvas p-6" data-role="pairing">
    <div class="max-w-[620px] rounded-2xl border border-edge bg-surface px-10 py-[34px] text-center">
      <h1 class="mb-2 text-[22px] font-semibold">{{ title }}</h1>
      <p class="mb-6 text-[15px] leading-relaxed text-dim">
        {{
          choosing
            ? 'Ce choix accompagne la demande : la console le retrouvera pré-sélectionné.'
            : "Cette machine n'est pas encore liée à une salle."
        }}
      </p>

      <div v-if="choosing" class="mb-2 flex flex-col gap-3">
        <!--
          Hub unreachable: say so rather than show an empty list, which would read
          as an event with no rooms.
        -->
        <p v-if="rooms.length === 0" class="py-3.5 text-sm text-dim">
          Hub injoignable — la liste des salles apparaîtra dès qu'il répondra.
        </p>
        <Button
          v-for="room in rooms"
          :key="room.id"
          class="flex items-center justify-between px-5 py-4 text-left text-[17px]"
          :data-room="room.id"
          @click="actions.act({ action: 'pairing.chooseRoom', roomId: room.id })"
        >
          {{ room.name }}<span class="opacity-50">→</span>
        </Button>
      </div>

      <template v-else>
        <p v-if="requested != null" class="mb-3.5 text-sm text-dim">
          Salle demandée : <strong class="text-text">{{ requested.name }}</strong>
        </p>

        <!--
          The gap between two codes, named.

          The supervision loop asks for another every fifteen seconds: there is
          nothing to do, and above all nothing to click again. Saying so avoids
          repeating a gesture that never failed.
        -->
        <p
          v-if="waiting"
          class="mb-5 rounded-xl border border-edge bg-canvas px-[26px] py-5 text-[15px] leading-relaxed text-dim"
          data-role="pairing-waiting"
        >
          Le code précédent n’est plus valable. Un nouveau code apparaîtra ici
          dans quelques secondes — rien à faire.
        </p>

        <div
          v-else
          class="mb-5 rounded-xl border border-edge bg-canvas px-[26px] py-5 text-[52px] font-bold tracking-[.16em] tabular-nums select-all"
          data-role="pairing-code"
        >
          {{ pairing?.userCode ?? '········' }}
        </div>
        <p v-if="!waiting" class="text-sm leading-relaxed text-dim">
          Saisissez ce code dans la console du hub, onglet « Machines en attente », puis
          choisissez la salle desservie par ce poste.<br />
          <a
            v-if="pairing?.verificationUri != null"
            class="text-brand underline"
            :href="pairing.verificationUri"
            target="_blank"
            rel="noopener"
            >{{ pairing.verificationUri }}</a
          >
        </p>
      </template>

      <p v-if="pairing?.message != null" class="mt-[18px] text-sm text-alert">
        {{ pairing.message }}
      </p>
      <p class="mt-[22px] text-[13px] text-dim">Cet écran disparaît dès l'approbation.</p>
    </div>
  </div>
</template>
