<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { ENVOI_LABELS, VIGNETTE_LABELS, envoiPourcent, useYoutubeStore } from '../stores/youtube.js'
import StatusIcon from './StatusIcon.vue'

/** Where a video stands on YouTube: sent, public, its thumbnail. */
const props = defineProps<{ jobId: string }>()
const { envois, vignettes, pending } = storeToRefs(useYoutubeStore())
const envoi = computed(() => envois.value.find((candidate) => candidate.jobId === props.jobId) ?? null)
const vignette = computed(() => vignettes.value.find((candidate) => candidate.cle === props.jobId) ?? null)

const ENVOI_TONES = { attente: 'brand', 'en-cours': 'brand', termine: 'ok', echoue: 'alert' } as const
const VIGNETTE_TONES = { attente: 'brand', calcul: 'brand', prete: 'warn', envoi: 'brand', envoyee: 'ok', echec: 'alert' } as const

const sending = computed(() => envoi.value?.state === 'attente' || envoi.value?.state === 'en-cours')
const drawing = computed(() => ['attente', 'calcul', 'envoi'].includes(vignette.value?.state ?? ''))
const changingVisibility = computed(() => pending.value.has(`${props.jobId}:visibilite`))
const updatingTitle = computed(() => pending.value.has(`${props.jobId}:titre`))
const envoiLabel = computed(() => {
  if (envoi.value == null) return 'YouTube : pas envoyée'
  const percent = envoi.value.state === 'en-cours' ? envoiPourcent(envoi.value) : null
  return `YouTube : ${ENVOI_LABELS[envoi.value.state].label}${percent == null ? '' : ` ${percent} %`}${envoi.value.erreur == null ? '' : ` (${envoi.value.erreur})`}`
})
const publique = computed(() => envoi.value?.visibilite === 'public')
const vignetteLabel = computed(() => {
  if (vignette.value == null) return 'Vignette : aucune'
  return `Vignette : ${VIGNETTE_LABELS[vignette.value.state].label}${vignette.value.erreur == null ? '' : ` (${vignette.value.erreur})`}`
})
</script>

<template>
  <span class="inline-flex flex-none items-center gap-0.5" data-role="statuts">
    <StatusIcon name="upload" :spin="sending || updatingTitle" :tone="envoi == null ? 'off' : ENVOI_TONES[envoi.state]" :label="envoiLabel" />
    <StatusIcon
      :name="publique ? 'eye' : 'eye-off'"
      :spin="changingVisibility"
      :tone="envoi?.state !== 'termine' ? 'off' : publique ? 'ok' : 'warn'"
      :label="envoi?.state !== 'termine' ? 'Visibilité : pas encore sur YouTube' : publique ? 'Visibilité : publique' : 'Visibilité : privée'"
    />
    <StatusIcon name="image" :spin="drawing" :tone="vignette == null ? 'off' : VIGNETTE_TONES[vignette.state]" :label="vignetteLabel" />
  </span>
</template>
