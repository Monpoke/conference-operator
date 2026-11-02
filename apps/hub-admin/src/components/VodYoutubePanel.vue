<script setup lang="ts">
import { Button, Empty, Panel, StableLabel } from '@conference-operator/components'
import type { MontageJobView } from '@conference-operator/contract'
import { viewPath } from '@conference-operator/contract'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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
const playlistTitle = ref('')
const playlistPublique = ref(false)
const playlistBusy = ref(false)
watch(() => status.value?.playlist, (playlist) => {
  if (playlist == null) return
  playlistTitle.value = playlist.title
  playlistPublique.value = playlist.publique
}, { immediate: true })
const sent = computed(() => envois.value.filter((envoi) => envoi.state === 'termine').length)
async function syncPlaylist(): Promise<void> {
  playlistBusy.value = true
  try {
    await store.syncPlaylist(playlistTitle.value, playlistPublique.value)
  } catch {
    /* already reported by the hub client */
  } finally {
    playlistBusy.value = false
  }
}

async function toggleVisibilite(jobId: string): Promise<void> {
  const publique = envoiOf(jobId)?.visibilite !== 'public'
  if (publique && !confirm('Rendre cette vidéo publique ? Tout le monde pourra la voir sur la chaîne. Vérifiez que l’orateur a donné son accord.')) return
  await store.setVisibilite(jobId, publique).catch(() => undefined)
}

const sending = (jobId: string) => ['attente', 'en-cours'].includes(envoiOf(jobId)?.state ?? '')
</script>

<template>
  <Panel id="vod-youtube" title="YouTube" class="col-span-full">
    <p v-if="status?.connected !== true" id="youtube-non-connecte" class="m-0 text-sm text-dim">
      Aucune chaîne connectée : à faire dans <a :href="settingsPath" class="text-brand underline">Réglages</a>.
    </p>
    <template v-else>
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p class="m-0 text-sm text-dim">Chaîne {{ status.channel ?? 'connectée' }}. Envoi en privé, une vidéo à la fois ; publication ici, vidéo par vidéo.</p>
        <Button id="btn-youtube-tout" size="small" variant="primary" :disabled="reste === 0" @click="store.send(null).catch(() => undefined)">Tout envoyer ({{ reste }})</Button>
      </div>
      <form id="youtube-playlist" class="mb-2 flex flex-wrap items-center gap-2 border-t border-edge pt-2" @submit.prevent="syncPlaylist">
        <label class="sr-only" for="youtube-playlist-titre">Titre de la playlist</label>
        <input id="youtube-playlist-titre" v-model="playlistTitle" maxlength="150" placeholder="Titre de la playlist" class="min-w-48 flex-1 rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text">
        <label class="flex items-center gap-1.5 text-sm"><input v-model="playlistPublique" type="checkbox" class="w-auto"> Publique</label>
        <Button type="submit" size="small" :disabled="playlistBusy || playlistTitle.trim() === '' || sent === 0"><StableLabel :current="status.playlist == null ? 'Créer la playlist' : 'Mettre à jour la playlist'" :labels="['Créer la playlist', 'Mettre à jour la playlist']" /></Button>
        <a v-if="status.playlist != null" :href="`https://www.youtube.com/playlist?list=${status.playlist.id}`" target="_blank" rel="noopener" class="text-sm text-brand underline" data-role="playlist">Voir ({{ status.playlist.videos }} vidéos)</a>
      </form>
      <Empty v-if="videos.length === 0">Aucune vidéo terminée.</Empty>
      <div v-for="job in videos" :key="job.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-edge py-2 text-sm" :data-youtube="job.id">
        <span class="min-w-0 flex-1 basis-60">{{ job.nomVideo }}</span>
        <template v-if="envoiOf(job.id) != null">
          <span :class="ENVOI_LABELS[envoiOf(job.id)!.state].tone" :title="envoiOf(job.id)!.erreur ?? undefined" data-role="etat">
            {{ ENVOI_LABELS[envoiOf(job.id)!.state].label }}<template v-if="envoiOf(job.id)!.state === 'termine'"> ({{ envoiOf(job.id)!.visibilite === 'public' ? 'publique' : 'privée' }})</template><template v-if="envoiOf(job.id)!.state === 'en-cours' && envoiPourcent(envoiOf(job.id)!) != null"> · {{ envoiPourcent(envoiOf(job.id)!) }} %</template>
          </span>
          <a v-if="envoiOf(job.id)!.videoId != null" :href="`https://youtu.be/${envoiOf(job.id)!.videoId}`" target="_blank" rel="noopener" class="text-brand underline">Voir</a>
 <Button
            v-if="envoiOf(job.id)!.state === 'termine'"
            size="small"
            :variant="envoiOf(job.id)!.visibilite === 'public' ? 'neutral' : 'primary'"
            data-role="visibilite"
            @click="toggleVisibilite(job.id)"
          ><StableLabel :current="envoiOf(job.id)!.visibilite === 'public' ? 'Rendre privée' : 'Rendre publique'" :labels="['Rendre privée', 'Rendre publique']" /></Button>
          <span v-if="envoiOf(job.id)!.erreur != null" class="basis-full text-xs break-words text-alert">{{ envoiOf(job.id)!.erreur }}</span>
        </template>
        <Button size="small" :disabled="sending(job.id)" data-role="envoyer" @click="store.send([job.id]).catch(() => undefined)"><StableLabel :current="envoiOf(job.id) == null ? 'Envoyer' : 'Renvoyer'" :labels="['Envoyer', 'Renvoyer']" /></Button>
      </div>
    </template>
  </Panel>
</template>
