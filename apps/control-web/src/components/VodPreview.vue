<script setup lang="ts">
import type { VodEntry } from '@cloudnord/contract'
import { Button } from '@cloudnord/components'
import { computed, ref } from 'vue'
import { EXTRACT_MS, useVodStore } from '../stores/vod.js'

/**
 * A preview of one file, unfolded under its row.
 *
 * OBS's recordings are Matroska files, which no browser can open, and they weigh
 * several gigabytes: the player receives a twenty-second excerpt repackaged into
 * MP4 by ffmpeg, produced on demand and never written to disk. The starting points
 * jump to the places a take usually breaks — the very beginning, and the end.
 */
const props = defineProps<{ entry: VodEntry }>()

const vod = useVodStore()

const broken = ref(false)

const encoded = computed(() => encodeURIComponent(props.entry.file))
const at = computed(() => vod.preview?.at ?? 0)

const durationMs = computed(
  () => props.entry.check?.probe?.durationMs ?? props.entry.sidecar?.durationMs ?? null,
)

const points = computed(() => {
  const total = durationMs.value
  if (total == null || total < 60_000) return [{ label: 'Début', at: 0 }]
  return [
    { label: 'Début', at: 0 },
    { label: '25 %', at: Math.round(total * 0.25) },
    { label: 'Milieu', at: Math.round(total * 0.5) },
    { label: '75 %', at: Math.round(total * 0.75) },
    { label: 'Fin', at: Math.max(0, total - EXTRACT_MS) },
  ]
})

const ffmpeg = computed(() => vod.listing?.tools?.ffmpeg === true)

/*
 * Without ffmpeg we serve the file as is: the browser will read an MP4 and choke
 * on a Matroska. Saying so up front beats a black player.
 */
const source = computed(() =>
  ffmpeg.value
    ? `/control/recordings/excerpt?file=${encoded.value}&at=${at.value}&duration=${EXTRACT_MS}`
    : `/control/recordings/file?file=${encoded.value}`,
)

const notice = computed(() => {
  if (broken.value) {
    return "Extrait illisible : ce fichier ne s’ouvre pas. C’est en soi une réponse — lancez « Vérifier » pour savoir ce qui manque."
  }
  return ffmpeg.value
    ? `Extrait de ${Math.round(EXTRACT_MS / 1000)} s, remballé à la volée — le fichier n’est pas modifié.`
    : 'ffmpeg introuvable : lecture directe du fichier. Un Matroska ne s’ouvrira pas dans le navigateur — passez par « Fichier brut ».'
})

function seek(position: number): void {
  broken.value = false
  vod.preview = { file: props.entry.file, at: position }
}
</script>

<template>
  <div class="col-span-2 mt-2 border-t border-edge pt-2">
    <div class="mb-1.5 flex flex-wrap items-center gap-1.5">
      <span v-if="ffmpeg" class="text-[11px] text-dim">Extrait à partir de</span>
      <Button
        v-for="point in ffmpeg ? points : []"
        :key="point.at"
        size="small"
        class="px-2 py-1 text-[11px]"
        :active="point.at === at"
        :data-vod-position="point.at"
        @click="seek(point.at)"
      >
        {{ point.label }}
      </Button>
      <a
        class="ml-auto rounded-lg border border-edge bg-surface2 px-2 py-1 text-[11px] font-semibold text-text no-underline"
        target="_blank"
        rel="noreferrer"
        :href="`/control/recordings/file?file=${encoded}`"
      >
        Fichier brut
      </a>
    </div>
    <!--
      The click on 👁 counts as a user gesture: playback may start on its own.
      Refused — browser policy — the controls are still there.
    -->
    <video
      :key="source"
      class="max-h-[46vh] w-full rounded-lg bg-black"
      controls
      autoplay
      playsinline
      :src="source"
      @error="broken = true"
    ></video>
    <div
      class="mt-1 text-[11px]"
      :class="broken ? 'text-alert' : 'text-dim'"
      data-role="vod-notice"
    >
      {{ notice }}
    </div>
  </div>
</template>
