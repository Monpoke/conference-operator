<script setup lang="ts">
import { Button, Dialog } from '@cloudnord/components'
import { computed } from 'vue'
import { useKeyboardLayer } from '../stores/keyboard.js'
import { useVodStore } from '../stores/vod.js'
import VodRow from './VodRow.vue'

/**
 * Plein cadre, et pas une colonne.
 *
 * Chaque ligne porte un nom de fichier, un titre, une heure, une durée, une
 * taille et un verdict. En colonne, elle se lit à coups de trois mots par ligne
 * et on referme sans avoir rien vérifié.
 *
 * Elle ne commande rien dans la salle — elle relit le disque. On peut donc
 * contrôler la matinée pendant que l'après-midi enregistre, ce qui est tout
 * l'intérêt : le soir, la salle est démontée.
 */
const props = defineProps<{ timeZone: string }>()

const vod = useVodStore()

/*
 * Le contrôle des rushes se lit à deux mains sur la liste : un « r » réflexe
 * par-dessus lancerait une captation dans le dos de l'opérateur.
 */
useKeyboardLayer(() => ({}), () => vod.open)

/**
 * Le seul endroit qui reste pour dire pourquoi les ⬆ ont disparu des lignes :
 * le bouton qui ferait la même chose, grisé, avec le motif.
 */
const blockedTitle = computed(() =>
  vod.blocked == null
    ? 'Envoyer tous les rushes non montés au stockage'
    : `${vod.blocked.charAt(0).toUpperCase()}${vod.blocked.slice(1)} — téléversements indisponibles`,
)

const timeZone = computed(() => props.timeZone)
</script>

<template>
  <Dialog v-model:open="vod.open" title="🎞 Enregistrements" width="full">
    <div class="mb-2.5 flex flex-wrap items-center gap-2 border-b border-bord pb-2.5">
      <div class="min-w-0 flex-1 truncate font-mono text-[11px] text-attenue" data-role="vod-racine">
        {{ vod.listing?.root ?? '' }}
      </div>
      <div class="shrink-0 text-xs text-attenue" data-role="vod-avancement">{{ vod.progress }}</div>
      <Button size="small" class="shrink-0" :disabled="vod.checking" @click="vod.checkAll()">
        Tout vérifier
      </Button>
      <Button
        size="small"
        class="shrink-0"
        :disabled="vod.blocked != null"
        :title="blockedTitle"
        data-role="btn-vod-monter-tout"
        @click="vod.upload(null)"
      >
        Tout téléverser
      </Button>
      <Button size="small" class="shrink-0" @click="vod.loadListing()">Relire le dossier</Button>
    </div>

    <!--
      Pourquoi rien ne monte.

      Une attente muette se lit comme un bouton mort : on reclique, puis on
      cherche la panne. « conférence dans 6 min » se lit comme une décision.
    -->
    <!--
      Le hub sait où envoyer, mais n'envoie rien de lui-même — le réglage par
      défaut. Les boutons restent : le régulateur accepte les demandes
      manuelles dans cet état. Reste à le dire, sans ambre, sinon l'opérateur
      qui vient d'en monter un à la main se demande pourquoi les suivants ne
      partent pas seuls.
    -->
    <div
      v-if="vod.manualOnly"
      class="mb-2.5 border-b border-bord pb-1.5 text-[11px] text-attenue"
      data-role="vod-manuel"
    >
      Téléversement automatique désactivé sur le hub : les envois se font à la main, ⬆ par ligne
      ou « Tout téléverser ».
    </div>

    <div
      v-if="vod.waitReason != null"
      class="mb-2.5 border-b border-bord pb-1.5 text-[11px] text-attention"
      data-role="vod-regulateur"
    >
      {{ vod.waitReason }}
    </div>

    <div class="max-h-[62vh] min-h-0 overflow-y-auto">
      <div v-if="vod.listing == null" class="text-xs text-attenue">Lecture du dossier…</div>

      <!-- Une liste vide se lirait comme une journée perdue : dire pourquoi. -->
      <div v-else-if="vod.listing.root == null" class="text-sm text-attention">
        Aucun dossier d’enregistrement connu. Renseignez-le dans la configuration de la salle, ou
        connectez OBS-B — c’est lui qui dit où il écrit.
      </div>

      <div v-else-if="vod.listing.entries.length === 0" class="text-sm text-attenue">
        Aucun fichier vidéo dans ce dossier.
      </div>

      <template v-else>
        <div
          v-if="vod.missingTools != null"
          class="mb-2 rounded-lg border border-attention/40 px-2.5 py-1.5 text-[11px] text-attention"
        >
          {{ vod.missingTools }}
        </div>
        <div class="flex flex-col gap-1.5">
          <VodRow
            v-for="entry in vod.listing.entries"
            :key="entry.file"
            :entry="entry"
            :time-zone="timeZone"
          />
        </div>
      </template>
    </div>

    <p class="mt-2.5 border-t border-bord pt-2 text-[11px] text-attenue">
      « Vérifier » ouvre le conteneur avec ffprobe : pistes présentes, durée réelle contre durée
      chronométrée, débit. Ce qu'aucune sonde ne dit — le mauvais plan, le micro dans la poche —
      reste à l'œil : ✓ et ✕ posent ce verdict-là.
    </p>
  </Dialog>
</template>
