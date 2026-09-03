<script setup lang="ts">
import { Button } from '@cloudnord/components'
import { timeAgo } from '@cloudnord/format'
import { computed } from 'vue'
import { usePorteStore } from '../stores/porte.js'
import { useVerrouStore } from '../stores/verrou.js'

/**
 * Un état, et surtout pas un bouton dans un coin.
 *
 * Rien de ce qu'il recouvre n'est utilisable : chaque commande de la page
 * partirait au hub pour se faire refuser. Un petit « Reprendre » en barre
 * laissait une régie complète à l'écran — le compte à rebours, « Commencer »,
 * « Enregistrer » — tous actifs en apparence, tous perdants. On appuie d'abord,
 * on lit ensuite, et c'est en plein talk qu'on découvre pourquoi rien ne s'est
 * passé.
 *
 * Même raison que le voile d'appairage, et même forme : il occupe l'écran tant
 * que la condition dure, disparaît quand elle cesse, et n'a pas de bouton
 * fermer — il n'y a rien derrière à laisser voir.
 *
 * Ce qu'il **laisse passer**, en revanche, c'est la lecture : l'état de la
 * salle reste visible en dessous, atténué. Venir regarder une salle qu'un
 * collègue pilote est un usage normal — c'est même ce que fait quelqu'un qui
 * hésite à la reprendre.
 */
const porte = usePorteStore()
const verrou = useVerrouStore()

/** Depuis quand ce porteur-là tient la salle. Recalculé au tic de la page. */
const props = defineProps<{ nowMs: number }>()

const depuis = computed(() =>
  verrou.verrou == null ? null : timeAgo(verrou.verrou.heldSince, props.nowMs),
)

const titre = computed(() => {
  if (verrou.pasPrise) return 'Cette salle n’est pas prise'
  return verrou.monAutreSession
    ? 'Vous pilotez déjà cette salle ailleurs'
    : 'Cette salle est pilotée par quelqu’un d’autre'
})

/**
 * Deux phrases, parce que ce ne sont pas deux fois la même situation.
 *
 * Son propre nom affiché comme celui d'un tiers se lit comme une panne — on
 * cherche le second compte, et il n'existe pas. Nommer l'autre appareil ferme
 * la question tout de suite.
 */
const explication = computed(() => {
  if (verrou.pasPrise) {
    /*
     * Le cas du verrou expiré, et il faut le dire sans inquiéter.
     *
     * Trente secondes sans nouvelles suffisent : un téléphone verrouillé dans
     * une poche, un tunnel, une bascule d'application. Rien n'est cassé, la
     * salle attend simplement qu'on la reprenne.
     */
    return (
      'Personne ne la pilote à distance en ce moment — votre prise a expiré, ou ' +
      'vous ne l’aviez pas encore prise. Reprenez-la pour retrouver les commandes.'
    )
  }
  const quand = depuis.value == null ? '' : ` depuis ${depuis.value}`
  return verrou.monAutreSession
    ? `Un autre onglet ou appareil connecté avec votre compte tient la régie de cette salle${quand}. ` +
        'Reprendre ici en retirera les commandes là-bas.'
    : `${verrou.porteur} tient la régie de cette salle${quand}. ` +
        'Reprendre lui retirera les commandes, au milieu de ce qu’il est en train de faire.'
})

/** Prendre une salle libre n'est pas reprendre : le bouton ne ment pas. */
const action = computed(() => (verrou.pasPrise ? 'Prendre le contrôle' : 'Reprendre le contrôle'))
</script>

<template>
  <div
    class="fixed inset-0 z-40 flex items-end justify-center bg-canvas/80 p-4 backdrop-blur-[2px] sm:items-center"
    data-role="verrou-veil"
  >
    <div class="w-full max-w-[460px] rounded-2xl border border-edge bg-surface px-6 py-7 text-center">
      <h1 class="mb-2 text-lg font-semibold">{{ titre }}</h1>
      <p class="mb-6 text-sm leading-relaxed text-dim" data-role="verrou-veil-detail">
        {{ explication }}
      </p>

      <div class="flex flex-col gap-2">
        <!--
          « Reprendre » d'abord : c'est le geste qu'on vient chercher ici. Il ne
          demande pas de seconde confirmation — le voile *est* la question, et
          la reposer en ferait un clic de réflexe.
        -->
        <Button
          variant="primary"
          class="w-full py-3"
          data-role="verrou-reprendre"
          @click="porte.roomId != null && verrou.ouvrir(porte.roomId, true)"
        >
          {{ action }}
        </Button>
        <Button class="w-full py-3" data-role="verrou-quitter" @click="verrou.quitter()">
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
