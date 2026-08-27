<script setup lang="ts">
import type { EntreeVod } from '@cloudnord/contract'
import { Button } from '@cloudnord/components'
import { computed, ref } from 'vue'
import { EXTRACT_MS, useVodStore } from '../stores/vod.js'

/**
 * Aperçu d'un rush, déplié sous sa ligne.
 *
 * Les rushes d'OBS sont des Matroska, qu'aucun navigateur ne sait ouvrir, et
 * ils pèsent plusieurs gigaoctets : le lecteur reçoit un extrait de vingt
 * secondes remballé en MP4 par ffmpeg, produit à la demande et jamais écrit sur
 * le disque. Les points de départ sautent aux endroits où une prise se casse
 * d'habitude — le tout début, et la fin.
 */
const props = defineProps<{ entry: EntreeVod }>()

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

const ffmpeg = computed(() => vod.listing?.outils?.ffmpeg === true)

/*
 * Sans ffmpeg, on sert le fichier tel quel : le navigateur lira un MP4 et
 * butera sur un Matroska. Le dire d'avance vaut mieux qu'un lecteur noir.
 */
const source = computed(() =>
  ffmpeg.value
    ? `/control/recordings/extrait?file=${encoded.value}&at=${at.value}&duree=${EXTRACT_MS}`
    : `/control/recordings/fichier?file=${encoded.value}`,
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
  <div class="col-span-2 mt-2 border-t border-bord pt-2">
    <div class="mb-1.5 flex flex-wrap items-center gap-1.5">
      <span v-if="ffmpeg" class="text-[11px] text-attenue">Extrait à partir de</span>
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
        class="ml-auto rounded-lg border border-bord bg-surface2 px-2 py-1 text-[11px] font-semibold text-texte no-underline"
        target="_blank"
        rel="noreferrer"
        :href="`/control/recordings/fichier?file=${encoded}`"
      >
        Fichier brut
      </a>
    </div>
    <!--
      Le clic sur 👁 vaut geste utilisateur : la lecture peut partir seule.
      Refusée — politique du navigateur —, les commandes restent là.
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
      :class="broken ? 'text-alerte' : 'text-attenue'"
      data-role="vod-avis"
    >
      {{ notice }}
    </div>
  </div>
</template>
