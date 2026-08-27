<script setup lang="ts">
import { DUREE_SIGNALEMENT_MS, type DisplayPayload } from '@cloudnord/contract'
import { time } from '@cloudnord/format'
import { computed, ref } from 'vue'
import { useActionsStore } from '../stores/actions.js'

/**
 * Ce qui vient de se passer à côté.
 *
 * Ces encarts apparaissent trente secondes en bas d'un écran qu'on ne regarde
 * pas — pendant un talk, l'opérateur regarde la salle. D'où un fond **plein**,
 * et pas une teinte sourde comme le reste de la page : ce qui doit se voir du
 * coin de l'œil se voit à la couleur, pas au texte. Le texte passe en sombre,
 * la seule paire qui reste lisible sur de l'ambre.
 *
 * Trente secondes, parce qu'un bandeau qui ne part pas cesse d'être lu : la
 * régie finissait la journée avec cinq signalements empilés au-dessus des
 * commandes, tous périmés depuis longtemps. Ce qui doit rester consultable —
 * l'état des autres salles — est de toute façon dans le flux d'en-tête, qui lui
 * ne périme pas.
 */
const TINTS: Record<string, string> = {
  info: 'bg-marque text-[#05070d]',
  warning: 'bg-attention text-[#05070d]',
}

const props = defineProps<{ payload: DisplayPayload; nowMs: number }>()

const actions = useActionsStore()

/**
 * Écartés à la main, en attendant que le retrait fasse le tour.
 *
 * L'état continue de les pousser le temps que la demande atteigne le runtime :
 * sans cette liste, la croix rendrait le signalement pour une seconde.
 */
const dismissed = ref<string[]>([])

const notices = computed(() =>
  (props.payload.state.notifications ?? []).filter(
    (notice) =>
      !dismissed.value.includes(notice.id) &&
      Date.parse(notice.at) > props.nowMs - DUREE_SIGNALEMENT_MS,
  ),
)

function dismiss(id: string): void {
  dismissed.value = [...dismissed.value, id]
  void actions.act({ action: 'notification.dismiss', id })
}
</script>

<template>
  <div
    v-if="notices.length > 0"
    class="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex flex-col items-center gap-2 px-4"
    data-role="notifications"
  >
    <div
      v-for="notice in notices"
      :key="notice.id"
      class="pointer-events-auto flex shrink-0 items-center gap-2.5 rounded-lg px-3.5 py-2 text-[13px] font-medium shadow-[0_10px_30px_rgba(0,0,0,.45)]"
      :class="TINTS[notice.level] ?? TINTS.info"
      :data-notification="notice.id"
    >
      <span class="text-xs tabular-nums opacity-60">{{ time(notice.at, payload.timezone) }}</span>
      <span>{{ notice.text }}</span>
      <!-- Hérite de la couleur du bloc : « attenue » est lisible sur le fond
           sombre de la page, pas sur un fond plein. -->
      <button
        type="button"
        class="ml-auto cursor-pointer border-0 bg-transparent px-1.5 py-0.5 text-current opacity-60"
        aria-label="Écarter"
        @click="dismiss(notice.id)"
      >
        ×
      </button>
    </div>
  </div>
</template>
