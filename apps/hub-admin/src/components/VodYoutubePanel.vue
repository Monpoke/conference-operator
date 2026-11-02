<script setup lang="ts">
import { Button, Empty, Panel, StableLabel, useToast } from '@conference-operator/components'
import type { MontageJobView } from '@conference-operator/contract'
import { viewPath } from '@conference-operator/contract'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useConfirmStore } from '../stores/confirm.js'
import { latestByTake } from '../stores/montage.js'
import { VIGNETTE_LABELS, actionsPossibles, useYoutubeStore } from '../stores/youtube.js'
import ActionMenu, { type ActionMenuItem } from './ActionMenu.vue'
import Spinner from './Spinner.vue'
import StatusIcon from './StatusIcon.vue'
import YoutubeStatusIcons from './YoutubeStatusIcons.vue'

/** The finished videos and where each stands on the way to the channel. */
const props = defineProps<{ jobs: readonly MontageJobView[] }>()
const store = useYoutubeStore()
const { status, envois, vignettes } = storeToRefs(store)
const settingsPath = viewPath('reglages')
const toast = useToast()
const confirmStore = useConfirmStore()

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void store.load().catch(() => undefined)
  timer = setInterval(() => void store.load().catch(() => undefined), 10_000)
})
onUnmounted(() => clearInterval(timer))

const videos = computed(() => latestByTake(props.jobs).filter((job) => job.state === 'termine'))
const envoiOf = (jobId: string) => envois.value.find((envoi) => envoi.jobId === jobId) ?? null
const vignetteOf = (cle: string) => vignettes.value.find((vignette) => vignette.cle === cle) ?? null
const vignetteImage = (cle: string) => {
  const vignette = vignetteOf(cle)
  return vignette != null && ['prete', 'envoi', 'envoyee'].includes(vignette.state) ? `/youtube/vignette/${cle}?v=${encodeURIComponent(vignette.updatedAt)}` : null
}
const sent = computed(() => envois.value.filter((envoi) => envoi.state === 'termine').length)

const selected = ref<ReadonlySet<string>>(new Set())
const chosen = computed(() => videos.value.map((job) => job.id).filter((id) => selected.value.has(id)))
const allChosen = computed(() => videos.value.length > 0 && chosen.value.length === videos.value.length)
const possible = computed(() => actionsPossibles(chosen.value, envois.value, vignettes.value))
function toggleOne(id: string): void {
  const next = new Set(selected.value)
  if (!next.delete(id)) next.add(id)
  selected.value = next
}
function toggleAll(): void {
  selected.value = allChosen.value ? new Set() : new Set(videos.value.map((job) => job.id))
}

/** The grouped action under way, and how far it went. */
const progress = ref<{ label: string; done: number; total: number } | null>(null)
const busy = computed(() => progress.value != null)
/** One after the other: a refusal stops there, and says how far it went. */
async function forEach(ids: readonly string[], step: (id: string) => Promise<void>, done: string, label: string): Promise<void> {
  progress.value = { label, done: 0, total: ids.length }
  let count = 0
  try {
    for (const id of ids) {
      await step(id)
      count += 1
      progress.value = { label, done: count, total: ids.length }
    }
    toast.say(`${count} ${done}`)
  } catch {
    toast.say(`Arrêté après ${count} sur ${ids.length}`)
  } finally {
    progress.value = null
  }
}
const videosWord = (count: number) => `${count} vidéo${count > 1 ? 's' : ''}`
async function publish(ids: readonly string[], publique: boolean): Promise<void> {
  if (publique && !(await confirmStore.ask({
    title: `Rendre ${videosWord(ids.length)} publique${ids.length > 1 ? 's' : ''} ?`,
    message: 'Tout le monde pourra les voir sur la chaîne. Vérifiez que les orateurs ont donné leur accord.',
    confirmLabel: 'Rendre publiques',
  }))) return
  await forEach(ids, (id) => store.setVisibilite(id, publique), publique ? 'vidéos publiques' : 'vidéos privées', publique ? 'Publication' : 'Passage en privé')
}
const updateTitles = (ids: readonly string[]) => forEach(ids, (id) => store.syncMetadata(id), 'titres mis à jour sur YouTube', 'Mise à jour des titres')
async function sendVignettes(ids: readonly string[]): Promise<void> {
  if (!(await confirmStore.ask({
    title: `Envoyer ${ids.length} vignette${ids.length > 1 ? 's' : ''} sur YouTube ?`,
    message: 'Elles remplacent celles en place, et se voient aussitôt sur les vidéos publiques.',
    confirmLabel: 'Envoyer',
  }))) return
  await store.envoyerVignettes([...ids]).catch(() => undefined)
}
const send = (ids: readonly string[]) => void store.send([...ids]).catch(() => undefined)
const generate = (ids: readonly string[]) => void store.genererVignettes([...ids]).catch(() => undefined)

/** Everything one video can take; what it cannot right now stays greyed. */
function actionsOf(job: MontageJobView): ActionMenuItem[] {
  const envoi = envoiOf(job.id)
  const onYoutube = envoi?.state === 'termine'
  const sending = envoi?.state === 'attente' || envoi?.state === 'en-cours'
  const vignette = vignetteOf(job.id)
  const drawing = vignette?.state === 'attente' || vignette?.state === 'calcul' || vignette?.state === 'envoi'
  const publique = envoi?.visibilite === 'public'
  return [
    { key: 'voir', label: 'Voir sur YouTube', href: envoi?.videoId == null ? undefined : `https://youtu.be/${envoi.videoId}`, disabled: envoi?.videoId == null },
    { key: 'envoyer', label: envoi == null ? 'Envoyer sur YouTube' : 'Renvoyer (crée une nouvelle vidéo)', disabled: sending, run: () => send([job.id]) },
    { key: 'visibilite', label: publique ? 'Rendre privée' : 'Rendre publique', disabled: !onYoutube || store.pending.has(`${job.id}:visibilite`), run: () => publish([job.id], !publique) },
    { key: 'titre', label: 'Mettre à jour le titre', disabled: !onYoutube || store.pending.has(`${job.id}:titre`), run: () => updateTitles([job.id]) },
    { key: 'generer', label: vignette == null ? 'Générer la vignette' : 'Redessiner la vignette', disabled: drawing || !onYoutube, run: () => generate([job.id]) },
    { key: 'apercu', label: 'Voir la vignette', href: vignetteImage(job.id) ?? undefined, disabled: vignetteImage(job.id) == null },
    { key: 'envoyer-vignette', label: 'Envoyer la vignette', disabled: vignette?.state !== 'prete', run: () => sendVignettes([job.id]) },
  ]
}
const playlistActions = computed<ActionMenuItem[]>(() => {
  const vignette = vignetteOf('playlist')
  return [
    { key: 'generer', label: vignette == null ? 'Générer l’image' : 'Redessiner l’image', disabled: vignette?.state === 'calcul' || vignette?.state === 'attente', run: () => generate(['playlist']) },
    { key: 'apercu', label: 'Voir l’image', href: vignetteImage('playlist') ?? undefined, disabled: vignetteImage('playlist') == null },
    { key: 'envoyer-vignette', label: 'Envoyer l’image', disabled: vignette?.state !== 'prete', run: () => sendVignettes(['playlist']) },
  ]
})

const playlistTitle = ref('')
const playlistPublique = ref(false)
const playlistBusy = ref(false)
watch(() => status.value?.playlist, (playlist) => {
  if (playlist == null) return
  playlistTitle.value = playlist.title
  playlistPublique.value = playlist.publique
}, { immediate: true })
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

const VIGNETTE_TONES = { attente: 'brand', calcul: 'brand', prete: 'warn', envoi: 'brand', envoyee: 'ok', echec: 'alert' } as const
const FIELD = 'rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text'
</script>

<template>
  <Panel id="vod-youtube" title="YouTube" class="col-span-full">
    <p v-if="status?.connected !== true" id="youtube-non-connecte" class="m-0 text-sm text-dim">
      Aucune chaîne connectée : à faire dans <a :href="settingsPath" class="text-brand underline">Réglages</a>.
    </p>
    <template v-else>
      <p class="m-0 mb-2 text-sm text-dim">Chaîne {{ status.channel ?? 'connectée' }}. Envoi en privé, une vidéo à la fois.</p>

      <form id="youtube-playlist" class="flex flex-wrap items-center gap-2 border-t border-edge py-2" @submit.prevent="syncPlaylist">
        <label class="sr-only" for="youtube-playlist-titre">Titre de la playlist</label>
        <input id="youtube-playlist-titre" v-model="playlistTitle" maxlength="150" placeholder="Titre de la playlist" class="min-w-48 flex-1" :class="FIELD">
        <label class="flex items-center gap-1.5 text-sm"><input v-model="playlistPublique" type="checkbox" class="w-auto"> Publique</label>
        <Spinner v-if="playlistBusy" /><Button type="submit" size="small" :disabled="playlistBusy || playlistTitle.trim() === '' || sent === 0"><StableLabel :current="status.playlist == null ? 'Créer la playlist' : 'Mettre à jour la playlist'" :labels="['Créer la playlist', 'Mettre à jour la playlist']" /></Button>
        <a v-if="status.playlist != null" :href="`https://www.youtube.com/playlist?list=${status.playlist.id}`" target="_blank" rel="noopener" class="text-sm text-brand underline" data-role="playlist">Voir ({{ status.playlist.videos }} vidéos)</a>
        <img v-if="vignetteImage('playlist') != null" :src="vignetteImage('playlist')!" alt="Image de la playlist" class="h-9 w-16 rounded object-cover" data-role="apercu-playlist">
        <StatusIcon name="image" :spin="['attente', 'calcul', 'envoi'].includes(vignetteOf('playlist')?.state ?? '')" :tone="vignetteOf('playlist') == null ? 'off' : VIGNETTE_TONES[vignetteOf('playlist')!.state]" :label="`Image de la playlist : ${vignetteOf('playlist') == null ? 'aucune' : VIGNETTE_LABELS[vignetteOf('playlist')!.state].label}`" />
        <ActionMenu :items="playlistActions" label="Actions de la playlist" />
        <span v-if="vignetteOf('playlist')?.erreur != null" class="basis-full text-xs break-words text-alert">{{ vignetteOf('playlist')!.erreur }}</span>
      </form>

      <Empty v-if="videos.length === 0">Aucune vidéo terminée.</Empty>
      <template v-else>
        <div class="sticky top-0 z-10 flex min-h-11 flex-wrap items-center gap-2 border-t border-edge bg-surface py-1.5" data-role="selection">
          <label class="mr-auto flex items-center gap-2 text-sm">
            <input id="youtube-tout" type="checkbox" class="w-auto" :checked="allChosen" :indeterminate.prop="chosen.length > 0 && !allChosen" @change="toggleAll">
            <template v-if="chosen.length === 0">Tout sélectionner ({{ videos.length }} vidéos)</template>
            <template v-else>{{ chosen.length }} sélectionnée{{ chosen.length > 1 ? 's' : '' }}</template>
          </label>
          <span v-if="progress != null" class="flex items-center gap-1.5 text-sm" role="status" data-role="progression"><Spinner /> {{ progress.label }} : {{ progress.done }}/{{ progress.total }}</span>
          <template v-if="chosen.length > 0">
            <Button size="small" data-bulk="envoyer" :disabled="busy || possible.envoyer.length === 0" @click="send(possible.envoyer)">Envoyer ({{ possible.envoyer.length }})</Button>
            <Button size="small" data-bulk="publier" :disabled="busy || possible.publier.length === 0" @click="publish(possible.publier, true)">Rendre publiques ({{ possible.publier.length }})</Button>
            <Button size="small" data-bulk="depublier" :disabled="busy || possible.depublier.length === 0" @click="publish(possible.depublier, false)">Rendre privées ({{ possible.depublier.length }})</Button>
            <Button size="small" data-bulk="titres" :disabled="busy || possible.titres.length === 0" @click="updateTitles(possible.titres)">Mettre à jour les titres ({{ possible.titres.length }})</Button>
            <Button size="small" data-bulk="generer" :disabled="busy || possible.generer.length === 0" @click="generate(possible.generer)">Générer les vignettes ({{ possible.generer.length }})</Button>
            <Button size="small" data-bulk="envoyer-vignettes" :disabled="busy || possible.envoyerVignettes.length === 0" @click="sendVignettes(possible.envoyerVignettes)">Envoyer les vignettes ({{ possible.envoyerVignettes.length }})</Button>
          </template>
        </div>
        <div v-for="job in videos" :key="job.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-edge py-2 text-sm" :data-youtube="job.id">
          <input type="checkbox" class="w-auto flex-none" :checked="selected.has(job.id)" :aria-label="`Sélectionner : ${job.nomVideo}`" data-role="choisir" @change="toggleOne(job.id)">
          <a v-if="vignetteImage(job.id) != null" :href="vignetteImage(job.id)!" target="_blank" rel="noopener" class="flex-none" data-role="apercu"><img :src="vignetteImage(job.id)!" :alt="`Vignette : ${job.nomVideo}`" class="h-9 w-16 rounded object-cover"></a>
          <span class="min-w-0 flex-1 basis-60">{{ job.nomVideo }}</span>
          <YoutubeStatusIcons :job-id="job.id" />
          <ActionMenu :items="actionsOf(job)" :label="`Actions : ${job.nomVideo}`" />
          <span v-if="envoiOf(job.id)?.erreur != null" class="basis-full text-xs break-words text-alert">{{ envoiOf(job.id)!.erreur }}</span>
          <span v-if="vignetteOf(job.id)?.erreur != null" class="basis-full text-xs break-words text-alert">Vignette : {{ vignetteOf(job.id)!.erreur }}</span>
        </div>
      </template>
    </template>
  </Panel>
</template>
