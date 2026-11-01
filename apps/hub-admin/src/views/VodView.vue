<script setup lang="ts">
import { Button, Hint, Panel, useToast, StableLabel } from '@conference-operator/components'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import {
  ETATS,
  UPLOAD_STATES,
  countByEtat,
  progress,
  useVodStore,
  type Upload,
} from '../stores/vod.js'
import { MONTAGE_STATES, cutMinutes, describe, latestByTake, montagePath, useMontageStore } from '../stores/montage.js'
import type { MontageJobView } from '@conference-operator/contract'
import { dayKeyOf, dayOptions } from '../stores/days.js'

/**
 * Uploads of the takes.
 *
 * The console's only view that is looked at at a precise moment of the day: just
 * before dismantling a room, while its disk is still plugged in.
 */
const store = useVodStore()
const { conferences, rooms, room, planning } = storeToRefs(store)
const toast = useToast()

const roomOptions = computed(() => [
  { value: '', label: 'Toutes les salles' },
  ...rooms.value.map((room) => ({ value: room.id, label: room.name })),
])

watch(room, () => void store.load())

/** Files are unfolded on demand, and stay so across the periodic refresh. */
const unfolded = ref(new Set<string>())
function toggle(key: string): void {
  if (!unfolded.value.delete(key)) unfolded.value.add(key)
}

const montages = useMontageStore()
const { jobs, enPause } = storeToRefs(montages)
const running = computed(() => jobs.value.some((job) => job.state === 'en-cours'))
const queued = computed(() => jobs.value.filter((job) => job.state === 'attente').length)
const inProgress = computed(() => jobs.value.filter((job) => job.state === 'en-cours'))

async function togglePause(): Promise<void> {
  const next = !enPause.value
  try {
    await montages.setPause(next)
    toast.say(next ? 'Rendus en pause' : 'Rendus repris')
  } catch {
    /* already reported by the client's error hook */
  }
}
/** Each talk's takes, with where their video stands. */
const takesOf = computed(() => {
  const bySession = new Map<string, MontageJobView[]>()
  for (const job of jobs.value) bySession.set(job.sessionId, [...(bySession.get(job.sessionId) ?? []), job])
  return new Map([...bySession].map(([sessionId, list]) => [sessionId, latestByTake(list)]))
})
const toValidate = computed(() => jobs.value.filter((job) => job.state === 'a-valider'))
const firstToValidate = computed(() => toValidate.value.at(-1) ?? null)
const asksForAttention = (sessionId: string) =>
  takesOf.value.get(sessionId)?.some((job) => ['a-valider', 'echoue', 'attente', 'en-cours'].includes(job.state)) ?? false

/** By default, only what still asks for attention: the list shrinks as the day goes. */
const onlyToHandle = ref(true)
const zone = computed(() => planning.value?.timezone ?? 'Europe/Paris')
const day = ref('')
const days = computed(() => dayOptions(conferences.value.map((row) => row.startsAt), zone.value))
/*
 * The summary and the verdict above keep counting every day: « tout est téléversé »
 * must not be read from a filter that hides another day's missing rush.
 */
const shown = computed(() =>
  conferences.value.filter(
    (row) =>
      (day.value === '' || (row.startsAt != null && dayKeyOf(row.startsAt, zone.value) === day.value)) &&
      (!onlyToHandle.value || row.etat === 'a-reprendre' || row.etat === 'en-cours' || asksForAttention(row.key)),
  ),
)

const stateOfJob = (job: MontageJobView) => MONTAGE_STATES[job.state] ?? { label: job.state, tone: '' }

const counts = computed(() => countByEtat(conferences.value))
const summary = computed(() => {
  const { 'a-reprendre': toResume, 'en-cours': running, 'a-venir': upcoming, complet: complete } = counts.value
  const parts = [
    `${conferences.value.length} conférence${conferences.value.length > 1 ? 's' : ''}`,
    `${complete} complète${complete > 1 ? 's' : ''}`,
    `${toResume} à reprendre`,
    `${running} en cours`,
    `${upcoming} à venir`,
  ]
  const none = counts.value['sans-captation']
  if (none > 0) parts.push(`${none} sans captation`)
  return parts.join(' · ')
})

/** The question asked before dismantling a room, answered for the room chosen. */
const verdict = computed<{ text: string; tone: string } | null>(() => {
  const name = rooms.value.find((candidate) => candidate.id === room.value)?.name
  if (name == null || conferences.value.length === 0) return null
  const { 'a-reprendre': toResume, 'en-cours': running, 'a-venir': upcoming } = counts.value
  if (toResume > 0) {
    return { text: `${name} : ${toResume} conférence${toResume > 1 ? 's' : ''} à reprendre`, tone: 'text-alert' }
  }
  if (running > 0) return { text: `${name} : ${running} en cours, à attendre`, tone: '' }
  if (upcoming > 0) return { text: `${name} : ${upcoming} à venir`, tone: 'text-dim' }
  if (counts.value.complet === 0) return { text: `${name} : pas de captation prévue`, tone: 'text-dim' }
  return { text: `${name} : tout est téléversé`, tone: 'text-ok' }
})

function stateOf(upload: Upload): { label: string; tone: string } {
  return UPLOAD_STATES[upload.state] ?? { label: upload.state, tone: '' }
}

/** The current rate, in kB/s — the unit in which one judges whether it is moving. */
function rate(upload: Upload): string {
  return upload.debitOctetsS == null ? '' : ` · ${Math.round(upload.debitOctetsS / 1024)} Ko/s`
}

async function requestUpload(roomId: string, file: string | null): Promise<void> {
  try {
    await store.request(roomId, file)
    toast.say(file == null ? 'Rapatriement demandé' : 'Relance demandée')
  } catch {
    /* already reported by the client's error hook */
  }
}

/**
 * Everything not yet uploaded, from the room chosen — or from every room.
 *
 * The hub only knows how to ask one machine: the request is a command addressed to
 * a room, which a disconnected room catches up on reconnection. "Toutes les salles"
 * is therefore one request per room, and the operator is told how many went out
 * and which failed — at the end of the day, a room left behind is a disk
 * dismantled with its rushes still on it.
 */
async function requestAll(): Promise<void> {
  if (room.value !== '') {
    await requestUpload(room.value, null)
    return
  }
  const targets = rooms.value
  if (targets.length === 0) {
    toast.fail('Aucune salle à rapatrier.')
    return
  }
  const results = await Promise.allSettled(targets.map((target) => store.request(target.id, null)))
  const failed = targets.filter((_, index) => results[index]!.status === 'rejected')
  const asked = targets.length - failed.length
  if (failed.length === 0) {
    toast.say(`Rapatriement demandé à ${asked} salle${asked > 1 ? 's' : ''}`)
  } else {
    toast.fail(
      `Rapatriement demandé à ${asked} salle${asked > 1 ? 's' : ''} sur ${targets.length} — échec : ${failed.map((target) => target.name).join(', ')}`,
    )
  }
}
</script>

<template>
  <div
    id="vod-view"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-3.5"
  >
    <!-- Across the width, like the montages: a table of six columns needs it. -->
    <Panel title="Talks" class="col-span-full">
      <div class="mb-2 flex flex-wrap gap-1.5">
        <select
          id="vod-room"
          v-model="room"
          class="min-w-[150px] flex-1 rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
        >
          <option v-for="room in roomOptions" :key="room.value" :value="room.value">
            {{ room.label }}
          </option>
        </select>
        <select id="vod-day" v-model="day" class="min-w-[130px] rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text" aria-label="Jour affiché">
          <option value="">Tous les jours</option>
          <option v-for="option in days" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <Button id="btn-vod-retry" size="small" @click="requestAll">Tout relancer</Button>
      </div>

      <p id="vod-summary" class="mb-2 text-sm text-dim">
        <strong v-if="verdict != null" id="vod-verdict" class="mr-2 font-semibold" :class="verdict.tone">{{ verdict.text }}</strong>
        <span>{{ summary }}</span>
      </p>

      <p v-if="firstToValidate != null" id="montage-a-valider" class="mb-2 text-sm text-warn">
        {{ toValidate.length }} coupe{{ toValidate.length > 1 ? 's' : '' }} à valider —
        <a :href="montagePath(firstToValidate.sessionId, firstToValidate.sidecarUploadId)" class="underline">commencer</a>
      </p>
      <div class="mb-2 flex flex-wrap items-center gap-2 text-sm" data-role="montage-pause">
        <Button id="btn-montage-pause" size="small" :aria-pressed="enPause" @click="togglePause">
          <StableLabel :current="enPause ? 'Reprendre les rendus' : 'Mettre les rendus en pause'" :labels="['Reprendre les rendus', 'Mettre les rendus en pause']" />
        </Button>
        <span v-if="enPause" class="text-warn">
          En pause{{ running ? ' : le montage en cours se termine, rien d’autre ne démarre' : ' : aucun montage ne démarre' }}{{ queued > 0 ? ` · ${queued} en attente` : '' }}
        </span>
        <span v-else-if="running || queued > 0" class="text-dim">
          {{ inProgress.length > 1 ? `${inProgress.length} montages en cours` : running ? 'Un montage en cours' : 'Aucun montage en cours' }}{{ queued > 0 ? ` · ${queued} en attente` : '' }}
        </span>
      </div>
      <ul v-if="inProgress.length > 0" id="montages-en-cours" class="m-0 mb-3 flex list-none flex-col gap-2 p-0">
        <li v-for="job in inProgress" :key="job.id" class="rounded-lg border border-edge p-2.5 text-sm" :data-montage-en-cours="job.id">
          <div class="flex flex-wrap items-baseline justify-between gap-x-3">
            <a :href="montagePath(job.sessionId, job.sidecarUploadId)" class="min-w-0 font-semibold underline-offset-2 hover:underline">{{ job.title ?? job.sessionId }}</a>
            <span class="text-xs text-dim" :class="job.silencieuxDepuisMs != null ? 'text-warn' : ''" data-role="avancee">{{ describe(job) }}</span>
          </div>
          <div
            class="mt-1.5 h-2 rounded-full bg-surface2"
            role="progressbar"
            :aria-label="`Avancée du montage : ${job.title ?? job.sessionId}`"
            :aria-valuenow="job.pourcent"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div class="h-2 rounded-full transition-[width] duration-500" :class="job.silencieuxDepuisMs != null ? 'bg-warn' : 'bg-brand'" :style="{ width: `${job.pourcent}%` }" />
          </div>
        </li>
      </ul>
      <label class="mb-2 flex w-fit items-center gap-2 text-sm">
        <input id="vod-only-to-handle" v-model="onlyToHandle" type="checkbox">
        À traiter seulement
      </label>

      <div class="overflow-x-auto">
        <!--
          Under 768 px a talk is a card, as on the Conferences page: its title
          across the width, then the room, the state, the files and the button. Same
          markup, other classes: the table stays a table beyond.
        -->
        <table class="w-full border-collapse text-[13px] max-md:block">
          <thead class="max-md:hidden">
            <tr class="text-[11px] tracking-[.08em] text-dim uppercase">
              <th class="pr-2.5 pb-2 text-left font-semibold">Conférence</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Salle</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">État</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Fichiers</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Détail</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Montage</th>
              <th class="pb-2"></th>
            </tr>
          </thead>
          <tbody id="vod-rows" class="max-md:block">
            <tr v-if="conferences.length === 0" class="max-md:block">
              <td colspan="7" class="py-3.5 text-dim max-md:block">Aucun téléversement.</td>
            </tr>
            <tr v-else-if="shown.length === 0" class="max-md:block">
              <td colspan="7" class="py-3.5 text-dim max-md:block">Rien à traiter pour l'instant.</td>
            </tr>
            <template v-for="row in shown" :key="row.key">
              <tr
                :data-conference="row.key"
                class="max-md:flex max-md:flex-wrap max-md:items-baseline max-md:gap-x-2.5 max-md:gap-y-1 max-md:border-t max-md:border-edge max-md:py-2.5"
              >
                <td class="border-t border-edge py-[9px] pr-2.5 align-middle max-md:basis-full max-md:border-t-0 max-md:py-0 max-md:pr-0 max-md:font-semibold">
                  {{ row.title }}
                </td>
                <td class="border-t border-edge py-[9px] pr-2.5 align-middle max-md:border-t-0 max-md:py-0 max-md:pr-0 max-md:text-dim">
                  {{ row.roomName }}
                </td>
                <td data-role="etat" class="border-t border-edge py-[9px] pr-2.5 align-middle max-md:border-t-0 max-md:py-0 max-md:pr-0" :class="ETATS[row.etat].tone">
                  {{ ETATS[row.etat].label }}
                </td>
                <td data-role="files" class="border-t border-edge py-[9px] pr-2.5 align-middle tabular-nums max-md:border-t-0 max-md:py-0 max-md:pr-0">
                  {{ row.files.length }}<span class="md:hidden"> fichier{{ row.files.length > 1 ? 's' : '' }}</span>
                </td>
                <td data-role="detail" class="border-t border-edge py-[9px] pr-2.5 align-middle text-dim max-md:basis-full max-md:border-t-0 max-md:py-0 max-md:pr-0">
                  {{ row.detail }}
                </td>
                <td data-role="montages" class="border-t border-edge py-[9px] pr-2.5 align-middle max-md:basis-full max-md:border-t-0 max-md:py-0 max-md:pr-0 max-md:empty:hidden">
                  <a
                    v-for="job in takesOf.get(row.key) ?? []"
                    :key="job.sidecarUploadId"
                    :href="montagePath(job.sessionId, job.sidecarUploadId)"
                    class="block underline underline-offset-2"
                    :class="stateOfJob(job).tone"
                    :data-montage="job.id"
                    :data-valider="job.state === 'a-valider' ? job.sessionId : undefined"
                  >
                    {{ stateOfJob(job).label }}<span v-if="cutMinutes(job) != null" class="text-dim" data-role="montage-duree"> · {{ cutMinutes(job) }} min</span>
                  </a>
                </td>
                <td class="border-t border-edge py-[9px] text-right align-middle max-md:ml-auto max-md:border-t-0 max-md:py-0 max-md:empty:hidden">
                  <Button
                    v-if="row.files.length > 0"
                    size="small"
                    :aria-expanded="unfolded.has(row.key)"
                    data-role="toggle-files"
                    @click="toggle(row.key)"
                  >
                    <StableLabel :current="unfolded.has(row.key) ? 'Masquer' : 'Détails'" :labels="['Masquer', 'Détails']" />
                  </Button>
                  <!-- Nothing named here: the room alone knows what its disk holds. -->
                  <Button
                    v-else-if="row.etat === 'a-reprendre' && row.roomId != null"
                    size="small"
                    data-role="request-room"
                    @click="requestUpload(row.roomId, null)"
                  >
                    Demander à la salle
                  </Button>
                </td>
              </tr>
              <tr v-if="unfolded.has(row.key) && row.files.length > 0" class="max-md:block">
                <td colspan="7" class="pb-2 max-md:block">
                  <div
                    v-for="upload in row.files"
                    :key="`${upload.roomId}/${upload.file}`"
                    :data-upload="upload.file"
                    class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-t border-edge py-1.5 pl-3"
                  >
                    <div class="min-w-0 flex-1 basis-64 font-mono text-[11px] break-all">
                      {{ upload.file }}
                      <!--
                        L'erreur du stockage est reprise telle quelle : « AccessDenied »
                        est le seul mot qu'on puisse porter à qui tient le bucket.
                      -->
                      <div v-if="upload.lastError != null" class="text-alert" :title="upload.lastError">
                        {{ upload.lastError }}
                      </div>
                    </div>
                    <span class="text-dim">{{ upload.roomName ?? upload.roomId }}</span>
                    <span :class="stateOf(upload).tone">{{ stateOf(upload).label }}</span>
                    <span class="text-dim">{{ progress(upload) }} %{{ rate(upload) }}</span>
                    <Button
                      v-if="upload.state !== 'termine'"
                      size="small"
                      @click="requestUpload(upload.roomId, upload.file)"
                    >
                      Relancer
                    </Button>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <Hint id="vod-hint">
        À regarder <strong>avant de démonter une salle</strong> : c'est le dernier
        moment où son disque est encore branché. Un rush qui n'est pas ici n'existe
        que sur le disque de sa salle.
      </Hint>
    </Panel>
  </div>
</template>
