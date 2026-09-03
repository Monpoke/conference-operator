<script setup lang="ts">
import { NOTIFICATION_TTL_MS, type DisplayPayload } from '@cloudnord/contract'
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
  info: 'bg-brand text-[#05070d]',
  warning: 'bg-warn text-[#05070d]',
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
      Date.parse(notice.at) > props.nowMs - NOTIFICATION_TTL_MS,
  ),
)

async function dismiss(id: string): Promise<void> {
  dismissed.value = [...dismissed.value, id]
  const result = await actions.act({ action: 'notification.dismiss', id }, { silent: true })

  /*
   * Refusé : on le remet.
   *
   * L'écart local existe pour couvrir l'aller-retour, pas pour effacer ce que
   * le runtime a gardé. Sans ce retour en arrière, un signalement que le poste
   * refuse d'oublier resterait invisible jusqu'au rechargement de la page —
   * caché à celui qui l'a écarté, et toujours là pour tous les autres.
   */
  if (!result.ok) dismissed.value = dismissed.value.filter((autre) => autre !== id)
}
</script>

<template>
  <div
    v-if="notices.length > 0"
    class="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex flex-col items-center gap-2 px-4"
    data-role="notifications"
  >
    <!--
      Tout l'encart est le bouton, et pas seulement sa croix.
      Un signalement se lit d'un coup d'œil et s'écarte d'un revers de souris,
      pendant qu'on tient le micro. Viser une croix de douze pixels dans une
      salle sombre demande de s'arrêter et de regarder — c'est-à-dire de quitter
      des yeux ce qui se passe sur scène, pour un geste qui ne mérite pas ça.

      Un `<button>` plutôt qu'un `<div>` qui écoute le clic : il se met au
      clavier, s'annonce comme actionnable, et répond à Entrée. La croix reste,
      décorative — c'est elle qui dit que l'encart se ferme.
    -->
    <button
      v-for="notice in notices"
      :key="notice.id"
      type="button"
      class="pointer-events-auto flex w-auto shrink-0 cursor-pointer items-center gap-2.5 rounded-lg border-0 px-3.5 py-2 text-left text-[13px] font-medium shadow-[0_10px_30px_rgba(0,0,0,.45)]"
      :class="TINTS[notice.level] ?? TINTS.info"
      :data-notification="notice.id"
      :title="`Écarter : ${notice.text}`"
      @click="dismiss(notice.id)"
    >
      <span class="text-xs tabular-nums opacity-60">{{ time(notice.at, payload.timezone) }}</span>
      <span>{{ notice.text }}</span>
      <!-- Hérite de la couleur du bloc : « attenue » est lisible sur le fond
           sombre de la page, pas sur un fond plein. -->
      <span class="ml-auto px-1.5 py-0.5 text-current opacity-60" aria-hidden="true">×</span>
    </button>
  </div>
</template>
