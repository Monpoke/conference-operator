<script setup lang="ts">
import type { EntreeVod } from '@cloudnord/contract'
import { Button } from '@cloudnord/components'
import { fileSize, shortDuration, time } from '@cloudnord/format'
import { computed } from 'vue'
import { UPLOAD_WORDS, VERDICT_BADGES, useVodStore } from '../stores/vod.js'
import VodPreview from './VodPreview.vue'

const props = defineProps<{ entry: EntreeVod; timeZone: string }>()

const vod = useVodStore()

const check = computed(() => props.entry.check)
const sidecar = computed(() => props.entry.sidecar)
const upload = computed(() => vod.uploadOf(props.entry.file))

const badge = computed(
  () => VERDICT_BADGES[check.value?.status ?? ''] ?? ['Non vérifié', 'border-bord text-attenue'],
)

const durationMs = computed(
  () => check.value?.probe?.durationMs ?? sidecar.value?.durationMs ?? null,
)

const speakers = computed(() =>
  (sidecar.value?.speakers ?? [])
    .map((person) => person.name)
    .filter(Boolean)
    .join(', '),
)

/** Ce qui se lit d'un coup d'œil : quand, combien, et ce qui manque déjà. */
const details = computed(() => {
  const parts: string[] = []
  if (sidecar.value == null) parts.push('sidecar absent')
  else {
    parts.push(time(sidecar.value.startedAt, props.timeZone))
    const markers = (sidecar.value.markers ?? []).length
    if (markers > 0) parts.push(`${markers} marqueur${markers > 1 ? 's' : ''}`)
  }
  if (durationMs.value != null) parts.push(shortDuration(durationMs.value))
  parts.push(fileSize(props.entry.sizeBytes))
  if (props.entry.enEcriture) parts.push('encore en écriture')
  if (check.value?.by === 'operateur') parts.push('verdict de la régie')

  /*
   * L'état de montée se lit dans la même ligne que le reste : c'est la même
   * question — « ce rush est-il en sécurité ? » — et la séparer en deux
   * colonnes obligerait à croiser deux listes des yeux.
   */
  const state = upload.value?.state
  if (state != null) {
    const word = UPLOAD_WORDS[state] ?? state
    parts.push(state === 'en-cours' ? `${word} — ${upload.value?.pourcent} %` : word)
  }
  return parts.join(' · ')
})

/** « Actif » sur le verdict déjà posé : le même bouton l'enlève. */
function posed(status: string): boolean {
  return check.value?.by === 'operateur' && check.value.status === status
}
</script>

<template>
  <div
    class="grid grid-cols-[1fr_auto] items-start gap-3 rounded-lg border border-bord p-2.5"
    :data-vod="entry.file"
  >
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <span
          class="rounded border px-1.5 py-px text-[10px] font-semibold tracking-[.08em] uppercase"
          :class="badge[1]"
        >
          {{ badge[0] }}
        </span>
        <span class="truncate font-mono text-[12px] text-attenue">{{ entry.file }}</span>
      </div>
      <div class="mt-1 truncate text-sm">
        {{ sidecar?.title ?? 'Titre inconnu' }}
        <span v-if="speakers !== ''" class="text-attenue"> — {{ speakers }}</span>
      </div>
      <div class="mt-0.5 text-[11px] text-attenue">{{ details }}</div>

      <!-- Un badge rouge sans raison ne sert personne. -->
      <div
        v-if="(check?.reasons.length ?? 0) > 0"
        class="mt-1 text-[11px]"
        :class="check?.status === 'ok' ? 'text-attenue' : 'text-attention'"
      >
        {{ check?.reasons.join(' · ') }}
      </div>

      <!-- « AccessDenied » est le seul mot qu'on puisse porter à qui tient le
           bucket : le traduire ferait perdre la seule prise sur le problème. -->
      <div v-if="upload?.erreur != null" class="mt-1 text-[11px] text-alerte">
        Téléversement : {{ upload.erreur }}
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-1">
      <Button
        size="small"
        title="Voir et entendre un extrait"
        :active="vod.preview?.file === entry.file"
        :data-vod-apercu="entry.file"
        @click="vod.togglePreview(entry.file)"
      >
        👁
      </Button>
      <Button
        size="small"
        title="Relit le conteneur : pistes, durée réelle, débit"
        :data-vod-inspect="entry.file"
        @click="vod.inspect(entry.file)"
      >
        Vérifier
      </Button>

      <!--
        Trois états, un seul bouton : rien (⬆), en cours (Annuler), terminé
        (rien à proposer). Un rush déjà chez le stockage ne doit pas offrir de
        bouton qui repaierait trois gigaoctets sur le réseau de l'événement au
        premier clic distrait. Absent tant que le hub n'a pas de destination :
        un bouton qui échoue à chaque clic est pire qu'un bouton absent, et
        l'en-tête dit déjà pourquoi.
      -->
      <template v-if="vod.blocked == null">
        <Button
          v-if="upload?.state === 'en-cours' || upload?.state === 'attente'"
          size="small"
          title="Renoncer à ce téléversement"
          :data-vod-annuler="entry.file"
          @click="vod.cancelUpload(entry.file)"
        >
          Annuler
        </Button>
        <span
          v-else-if="upload?.state === 'termine'"
          class="px-1.5 text-[13px] text-attenue"
          title="Déjà chez le stockage"
        >
          ☁
        </span>
        <Button
          v-else
          size="small"
          :title="
            entry.enEcriture
              ? 'Prise encore en cours : le fichier partira une fois arrêtée'
              : 'Envoyer ce rush et son sidecar au stockage'
          "
          :data-vod-monter="entry.file"
          @click="vod.upload(entry.file)"
        >
          ⬆
        </Button>
      </template>

      <Button
        size="small"
        title="Fichier ouvert et relu : exploitable"
        :active="posed('ok')"
        :data-vod-verdict-ok="entry.file"
        @click="vod.verdict(entry.file, 'ok')"
      >
        ✓
      </Button>
      <Button
        size="small"
        title="Fichier inexploitable : à refaire ou à signaler"
        :active="posed('illisible')"
        :data-vod-verdict-ko="entry.file"
        @click="vod.verdict(entry.file, 'illisible')"
      >
        ✕
      </Button>
    </div>

    <VodPreview v-if="vod.preview?.file === entry.file" :entry="entry" />
  </div>
</template>
