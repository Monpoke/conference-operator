<script setup lang="ts">
import { Button } from '@cloudnord/components'
import { timeAgo } from '@cloudnord/format'
import { useSessionStore } from '../stores/session.js'
import { useVerrouStore } from '../stores/verrou.js'

/**
 * Où l'on est, et sous quel compte. Rien de plus.
 *
 * La reprise **n'est pas ici**. Elle a vécu un temps dans ce bandeau, sous la
 * forme d'un bouton à côté du nom du porteur, et c'était l'erreur : la page
 * restait entièrement à l'écran, chaque commande partait au hub pour se faire
 * refuser, et on ne lisait la petite ligne qu'après avoir appuyé. Une salle
 * qu'on ne tient pas n'est pas un détail de bandeau, c'est un état — il vit
 * dans `VerrouVeil`.
 *
 * Reste ce qui sert quel que soit l'état : revenir aux salles, et savoir sous
 * quel compte on est connecté — la question qu'on se pose justement quand on
 * découvre qu'un autre onglet tient la salle.
 */
const props = defineProps<{ nowMs: number }>()

const session = useSessionStore()
const verrou = useVerrouStore()
</script>

<template>
  <div
    class="flex items-center gap-2 border-b border-bord bg-surface px-3 py-2 text-xs"
    data-role="verrou"
  >
    <Button class="shrink-0" @click="verrou.quitter()">‹ Salles</Button>

    <span v-if="verrou.jeTiens" class="min-w-0 flex-1 truncate text-attenue">
      Vous pilotez cette salle
      <span v-if="verrou.verrou != null">
        · depuis {{ timeAgo(verrou.verrou.heldSince, props.nowMs) }}
      </span>
    </span>

    <!--
      Tenue ailleurs : le voile le dit en grand et porte la décision. Ici, une
      mention, pour que la ligne ne se contredise pas quand le voile se referme.
    -->
    <span
      v-else-if="verrou.tenueAilleurs"
      class="min-w-0 flex-1 truncate text-attention"
      data-role="verrou-porteur"
    >
      Lecture seule — {{ verrou.monAutreSession ? 'un autre de vos onglets' : verrou.porteur }}
    </span>

    <span v-else class="min-w-0 flex-1 truncate text-attenue">Salle non prise</span>

    <span class="shrink-0 text-attenue">{{ session.identity ?? '' }}</span>
  </div>
</template>
