<script setup lang="ts">
import { Button, Dialog } from '@cloudnord/components'
import { computed } from 'vue'
import { useKeyboardLayer } from '../stores/keyboard.js'
import { useVodStore } from '../stores/vod.js'
import VodRow from './VodRow.vue'

/**
 * Full width, and not a column.
 *
 * Each row carries a file name, a title, a time, a duration, a size and a verdict.
 * In a column it is read three words at a time and one closes it having checked
 * nothing.
 *
 * It commands nothing in the room — it reads the disk back. So the morning can be
 * checked while the afternoon records, which is the whole point: in the evening,
 * the room is dismantled.
 */
const props = defineProps<{ timeZone: string }>()

const vod = useVodStore()

/*
 * Checking the footage is done two-handed over the list: a reflex "r" on top would
 * start a take behind the operator's back.
 */
useKeyboardLayer(() => ({}), () => vod.open)

/**
 * The only place left to say why the ⬆ have gone from the rows: the button that
 * would do the same thing, greyed out, with the reason.
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
    <div class="mb-2.5 flex flex-wrap items-center gap-2 border-b border-edge pb-2.5">
      <div class="min-w-0 flex-1 truncate font-mono text-[11px] text-dim" data-role="vod-root">
        {{ vod.listing?.root ?? '' }}
      </div>
      <div class="shrink-0 text-xs text-dim" data-role="vod-progress">{{ vod.progress }}</div>
      <Button size="small" class="shrink-0" :disabled="vod.checking" @click="vod.checkAll()">
        Tout vérifier
      </Button>
      <Button
        size="small"
        class="shrink-0"
        :disabled="vod.blocked != null"
        :title="blockedTitle"
        data-role="btn-vod-upload-all"
        @click="vod.upload(null)"
      >
        Tout téléverser
      </Button>
      <Button size="small" class="shrink-0" @click="vod.loadListing()">Relire le dossier</Button>
    </div>

    <!--
      Why nothing is going up.

      A silent wait reads as a dead button: one clicks again, then goes looking for
      the failure. "conférence dans 6 min" reads as a decision.
    -->
    <!--
      The hub knows where to send, but sends nothing of its own accord — the
      default setting. The buttons stay: the regulator accepts manual requests in
      this state. It still has to be said, without amber, otherwise the operator who
      has just sent one by hand wonders why the rest do not leave on their own.
    -->
    <div
      v-if="vod.manualOnly"
      class="mb-2.5 border-b border-edge pb-1.5 text-[11px] text-dim"
      data-role="vod-manual"
    >
      Téléversement automatique désactivé sur le hub : les envois se font à la main, ⬆ par ligne
      ou « Tout téléverser ».
    </div>

    <div
      v-if="vod.waitReason != null"
      class="mb-2.5 border-b border-edge pb-1.5 text-[11px] text-warn"
      data-role="vod-regulator"
    >
      {{ vod.waitReason }}
    </div>

    <div class="max-h-[62vh] min-h-0 overflow-y-auto">
      <div v-if="vod.listing == null" class="text-xs text-dim">Lecture du dossier…</div>

      <!-- An empty list would read as a lost day: say why. -->
      <div v-else-if="vod.listing.root == null" class="text-sm text-warn">
        Aucun dossier d’enregistrement connu. Renseignez-le dans la configuration de la salle, ou
        connectez OBS-B — c’est lui qui dit où il écrit.
      </div>

      <div v-else-if="vod.listing.entries.length === 0" class="text-sm text-dim">
        Aucun fichier vidéo dans ce dossier.
      </div>

      <template v-else>
        <div
          v-if="vod.missingTools != null"
          class="mb-2 rounded-lg border border-warn/40 px-2.5 py-1.5 text-[11px] text-warn"
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

    <p class="mt-2.5 border-t border-edge pt-2 text-[11px] text-dim">
      « Vérifier » ouvre le conteneur avec ffprobe : pistes présentes, durée réelle contre durée
      chronométrée, débit. Ce qu'aucune sonde ne dit — le mauvais plan, le micro dans la poche —
      reste à l'œil : ✓ et ✕ posent ce verdict-là.
    </p>
  </Dialog>
</template>
