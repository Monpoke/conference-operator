<script setup lang="ts">
import { Button, Panel, useToast } from '@conference-operator/components'
import type { MontageAnalyse, MontageJobView } from '@conference-operator/contract'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import MontageTimeline from '../components/MontageTimeline.vue'
import { formatOrateurs, habillageFromForm, useConferencesStore } from '../stores/conferences.js'
import {
  MONTAGE_STATES,
  cutMinutes,
  describe,
  latestByTake,
  montagePath,
  parseTimecode,
  partAt,
  timecode,
  useMontageStore,
  type TakePart,
} from '../stores/montage.js'
import { listeningGainDb, type Niveaux } from '../stores/timeline.js'

/**
 * A take's montage: hear it, place its cut, say what its video shows, send it.
 *
 * The rush itself plays here, picture and sound, from any moment to its end: a
 * cut is judged by ear, and on the talk's own words rather than on an excerpt.
 */
const props = defineProps<{ sessionId: string; prise?: string | null }>()

const montages = useMontageStore()
const conferences = useConferencesStore()
const { jobs } = storeToRefs(montages)
const toast = useToast()

const session = computed(() => conferences.planning?.sessions.find((candidate) => candidate.id === props.sessionId) ?? null)
const prises = computed(() => latestByTake(jobs.value.filter((job) => job.sessionId === props.sessionId)))
const chosenTake = ref<string | null>(props.prise ?? null)
const job = computed<MontageJobView | null>(() =>
  prises.value.find((candidate) => candidate.sidecarUploadId === chosenTake.value) ?? prises.value.at(-1) ?? null,
)
/** The next cut waiting for somebody: validating several takes in a row is the usual evening. */
const nextToValidate = computed(() => jobs.value.find((candidate) => candidate.state === 'a-valider' && candidate.id !== job.value?.id) ?? null)

function choose(candidate: MontageJobView): void {
  chosenTake.value = candidate.sidecarUploadId
  window.history.replaceState(window.history.state, '', montagePath(props.sessionId, candidate.sidecarUploadId))
}

const consent = ref<{ text: string; tone: string } | null>(null)
const loaded = ref(false)

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  try {
    await Promise.all([montages.load(), conferences.planning == null ? conferences.load() : Promise.resolve()])
  } catch {
    /* already reported by the client's error hook */
  } finally {
    loaded.value = true
  }
  const folder = (await conferences.vodFolder(props.sessionId).catch(() => null)) as { consentementYoutube?: { statut: string } | null } | null
  const statut = folder?.consentementYoutube?.statut
  if (statut === 'accorde') consent.value = { text: 'Diffusion accordée par le conférencier', tone: 'text-ok' }
  else if (statut != null) consent.value = { text: 'Diffusion refusée par le conférencier : ne pas publier', tone: 'text-alert' }
  else consent.value = { text: 'Diffusion : réponse du conférencier inconnue', tone: 'text-warn' }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  player.value?.pause()
})

/* ---------- The player's state: everything below moves it ---------- */
const player = ref<HTMLVideoElement | null>(null)
const timeline = ref<InstanceType<typeof MontageTimeline> | null>(null)
const positionMs = ref(0)
const playing = ref(false)
const speed = ref(1)
const volume = ref(1)
/** On each side of a cut: enough to hear a sentence begin or end. */
const LISTEN_MS = 5_000
let partIndex = -1
let stopAtMs: number | null = null

/* ---------- The analysis ---------- */
const analyse = ref<MontageAnalyse | null>(null)
const files = ref<Record<string, string>>({})
const parts = ref<TakePart[]>([])
const niveaux = ref<Niveaux | null>(null)
const analysisError = ref('')
const debutMs = ref(0)
const finMs = ref(0)
const debutText = ref('')
const finText = ref('')
const saving = ref(false)

const takeMs = computed(() => analyse.value?.takeMs ?? 1)
const keptMs = computed(() => finMs.value - debutMs.value)
const canValidate = computed(() => job.value != null && ['a-valider', 'termine', 'echoue'].includes(job.value.state))

watch(
  () => [job.value?.id, job.value?.phase, job.value?.state === 'attente' || job.value?.state === 'en-cours'] as const,
  async ([jobId]) => {
    pause()
    if (jobId == null) return
    analysisError.value = ''
    try {
      const view = await montages.analysis(jobId)
      if (job.value?.id !== jobId) return
      analyse.value = view.analyse
      files.value = Object.fromEntries(view.fichiers.map((file) => [file.nom, file.url]))
      parts.value = view.prise
      partIndex = -1
      niveaux.value = view.niveaux ?? null
      if (view.analyse != null) reset(view.analyse)
      gainDb.value = listeningGainDb(view.analyse?.audio?.lufsAvant)
    } catch (cause) {
      analysisError.value = cause instanceof Error ? cause.message : 'Lecture impossible.'
    }
  },
  { immediate: true },
)

function reset(value: MontageAnalyse): void {
  const cut = job.value?.coupe ?? value.proposition
  finMs.value = 0
  set('debut', cut.debutMs)
  set('fin', cut.finMs)
}

function set(which: 'debut' | 'fin', ms: number): void {
  const clamped = Math.round(Math.min(takeMs.value, Math.max(0, ms)))
  if (which === 'debut') {
    debutMs.value = Math.min(clamped, finMs.value > 0 ? finMs.value - 1_000 : clamped)
    debutText.value = timecode(debutMs.value)
  } else {
    finMs.value = Math.max(clamped, debutMs.value + 1_000)
    finText.value = timecode(finMs.value)
  }
}

function typed(which: 'debut' | 'fin'): void {
  const ms = parseTimecode(which === 'debut' ? debutText.value : finText.value)
  if (ms == null) {
    toast.fail('Temps illisible : écrire mm:ss,d ou h:mm:ss,d.')
    set(which, which === 'debut' ? debutMs.value : finMs.value)
    return
  }
  set(which, ms)
}

const cutOf = (which: 'debut' | 'fin') => (which === 'debut' ? debutMs.value : finMs.value)

/* ---------- The player ---------- */

watch(speed, (value) => {
  if (player.value != null) player.value.playbackRate = value
})
watch(volume, (value) => {
  if (player.value != null) player.value.volume = value
})

/*
 * Rushes are recorded far too low for their video: the element's volume stops at
 * the rush's own level, so the sound goes through a gain, and a limiter for the
 * applause that a gain of 25 dB would otherwise throw at the listener.
 */
const gainDb = ref(0)
let audio: { context: AudioContext; gain: GainNode; element: HTMLVideoElement } | null = null
const toLinear = (db: number) => 10 ** (db / 20)

function connectSound(): void {
  const video = player.value
  if (video == null || typeof AudioContext === 'undefined') return
  if (audio?.element !== video) {
    const context = audio?.context ?? new AudioContext()
    const source = context.createMediaElementSource(video)
    const gain = context.createGain()
    const limiter = context.createDynamicsCompressor()
    limiter.threshold.value = -3
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.003
    limiter.release.value = 0.1
    source.connect(gain).connect(limiter).connect(context.destination)
    audio = { context, gain, element: video }
  }
  audio.gain.gain.value = toLinear(gainDb.value)
  void audio.context.resume()
}
watch(gainDb, (value) => {
  if (audio != null) audio.gain.gain.value = toLinear(value)
})

/** The take's file, from the hub: the only address whose sound the page may amplify. */
const partUrl = (index: number) => `/montage/prise/${encodeURIComponent(job.value?.id ?? '')}/${index}`

/** Goes to `ms` of the take: its own file, at its own place in that file. */
function goTo(ms: number, thenPlay: boolean): void {
  const video = player.value
  const clamped = Math.min(takeMs.value, Math.max(0, ms))
  positionMs.value = clamped
  const index = Math.max(0, partAt(parts.value, clamped))
  const part = parts.value[index]
  if (video == null || part == null) return
  const local = (clamped - part.offsetMs) / 1000
  if (index === partIndex && video.readyState > 0) {
    video.currentTime = local
  } else {
    partIndex = index
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = local
      video.playbackRate = speed.value
    }, { once: true })
    video.src = partUrl(index)
    video.load()
  }
  // Inside the click, not after the load: a browser refuses to start sound later on.
  if (thenPlay) connectSound()
  if (thenPlay) video.play().catch(() => undefined)
}

function pause(): void {
  stopAtMs = null
  player.value?.pause()
}

function toggle(): void {
  if (playing.value) pause()
  else goTo(positionMs.value, true)
}

function listen(which: 'debut' | 'fin'): void {
  const at = cutOf(which)
  stopAtMs = Math.min(takeMs.value, at + LISTEN_MS)
  timeline.value?.focus(at)
  goTo(at - LISTEN_MS, true)
}

function onTime(): void {
  const video = player.value
  const part = parts.value[partIndex]
  if (video == null || part == null) return
  positionMs.value = part.offsetMs + video.currentTime * 1000
  if (stopAtMs != null && positionMs.value >= stopAtMs) pause()
}

/** A take split by OBS goes on in its next file. */
function onEnded(): void {
  const next = parts.value[partIndex + 1]
  if (next != null) goTo(next.offsetMs, true)
}

function onPlayerError(): void {
  if (!player.value?.getAttribute('src')) return
  toast.fail('Lecture du rush impossible : recharger la page pour une adresse fraîche, ou vérifier le format du fichier.')
}

/* The keys of a montage table: both hands stay on the sound, not on the buttons. */
function onKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target != null && (['INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY'].includes(target.tagName) || target.getAttribute?.('role') === 'slider')) return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  const step = event.shiftKey ? 100 : 1_000
  if (event.key === ' ' && target?.tagName !== 'BUTTON' && target?.tagName !== 'A') toggle()
  else if (event.key === 'ArrowLeft') goTo(positionMs.value - step, playing.value)
  else if (event.key === 'ArrowRight') goTo(positionMs.value + step, playing.value)
  else if (event.key === 'i' || event.key === 'I') set('debut', positionMs.value)
  else if (event.key === 'o' || event.key === 'O') set('fin', positionMs.value)
  else if (event.key === '+' || event.key === '=') timeline.value?.zoomBy(0.5)
  else if (event.key === '-') timeline.value?.zoomBy(2)
  else return
  event.preventDefault()
}

/* ---------- What the video shows ---------- */
const habillage = ref({ title: '', category: '', color: '', salle: '', speakers: '' })
watch(
  () => job.value?.sidecarUploadId,
  () => {
    const prise = job.value?.habillagePrise
    habillage.value = {
      title: prise?.title ?? '',
      category: prise?.category ?? '',
      color: prise?.color ?? '',
      salle: prise?.salle ?? '',
      speakers: formatOrateurs(prise?.speakers ?? []),
    }
  },
  { immediate: true },
)

async function attempt(gesture: () => Promise<unknown>, done: string): Promise<void> {
  try {
    await gesture()
    if (done !== '') toast.say(done)
  } catch {
    /* already reported by the client's error hook */
  }
}

const saveHabillage = () =>
  attempt(async () => {
    if (job.value == null) return
    await conferences.setHabillagePrise(job.value.sidecarUploadId, habillageFromForm(habillage.value))
    await montages.load()
  }, 'Habillage enregistré')

const previewUrl = (clip: 'intro' | 'outro' | 'cadre') =>
  `/montage/apercu/${encodeURIComponent(props.sessionId)}?clip=${clip}${job.value == null ? '' : `&prise=${encodeURIComponent(job.value.sidecarUploadId)}`}`

async function validate(): Promise<void> {
  if (job.value == null) return
  saving.value = true
  pause()
  await attempt(() => montages.validate(job.value!.id, debutMs.value, finMs.value), 'Coupe validée : le montage part')
  saving.value = false
}

const CONFIDENCE_TONE: Record<string, string> = { haute: 'text-ok', moyenne: 'text-warn', basse: 'text-alert' }
const stateOf = (candidate: MontageJobView) => MONTAGE_STATES[candidate.state] ?? { label: candidate.state, tone: '' }
const FIELD = 'mt-1 w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text'
</script>

<template>
  <div id="montage-view" class="flex flex-col gap-3">
    <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <a href="/admin/vod" class="text-sm text-brand underline" data-role="montage-retour">VOD</a>
      <h1 class="text-lg font-semibold">{{ job?.habillagePrise?.title ?? session?.title ?? job?.title ?? 'Montage' }}</h1>
      <span class="text-sm text-dim">{{ session?.roomName }}<template v-if="session != null && session.speakers.length > 0"> · {{ session.speakers.join(', ') }}</template></span>
      <span v-if="job != null" class="text-sm" :class="stateOf(job).tone" data-role="montage-etat">
        {{ stateOf(job).label }}<template v-if="describe(job) !== ''"> · {{ describe(job) }}</template>
      </span>
      <div v-if="prises.length > 1" class="ml-auto flex flex-wrap gap-1.5" data-role="montage-prises">
        <Button
          v-for="(candidate, index) in prises"
          :key="candidate.sidecarUploadId"
          size="small"
          :active="candidate.sidecarUploadId === job?.sidecarUploadId"
          @click="choose(candidate)"
        >
          Prise {{ index + 1 }}<template v-if="cutMinutes(candidate) != null"> · {{ cutMinutes(candidate) }} min</template>
        </Button>
      </div>
    </header>

    <p v-if="!loaded" class="text-dim">Lecture…</p>
    <p v-else-if="job == null" class="text-dim" data-role="montage-vide">
      Pas encore de montage pour ce talk : il se met en file quand sa prise arrive dans le stockage.
    </p>
    <p v-else-if="analysisError !== ''" class="text-alert">{{ analysisError }}</p>
    <p v-else-if="analyse == null" class="text-dim" data-role="montage-sans-analyse">
      Analyse pas encore faite : la coupe se règle ici dès que le worker l’a terminée.
    </p>

    <template v-else>
      <div class="grid items-start gap-3.5 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        <section class="min-w-0">
          <video
            ref="player"
            preload="metadata"
            class="aspect-video max-h-[max(220px,calc(100dvh-500px))] w-full rounded-lg bg-black"
            :src="parts.length > 0 ? partUrl(0) : undefined"
            @loadedmetadata="partIndex = partIndex < 0 ? 0 : partIndex"
            @play="playing = true"
            @pause="playing = false"
            @timeupdate="onTime"
            @ended="onEnded"
            @error="onPlayerError"
          />
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <Button size="small" variant="primary" data-role="lecture" :disabled="parts.length === 0" @click="toggle">
              {{ playing ? 'Pause' : 'Lecture' }}
            </Button>
            <Button size="small" @click="goTo(positionMs - 5000, playing)">−5 s</Button>
            <Button size="small" @click="goTo(positionMs + 5000, playing)">+5 s</Button>
            <span class="ml-1 text-sm tabular-nums" data-role="position">{{ timecode(positionMs) }} <span class="text-dim">/ {{ timecode(takeMs) }}</span></span>
            <label class="ml-auto flex items-center gap-1.5 text-xs text-dim">
              Volume
              <input v-model.number="volume" type="range" min="0" max="1" step="0.05" class="w-20">
            </label>
            <label class="flex items-center gap-1.5 text-xs text-dim">
              Gain
              <input v-model.number="gainDb" data-role="gain" type="range" min="0" max="30" step="1" class="w-24">
              <span class="w-11 tabular-nums text-text">+{{ gainDb }} dB</span>
            </label>
            <label class="flex items-center gap-1.5 text-xs text-dim">
              Vitesse
              <select v-model.number="speed" class="rounded border border-edge bg-canvas px-1.5 py-1 text-text">
                <option :value="1">×1</option>
                <option :value="1.5">×1,5</option>
                <option :value="2">×2</option>
              </select>
            </label>
          </div>
          <p v-if="parts.length === 0" class="mt-1 text-xs text-warn">Le rush de cette prise n’a pas pu être lu : la coupe reste réglable sur l’audiogramme.</p>
        </section>

        <aside class="flex min-w-0 flex-col gap-3">
          <Panel title="Décision">
            <p class="text-sm">
              Confiance <strong :class="CONFIDENCE_TONE[analyse.confiance]">{{ analyse.confiance }}</strong>
              <span v-if="analyse.audio != null" class="text-dim">
                · son {{ analyse.audio.lufsAvant.toFixed(1) }} LUFS{{ analyse.audio.quasiMuet ? ' (quasi absent)' : ` → ${analyse.audio.lufsApres}` }}
              </span>
            </p>
            <ul v-if="analyse.raisons.length > 0" class="mt-1 list-disc pl-5 text-xs text-dim">
              <li v-for="raison in analyse.raisons" :key="raison">{{ raison }}</li>
            </ul>
            <p v-if="consent != null" class="mt-1.5 text-xs" :class="consent.tone" data-role="montage-consent">{{ consent.text }}</p>
            <p v-if="job?.erreur != null && job.state === 'echoue'" class="mt-1.5 text-xs break-all text-alert">{{ job.erreur }}</p>

            <div class="mt-3 flex flex-wrap gap-1.5">
              <Button v-if="canValidate" size="small" variant="primary" data-role="valider" :disabled="saving" @click="validate">
                {{ job?.state === 'a-valider' ? 'Valider et monter' : 'Remonter avec cette coupe' }}
              </Button>
              <Button size="small" data-role="proposition" @click="reset(analyse)">Revenir à la proposition</Button>
              <Button v-if="job?.state === 'termine'" size="small" data-role="telecharger" @click="attempt(() => montages.download(job!.id), '')">Télécharger</Button>
              <Button
                v-if="job?.state === 'attente' || job?.state === 'en-cours'"
                size="small"
                variant="danger"
                @click="attempt(() => montages.cancel(job!.id), 'Montage annulé')"
              >
                Annuler
              </Button>
              <Button v-else size="small" data-role="relancer" @click="attempt(() => montages.relaunch(sessionId, job!.id), 'Analyse relancée')">Relancer l’analyse</Button>
            </div>
            <a
              v-if="nextToValidate != null"
              :href="montagePath(nextToValidate.sessionId, nextToValidate.sidecarUploadId)"
              class="mt-2 inline-block text-sm text-brand underline"
              data-role="suivant"
            >Coupe suivante à valider : {{ nextToValidate.title ?? nextToValidate.sessionId }}</a>
          </Panel>

          <Panel title="Habillage de la vidéo">
            <details :open="job?.habillagePrise != null" data-role="habillage">
              <summary class="cursor-pointer text-sm">{{ job?.habillagePrise != null ? 'Personnalisé pour cette prise' : 'Celui du programme' }}</summary>
              <div class="mt-2 flex flex-col gap-2">
                <label class="text-xs text-dim">Titre<input v-model="habillage.title" data-field="title" :class="FIELD" :placeholder="session?.title"></label>
                <label class="text-xs text-dim">Orateurs (un par ligne : Nom | Société)
                  <textarea v-model="habillage.speakers" data-field="speakers" rows="2" :class="FIELD" :placeholder="session?.speakers.join('\n')" />
                </label>
                <div class="grid grid-cols-2 gap-2">
                  <label class="text-xs text-dim">Catégorie<input v-model="habillage.category" data-field="category" :class="FIELD"></label>
                  <label class="text-xs text-dim">Couleur<input v-model="habillage.color" data-field="color" :class="FIELD" placeholder="#9cc160"></label>
                </div>
                <label class="text-xs text-dim">Salle<input v-model="habillage.salle" data-field="salle" :class="FIELD" :placeholder="session?.roomName ?? ''"></label>
                <div><Button size="small" data-role="habillage-save" @click="saveHabillage">Enregistrer l’habillage</Button></div>
                <p class="text-[11px] text-dim">Un champ vide reprend le programme. Un champ rempli redessine le cadre sur toute la vidéo.</p>
              </div>
            </details>
            <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
              <a :href="previewUrl('intro')" target="_blank" rel="noopener" class="text-brand underline">Intro</a>
              <a :href="previewUrl('outro')" target="_blank" rel="noopener" class="text-brand underline">Outro</a>
              <a :href="previewUrl('cadre')" target="_blank" rel="noopener" class="text-brand underline" data-role="apercu-cadre">Cadre</a>
            </div>
          </Panel>
        </aside>
      </div>

      <!-- At the foot of the screen, always in reach: everything above serves what is decided here. -->
      <section class="bottom-0 z-20 rounded-xl lg:sticky border border-edge bg-surface p-3" aria-label="Coupe">
        <div class="mb-2 flex flex-wrap items-end gap-x-5 gap-y-2">
          <div v-for="side in (['debut', 'fin'] as const)" :key="side" class="flex flex-wrap items-end gap-1" :data-cut="side">
            <label class="text-xs font-semibold" :class="side === 'debut' ? 'text-ok' : 'text-alert'">
              {{ side === 'debut' ? 'Début' : 'Fin' }}
              <input
                v-if="side === 'debut'"
                v-model="debutText"
                class="mt-1 block w-28 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm font-normal tabular-nums text-text"
                @change="typed('debut')"
              >
              <input
                v-else
                v-model="finText"
                class="mt-1 block w-28 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm font-normal tabular-nums text-text"
                @change="typed('fin')"
              >
            </label>
            <Button size="small" aria-label="Reculer d’une seconde" @click="set(side, cutOf(side) - 1000)">−1 s</Button>
            <Button size="small" aria-label="Reculer d’un dixième" @click="set(side, cutOf(side) - 100)">−0,1</Button>
            <Button size="small" aria-label="Avancer d’un dixième" @click="set(side, cutOf(side) + 100)">+0,1</Button>
            <Button size="small" aria-label="Avancer d’une seconde" @click="set(side, cutOf(side) + 1000)">+1 s</Button>
            <Button size="small" :data-listen="side" :disabled="parts.length === 0" @click="listen(side)">Écouter ±5 s</Button>
            <Button size="small" :data-here="side" @click="set(side, positionMs)">Ici</Button>
          </div>
          <p class="ml-auto text-sm tabular-nums" data-role="duree-gardee">Vidéo : <strong>{{ timecode(keptMs) }}</strong></p>
        </div>

        <MontageTimeline
          ref="timeline"
          :take-ms="takeMs"
          :niveaux="niveaux"
          :image-url="files['forme.png'] ?? null"
          :debut-ms="debutMs"
          :fin-ms="finMs"
          :position-ms="positionMs"
          @debut="set('debut', $event)"
          @fin="set('fin', $event)"
          @seek="goTo($event, playing)"
        />
        <p class="mt-1.5 text-[11px] text-dim max-md:hidden">
          Molette : zoom · Glisser : se déplacer · Clic : placer la lecture · Espace : lecture · ← → : 1 s (Maj : 0,1 s) · I / O : début / fin ici
        </p>
      </section>
    </template>
  </div>
</template>
