<script setup lang="ts">
import { Button, Dialog, Hint, useToast } from '@conference-operator/components'
import { time } from '@conference-operator/format'
import { computed, ref, watch } from 'vue'
import { UPLOAD_STATES, progress, type Upload } from '../stores/vod.js'
import { useConferencesStore, type PlannedSession } from '../stores/conferences.js'
import type { MontageJobView } from '@conference-operator/contract'
import { MONTAGE_STATES, describe, useMontageStore } from '../stores/montage.js'

/**
 * Where a talk's capture stands.
 *
 * Two halves that do not say the same thing: what the **control app** recorded,
 * and what the **storage** received. Confusing the two makes people believe
 * footage is safe because it exists on a disk in Lille.
 */
interface Capture {
  obs: string
  startedAt: string
  endedAt?: string | null
  durationMs?: number | null
  file?: string | null
  enCours: boolean
  finInconnue: boolean
  sidecarWritten: boolean
  rattachement?: string | null
}

interface Folder {
  roomId: string | null
  roomName?: string | null
  captations: Capture[]
  televersements: (Upload & { kind: string; objectKey: string })[]
  stockageConfigure: boolean
  /** What the room reported about the broadcast. `null` = never answered. */
  consentementYoutube?: { statut: string; decideA: string } | null
}

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ session: PlannedSession | null; timezone: string }>()

const store = useConferencesStore()
const toast = useToast()

const folder = ref<Folder | null>(null)
/** The talk's latest montage, if any. */
const montage = ref<MontageJobView | null>(null)
const montages = useMontageStore()
const error = ref('')
const loading = ref(false)

watch(
  () => [open.value, props.session?.id] as const,
  async ([ouvert, id]) => {
    if (!ouvert || id == null) return
    folder.value = null
    error.value = ''
    loading.value = true
    try {
      const [response, jobs] = await Promise.all([
        store.vodFolder(id) as Promise<Folder>,
        montages.forSession(id).catch(() => []),
      ])
      /*
       * A response arriving after the modal has been closed, or after another talk
       * has been opened, must not repaint the modal on top.
       */
      if (!open.value || props.session?.id !== id) return
      folder.value = response
      montage.value = jobs[0] ?? null
    } catch (cause) {
      if (!open.value || props.session?.id !== id) return
      error.value = cause instanceof Error ? cause.message : 'Lecture impossible.'
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

/**
 * Four states, not three.
 *
 * "Interrompue" is distinct from "en cours": the hub never heard its stop and
 * never will, another take having started behind it. Confusing the two piled up
 * supposedly active recordings on a room that was recording nothing.
 */
function takeState(take: Capture): { text: string; tone: string } {
  if (take.finInconnue) return { text: 'interrompue, fin jamais reçue', tone: 'text-warn' }
  if (take.enCours) return { text: 'enregistrement en cours', tone: 'text-brand' }
  if (take.file == null) return { text: 'arrêtée sans fichier', tone: 'text-alert' }
  return { text: 'fichier écrit', tone: 'text-ok' }
}

/**
 * The take's interval, in the event's time zone.
 *
 * An interval that ends before it begins is not displayed: the instants come from
 * the room's clock, which may be **simulated** and jump from one event to another.
 * "09:00–08:36" describes nothing and casts doubt on the rest of the line — whereas
 * the duration, measured by the room, stays correct. So we keep the start alone.
 */
function when(take: Capture): string {
  const start = time(take.startedAt, props.timezone)
  if (take.endedAt == null) return `${start}–…`
  const coherent = Date.parse(take.endedAt) >= Date.parse(take.startedAt)
  return coherent ? `${start}–${time(take.endedAt, props.timezone)}` : start
}

/** Footage available in the room but nothing uploaded: there is something to do. */
function footageAvailable(folder: Folder): boolean {
  return folder.captations.some((take) => !take.enCours && take.file != null)
}

async function bringHome(roomId: string, file: string | null): Promise<void> {
  try {
    await store.requestVod(roomId, file)
    toast.say(file == null ? 'Rapatriement demandé' : 'Relance demandée')
  } catch {
    /* already reported by the client's error hook */
  }
}

/**
 * The consent, spelled out rather than shown as a badge.
 *
 * Three states, and the third one carries an instruction. "Pas encore demandé" on
 * its own would be read as a display gap; saying where the answer is obtained —
 * in the room, from the recordings list — is what turns the line into something
 * one can act on from the console, which is precisely where nobody can ask the
 * speaker anything.
 */
const consent = computed<{ text: string; tone: string }>(() => {
  const given = folder.value?.consentementYoutube
  if (given == null) {
    return {
      text: 'Pas encore demandé — la réponse se saisit en régie, dans « Enregistrements ».',
      tone: 'text-warn',
    }
  }
  const when = time(given.decideA, props.timezone)
  return given.statut === 'accorde'
    ? { text: `Accordée par le conférencier, à ${when}.`, tone: 'text-ok' }
    : { text: `Refusée par le conférencier, à ${when}. Ne pas publier.`, tone: 'text-alert' }
})

async function relaunchMontage(sessionId: string): Promise<void> {
  try {
    montage.value = await montages.relaunch(sessionId)
    toast.say('Montage relancé')
  } catch {
    /* already reported by the client's error hook */
  }
}

async function downloadMontage(jobId: string): Promise<void> {
  try {
    await montages.download(jobId)
  } catch {
    /* already reported by the client's error hook */
  }
}

/** The intro or outro as the worker will capture it, playing. */
const previewUrl = (clip: 'intro' | 'outro') =>
  props.session == null ? '#' : `/montage/apercu/${encodeURIComponent(props.session.id)}?clip=${clip}`

function uploadState(row: Upload): { label: string; tone: string } {
  return UPLOAD_STATES[row.state] ?? { label: row.state, tone: '' }
}
</script>

<template>
  <Dialog v-model:open="open" :title="session?.title ?? 'Captation'" width="wide">
    <p class="text-xs text-dim">
      {{ session?.roomName ?? 'salle inconnue'
      }}{{ session != null && session.speakers.length > 0 ? ` · ${session.speakers.join(', ')}` : '' }}
    </p>

    <div id="vod-body" class="mt-3">
      <p v-if="loading" class="text-dim">Lecture…</p>
      <p v-else-if="error !== ''" class="text-alert">{{ error }}</p>

      <template v-else-if="folder != null">
        <!--
          Above the two halves, and not beside the takes.

          It answers a third question, and the one that is asked first when this
          modal is opened weeks later: not "do we have it?" nor "has it left?" but
          "may we publish it?". A refusal read after the cut has been made is a
          refusal read too late.

          The unanswered case is the one shown in amber. It is the only state that
          can still be repaired — by a telephone call — and the only one that gets
          silently treated as a yes if nobody sees it.
        -->
        <h3 class="mb-2.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
          Diffusion YouTube
        </h3>

        <p :class="consent.tone" class="mb-3.5 text-sm" data-role="vod-consent">
          {{ consent.text }}
        </p>

        <h3 class="mb-2.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
          Sur la régie
        </h3>

        <Hint v-if="folder.roomId == null">
          Ce créneau n'est rattaché à aucune salle dans l'export : aucune régie n'avait à
          l'enregistrer.
        </Hint>

        <template v-else-if="folder.captations.length === 0">
          <p class="text-warn">
            Aucune take remontée par {{ folder.roomName ?? folder.roomId }}.
          </p>
          <Hint>
            Le hub ne lit pas le disque de la régie : il recompose les prises depuis ce que la
            salle remonte en démarrant et en arrêtant OBS. Rien ici veut dire qu'aucun
            enregistrement n'a été signalé sur ce créneau — pas qu'il n'y a rien sur le disque.
            À vérifier en régie avant de démonter la salle.
          </Hint>
        </template>

        <div
          v-for="(take, index) in folder.captations"
          v-else
          :key="`${take.obs}-${take.startedAt}-${index}`"
          class="border-t border-edge py-2 first:border-t-0"
          data-take
        >
          <div class="text-sm">
            <span :class="takeState(take).tone">{{ takeState(take).text }}</span>
            · OBS {{ take.obs }}
            <template v-if="take.durationMs != null">
              · {{ Math.round(take.durationMs / 60000) }} min
            </template>
            <!--
              Le sidecar n'est pas un détail : sans lui le rush arrive au montage
              sans titre, sans intervenants et sans marqueurs.
            -->
            <template v-if="!take.enCours && !take.finInconnue">
              <template v-if="take.sidecarWritten"> · sidecar écrit</template>
              <span v-else class="text-warn"> · sans sidecar</span>
            </template>
          </div>
          <div class="text-[11px] tabular-nums text-dim">{{ when(take) }}</div>
          <div v-if="take.file != null" class="font-mono text-[11px] break-all">
            {{ take.file }}
          </div>
          <div v-else class="text-[11px] text-alert">
            OBS n'a rendu aucun chemin — disque plein, ou processus tué en plein arrêt.
          </div>
          <!-- An attachment deduced from the time is a lead, not a fact. -->
          <div v-if="take.rattachement === 'horaire'" class="text-[11px] text-warn">
            Rattachée à l'heure : la take ne porte aucun créneau, mais elle recouvre celui-ci
            dans la même salle.
          </div>
        </div>

        <h3 class="mt-3.5 mb-2.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
          Chez le stockage
        </h3>

        <Hint v-if="!folder.stockageConfigure">
          Aucun stockage configuré sur ce hub : rien ne peut partir, et « rien de monté » ne veut
          donc rien dire ici. Le stockage se règle dans
          <strong>Réglages → Rapatriement des rushes</strong>.
        </Hint>

        <template v-else-if="folder.televersements.length === 0">
          <p :class="footageAvailable(folder) ? 'text-warn' : 'text-dim'">
            Rien de monté pour cette conférence.
          </p>
          <Button
            v-if="footageAvailable(folder) && folder.roomId != null"
            size="small"
            class="mt-1.5"
            @click="bringHome(folder.roomId, null)"
          >
            Rapatrier cette salle
          </Button>
        </template>

        <div
          v-for="row in folder.televersements"
          v-else
          :key="row.objectKey"
          class="border-t border-edge py-2 first:border-t-0"
          data-montee
        >
          <div class="text-sm">
            <span :class="uploadState(row).tone">{{ uploadState(row).label }}</span>
            · {{ row.kind }} · {{ progress(row) }} %
          </div>
          <!--
            La clé d'objet, pas seulement le nom du fichier : c'est elle qu'on
            donne à qui va chercher le rush dans le bucket.
          -->
          <div class="font-mono text-[11px] break-all">{{ row.objectKey }}</div>
          <div v-if="row.lastError != null" class="text-[11px] text-alert">
            {{ row.lastError }}
          </div>
          <Button
            v-if="row.state !== 'termine'"
            size="small"
            class="mt-1.5"
            @click="bringHome(row.roomId, row.file)"
          >
            Relancer
          </Button>
        </div>

        <!--
          Last, because it comes last: the rushes arrive, then the video is
          edited from them. The previews are the pages the worker captures —
          what is checked here is what goes into the video.
        -->
        <h3 class="mt-3.5 mb-2.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
          Montage
        </h3>

        <p class="mb-1.5 text-sm" data-role="vod-montage">
          <template v-if="montage == null">
            <span class="text-dim">Pas encore monté — il se met en file quand la prise arrive dans le stockage.</span>
          </template>
          <template v-else>
            <span :class="MONTAGE_STATES[montage.state]?.tone">{{ MONTAGE_STATES[montage.state]?.label ?? montage.state }}</span>
            <template v-if="describe(montage) !== ''"> · {{ describe(montage) }}</template>
            <span v-if="montage.erreur != null && montage.state === 'echoue'" class="block text-[11px] text-alert">
              {{ montage.erreur }}
            </span>
          </template>
        </p>

        <div class="flex flex-wrap gap-1.5">
          <a :href="previewUrl('intro')" target="_blank" rel="noopener" class="text-sm text-brand underline">Aperçu de l’intro</a>
          <a :href="previewUrl('outro')" target="_blank" rel="noopener" class="text-sm text-brand underline">Aperçu de l’outro</a>
        </div>
        <div class="mt-1.5 flex flex-wrap gap-1.5">
          <Button v-if="montage?.state === 'termine'" size="small" @click="downloadMontage(montage.id)">
            Télécharger la vidéo
          </Button>
          <Button
            v-if="session != null && folder.stockageConfigure && folder.televersements.some((row) => row.kind === 'sidecar' && row.state === 'termine')"
            size="small"
            @click="relaunchMontage(session.id)"
          >
            {{ montage == null ? 'Monter' : 'Remonter' }}
          </Button>
        </div>
      </template>
    </div>
  </Dialog>
</template>
