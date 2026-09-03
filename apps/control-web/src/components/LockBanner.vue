<script setup lang="ts">
import { Button } from '@cloudnord/components'
import { timeAgo } from '@cloudnord/format'
import { useSessionStore } from '../stores/session.js'
import { useLockStore } from '../stores/lock.js'

/**
 * Où l'on est, et sous quel compte. Rien de plus.
 *
 * La reprise **n'est pas ici**. Elle a vécu un temps dans ce bandeau, sous la
 * forme d'un bouton à côté du nom du porteur, et c'était l'erreur : la page
 * restait entièrement à l'écran, chaque commande partait au hub pour se faire
 * refuser, et on ne lisait la petite ligne qu'après avoir appuyé. Une salle
 * qu'on ne tient pas n'est pas un détail de bandeau, c'est un état — il vit
 * dans `LockVeil`.
 *
 * Reste ce qui sert quel que soit l'état : revenir aux salles, et savoir sous
 * quel compte on est connecté — la question qu'on se pose justement quand on
 * découvre qu'un autre onglet tient la salle.
 */
const props = defineProps<{ nowMs: number }>()

const session = useSessionStore()
const lock = useLockStore()
</script>

<template>
  <div
    class="flex items-center gap-2 border-b border-edge bg-surface px-3 py-2 text-xs"
    data-role="verrou"
  >
    <Button class="shrink-0" @click="lock.leave()">‹ Salles</Button>

    <span v-if="lock.iHold" class="min-w-0 flex-1 truncate text-dim">
      Vous pilotez cette salle
      <span v-if="lock.lock != null">
        · depuis {{ timeAgo(lock.lock.heldSince, props.nowMs) }}
      </span>
    </span>

    <!--
      Tenue ailleurs : le voile le dit en grand et porte la décision. Ici, une
      mention, pour que la ligne ne se contredise pas quand le voile se referme.
    -->
    <span
      v-else-if="lock.heldElsewhere"
      class="min-w-0 flex-1 truncate text-warn"
      data-role="verrou-porteur"
    >
      Lecture seule — {{ lock.myOtherSession ? 'un autre de vos onglets' : lock.holder }}
    </span>

    <span v-else class="min-w-0 flex-1 truncate text-dim">Salle non prise</span>

    <span class="shrink-0 text-dim">{{ session.identity ?? '' }}</span>
  </div>
</template>
