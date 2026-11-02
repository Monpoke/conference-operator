<script setup lang="ts">
import { Button, Empty, Panel, StableLabel } from '@conference-operator/components'
import type { MontageJobView } from '@conference-operator/contract'
import { viewPath } from '@conference-operator/contract'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted } from 'vue'
import { latestByTake } from '../stores/montage.js'
import { ENVOI_LABELS, envoiPourcent, useYoutubeStore } from '../stores/youtube.js'

/** The finished videos and where each stands on the way to the channel. */
const props = defineProps<{ jobs: readonly MontageJobView[] }>()
const store = useYoutubeStore()
const { status, envois } = storeToRefs(store)
const settingsPath = viewPath('reglages')

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void store.load().catch(() => undefined)
  timer = setInterval(() => void store.load().catch(() => undefined), 10_000)
})
onUnmounted(() => clearInterval(timer))

const videos = computed(() => latestByTake(props.jobs).filter((job) => job.state === 'termine'))
const envoiOf = (jobId: string) => envois.value.find((envoi) => envoi.jobId === jobId) ?? null
const reste = computed(() => videos.value.filter((job) => envoiOf(job.id)?.state !== 'termine').length)
const sending = (jobId: string) => ['attente', 'en-cours'].includes(envoiOf(jobId)?.state ?? '')
</script>

<template>
  <Panel id="vod-youtube" title="YouTube" class="col-span-full">
    <p v-if="status?.connected !== true" id="youtube-non-connecte" class="m-0 text-sm text-dim">
      Aucune chaîne connectée : à faire dans <a :href="settingsPath" class="text-brand underline">Réglages</a>.
    </p>
    <template v-else>
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p class="m-0 text-sm text-dim">Chaîne {{ status.channel ?? 'connectée' }}. Envoi en privé, une vidéo à la fois.</p>
        <Button id="btn-youtube-tout" size="small" variant="primary" :disabled="reste === 0" @click="store.send(null).catch(() => undefined)">Tout envoyer ({{ reste }})</Button>
      </div>
      <Empty v-if="videos.length === 0">Aucune vidéo terminée.</Empty>
      <div v-for="job in videos" :key="job.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-edge py-2 text-sm" :data-youtube="job.id">
        <span class="min-w-0 flex-1 basis-60">{{ job.title ?? job.sessionId }}</span>
        <template v-if="envoiOf(job.id) != null">
          <span :class="ENVOI_LABELS[envoiOf(job.id)!.state].tone" :title="envoiOf(job.id)!.erreur ?? undefined" data-role="etat">
            {{ ENVOI_LABELS[envoiOf(job.id)!.state].label }}<template v-if="envoiOf(job.id)!.state === 'en-cours' && envoiPourcent(envoiOf(job.id)!) != null"> · {{ envoiPourcent(envoiOf(job.id)!) }} %</template>
          </span>
          <a v-if="envoiOf(job.id)!.videoId != null" :href="`https://youtu.be/${envoiOf(job.id)!.videoId}`" target="_blank" rel="noopener" class="text-brand underline">Voir</a>
          <span v-if="envoiOf(job.id)!.erreur != null" class="basis-full text-xs break-words text-alert">{{ envoiOf(job.id)!.erreur }}</span>
        </template>
        <Button size="small" :disabled="sending(job.id)" data-role="envoyer" @click="store.send([job.id]).catch(() => undefined)"><StableLabel :current="envoiOf(job.id) == null ? 'Envoyer' : 'Renvoyer'" :labels="['Envoyer', 'Renvoyer']" /></Button>
      </div>
    </template>
  </Panel>
</template>
