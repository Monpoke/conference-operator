<script setup lang="ts">
import { Badge, Button, ConfirmDialog, Empty, Hint, Panel, useToast } from '@conference-operator/components'
import { timeAgo } from '@conference-operator/format'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import IntegrationDialog from '../components/IntegrationDialog.vue'
import { useSeededField } from '../composables/seededField.js'
import {
  KIND_LABELS,
  deliveryStatus,
  useIntegrationsStore,
  type Integration,
} from '../stores/integrations.js'
import {
  STORAGE_STEPS,
  orNull,
  useSettingsStore,
  type RoomStream,
  type SocialLink,
  type StorageCheck,
} from '../stores/settings.js'
import { useWallsIoStore } from '../stores/wallsio.js'

/**
 * What is set once, and holds for the day.
 *
 * Six panels sharing one constraint: the view refreshes every ten seconds, and
 * **no field must rewrite itself while somebody is typing in it**. It is
 * `useSeededField` that holds that, rather than a focus check copied into every
 * panel.
 */
const store = useSettingsStore()
const { settings, derived, snapshots, rooms, streams, storage, images } = storeToRefs(store)
const toast = useToast()

// — The event —
const name = useSeededField(() => settings.value?.eventName ?? '', 'event-name')
const shortName = useSeededField(() => settings.value?.eventShortName ?? '', 'event-short-name')
const project = useSeededField(
  () => settings.value?.openFeedbackProjectId ?? '',
  'event-openfeedback',
)

/**
 * The fields stay empty when nothing is set.
 *
 * The placeholder then shows what the hub deduced from the program. A field
 * pre-filled with the deduced value would suggest it is pinned, and the first save
 * would in fact have pinned it — the name would stop following later imports.
 */
const eventHelp = computed(() =>
  settings.value?.eventName
    ? `Nom imposé ici : il ne suivra plus les imports de programme. Videz le champ pour revenir à « ${derived.value.name} ».`
    : `Déduit du programme importé (« ${derived.value.name} »). Renseignez un nom pour contredire l'export amont.`,
)

async function saveEvent(): Promise<void> {
  try {
    await store.update({
      eventName: orNull(name.value.value),
      eventShortName: orNull(shortName.value.value),
      openFeedbackProjectId: orNull(project.value.value),
    })
    toast.say('Événement enregistré')
  } catch {
    /* already reported */
  }
}

// — Program —
const programUrl = useSeededField(() => settings.value?.programSourceUrl ?? '', 'program-url')

/**
 * "Réimporter" starts from the **saved** URL, not the one on screen.
 *
 * The button is therefore blocked while the two differ: without that, one types a
 * new address, clicks Réimporter, and the hub reads the old one with nothing to
 * say so.
 */
const pendingSource = computed(
  () => programUrl.value.value.trim() !== (settings.value?.programSourceUrl ?? ''),
)

const canReimport = computed(
  () => settings.value?.programSourceUrl != null && !pendingSource.value,
)

const reimportTitle = computed(() =>
  settings.value?.programSourceUrl == null
    ? 'Renseignez une URL, puis enregistrez'
    : pendingSource.value
      ? "Enregistrez d'abord : l'import part de l'URL enregistrée"
      : settings.value.programSourceUrl,
)

async function saveSource(): Promise<void> {
  try {
    // Emptied means no source. The hub then imports nothing by itself, which is a
    // legitimate state: a program already in the database goes on serving.
    await store.update({ programSourceUrl: orNull(programUrl.value.value) })
    toast.say('Source du programme enregistrée')
  } catch {
    /* already reported */
  }
}

async function reimport(): Promise<void> {
  try {
    // The session count, not "imported": it is the only figure that says whether
    // the export at the other end really contained what one thought.
    toast.say(`${await store.reimport()} sessions importées`)
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('Aucune URL')) toast.fail(cause.message)
  }
}

async function activate(contentHash: string): Promise<void> {
  try {
    // A failed import on the day is rolled back with one click.
    await store.activate(contentHash)
    toast.say('Programme activé')
  } catch {
    /* already reported */
  }
}

// — Our social links —
const socialLinks = ref<SocialLink[]>([])

watch(
  () => settings.value?.socialLinks,
  (links) => {
    // The same precaution as the fields: do not rewrite the list while somebody is
    // typing in it.
    const area = globalThis.document?.getElementById('socials')
    if (area != null && area.contains(globalThis.document.activeElement)) return
    socialLinks.value = (links ?? []).map((link) => ({ ...link }))
  },
  { immediate: true, deep: true },
)

async function saveSocialLinks(): Promise<void> {
  // Empty rows are dropped here: adding a row and then thinking better of it is a
  // normal gesture, and the hub would refuse an empty URL.
  const filled = socialLinks.value.filter(
    (link) => link.network.trim() !== '' && link.handle.trim() !== '' && link.url.trim() !== '',
  )
  try {
    await store.update({ socialLinks: filled })
    toast.say('Réseaux enregistrés')
  } catch {
    /* already reported */
  }
}

// — Room screens: what this edition offers —
/**
 * The catalog, in the order the control app offers it.
 *
 * Written here rather than read from the contract's enum: the enum knows the
 * identifiers, not what an organizer calls them, and the order of an enum is an
 * implementation detail — here it is the order of the buttons an operator knows
 * by heart. The two lists are held together by `screensDisabled`, which refuses
 * an identifier the contract does not know.
 */
const SCREENS: { value: string; label: string; hint: string }[] = [
  { value: 'sponsors', label: 'Sponsors', hint: 'Les logos, par niveau.' },
  { value: 'programme', label: 'Programme', hint: 'La journée de la salle, déroulée.' },
  { value: 'agenda', label: 'Agenda', hint: 'La même journée, entière, en deux colonnes.' },
  {
    value: 'agenda-reminder',
    label: "Rappel de l'agenda",
    hint: "Le second passage de l'agenda, au milieu de la boucle. Retirer l'agenda retire aussi le rappel.",
  },
  { value: 'countdown', label: 'Compte à rebours', hint: 'Le temps restant sur le créneau.' },
  { value: 'message', label: 'Message', hint: 'La bannière saisie en régie.' },
  { value: 'feedback', label: 'Notez le talk', hint: 'Le QR code OpenFeedback du talk en cours.' },
  { value: 'wall', label: 'Mur & questions', hint: 'Les messages du public, modérés en régie.' },
  { value: 'question', label: 'Question choisie', hint: 'Une question du public, en grand.' },
  { value: 'wallsio', label: 'Mur social', hint: 'walls.io, les messages du public et les posts partenaires, en mosaïque.' },
  { value: 'rooms', label: 'Pendant ce temps…', hint: 'Ce qui se passe dans les autres salles.' },
  { value: 'socials', label: 'Nos réseaux', hint: 'Les comptes déclarés ci-dessus.' },
  // The loop's own scenes: their content is laid out in the « Boucle » tab.
  { value: 'welcome', label: 'Accueil', hint: "Le logo de l'événement, en grand." },
  { value: 'announcements', label: 'Annonces “offert par”', hint: 'Le petit déjeuner, le déjeuner… et qui les offre.' },
  { value: 'sponsors-thanks', label: 'Merci à nos sponsors', hint: 'Le remerciement avant les pages de logos.' },
  { value: 'slogans', label: 'Messages animés', hint: 'Bienvenue, partage, silence des téléphones.' },
  { value: 'code-of-conduct', label: 'Code de conduite', hint: "Le rappel, et le QR vers l'intégralité." },
  { value: 'event-feedback', label: "QR feedbacks de l'événement", hint: 'Le QR OpenFeedback de la journée entière.' },
  { value: 'other-agendas', label: 'Plannings des autres salles', hint: 'La journée des autres salles, après celle de la salle.' },
]

/**
 * Held the right way up — what is **on** — and sent the other way.
 *
 * A checkbox one ticks to switch a screen off reads backwards, and the setting is
 * a deny list for a reason of its own (a screen added later must be available to
 * an event configured before it existed). The inversion lives here, in the one
 * place both readings are visible at once.
 */
const screensOn = ref<Record<string, boolean>>({})

watch(
  settings,
  (value) => {
    if (value == null) return
    const off = value.screensDisabled ?? []
    screensOn.value = Object.fromEntries(
      SCREENS.map((screen) => [screen.value, !off.includes(screen.value)]),
    )
  },
  { immediate: true, deep: true },
)

async function saveScreens(): Promise<void> {
  try {
    await store.update({
      screensDisabled: SCREENS.filter((s) => screensOn.value[s.value] === false).map((s) => s.value),
    })
    toast.say('Écrans enregistrés')
  } catch {
    /* already reported */
  }
}

// — walls.io —
/**
 * Typed, sent, emptied: the token never comes back to fill the field, only
 * whether there is one and its last characters.
 */
const wallsIo = useWallsIoStore()
const { status: wallsIoStatus } = storeToRefs(wallsIo)
const wallsIoToken = ref('')
const wallsIoBusy = ref(false)
onMounted(() => {
  void wallsIo.load().catch(() => {})
})

async function saveWallsIoToken(token: string | null): Promise<void> {
  wallsIoBusy.value = true
  try {
    const status = await wallsIo.setToken(token)
    wallsIoToken.value = ''
    if (token == null) toast.say('Jeton walls.io retiré')
    else if (status.lastError != null) toast.fail(status.lastError)
    else toast.say(`Jeton walls.io enregistré : ${status.imported} post(s) sur le mur`)
  } catch {
    /* already reported */
  } finally {
    wallsIoBusy.value = false
  }
}

// — Automatic closure —
const autoEnabled = ref(false)
const autoGrace = ref(5)

watch(
  settings,
  (value) => {
    if (value == null) return
    autoEnabled.value = value.autoEndEnabled
    if (globalThis.document?.activeElement?.id !== 'auto-grace') {
      autoGrace.value = value.autoEndGraceMinutes
    }
  },
  { immediate: true },
)

async function saveAutoEnd(): Promise<void> {
  try {
    await store.update({
      autoEndEnabled: autoEnabled.value,
      autoEndGraceMinutes: Number(autoGrace.value),
    })
    toast.say('Réglages enregistrés')
  } catch {
    /* already reported */
  }
}

// — Storage —
const bucket = useSeededField(() => storage.value?.bucket ?? '', 'vod-bucket')
const prefix = useSeededField(() => storage.value?.prefix ?? '', 'vod-prefix')
const vodAuto = ref(false)
const rate = ref('')
const cpu = ref(80)
const margin = ref(5)
const part = ref(16)

watch(
  storage,
  (value) => {
    if (value == null) return
    // `politique` and its fields are the contract's own names: not renamed.
    const policy = value.politique
    vodAuto.value = policy.actif
    rate.value =
      policy.debitMaxOctetsS == null ? '' : String(Math.round(policy.debitMaxOctetsS / 1024))
    cpu.value = Math.round(policy.cpuMax * 100)
    margin.value = policy.margeConferenceMinutes
    part.value = policy.taillePartMo
  },
  { immediate: true },
)

async function saveStorage(): Promise<void> {
  try {
    await store.update({
      vodBucket: orNull(bucket.value.value),
      vodPrefix: orNull(prefix.value.value),
      vodPolitique: {
        actif: vodAuto.value,
        debitMaxOctetsS: rate.value === '' || Number(rate.value) <= 0 ? null : Number(rate.value) * 1024,
        cpuMax: Math.min(1, Math.max(0.1, Number(cpu.value) / 100)),
        margeConferenceMinutes: Number(margin.value),
        taillePartMo: Number(part.value),
      },
    })
    toast.say('Stockage enregistré')
  } catch {
    /* already reported */
  }
}

const check = ref<StorageCheck | null>(null)
const checking = ref(false)

async function probeStorage(): Promise<void> {
  checking.value = true
  check.value = null
  try {
    check.value = await store.checkStorage()
  } catch {
    /* already reported */
  } finally {
    checking.value = false
  }
}

// — Resynchronisation —
const resyncRoom = ref('')
const resyncConfirmation = ref(false)

const resyncRoomName = computed(
  () => rooms.value.find((room) => room.id === resyncRoom.value)?.name ?? null,
)

async function confirmResync(): Promise<void> {
  try {
    const result = await store.resync(resyncRoom.value === '' ? null : resyncRoom.value)
    /*
     * The number of rooms targeted, not a "it's off". A hub with no paired room at
     * all accepts the request with nothing leaving: saying "requested" would then be
     * exact and misleading.
     */
    toast.say(
      resyncRoomName.value != null
        ? `Resynchronisation demandée à ${resyncRoomName.value}`
        : result.rooms === 0
          ? "Aucune salle sur ce hub : la demande n'atteindra personne"
          : `Resynchronisation demandée à ${result.rooms} salle(s)`,
    )
  } catch {
    /* already reported */
  }
}

// — Integrations —
const integrationsStore = useIntegrationsStore()
const { integrations } = storeToRefs(integrationsStore)
const integrationDialog = ref(false)
const editedIntegration = ref<Integration | null>(null)
const integrationToRemove = ref<Integration | null>(null)
const removeConfirmation = ref(false)
const testing = ref<string | null>(null)

function openIntegration(item: Integration | null): void {
  editedIntegration.value = item
  integrationDialog.value = true
}

async function toggleIntegration(item: Integration): Promise<void> {
  try {
    await integrationsStore.update({ id: item.id, enabled: !item.enabled })
    toast.say(item.enabled ? `« ${item.name} » désactivée` : `« ${item.name} » activée`)
  } catch {
    /* already reported */
  }
}

/**
 * The other end's answer, word for word.
 *
 * "Échec" alone sends the operator to the logs; `invalid_token` or
 * `channel_not_found` tells them which setting to fix in Slack.
 */
async function testIntegration(item: Integration): Promise<void> {
  testing.value = item.id
  try {
    const result = await integrationsStore.test(item.id)
    if (result.ok) toast.say(`« ${item.name} » a reçu l'avis de test`)
    else toast.fail(`« ${item.name} » : ${result.error ?? 'échec'}`)
  } catch {
    /* already reported */
  } finally {
    testing.value = null
  }
}

// — Diffusion —

/**
 * One draft per room, and the refresh does not touch the ones being typed in.
 *
 * The page reloads every ten seconds. `useSeededField` solves this for the
 * single fields above, but it seeds from **one** source and there are as many
 * here as there are rooms, so the same rule is applied by hand: a line the
 * operator has touched is left alone until it is saved, and `load()` bringing
 * back the old address mid-sentence is exactly the defect that composable
 * exists to prevent.
 */
interface StreamDraft {
  rtmpUrl: string
  /** Always starts empty: the console never receives the key. */
  streamKey: string
  touched: boolean
  saving: boolean
}

const streamDrafts = ref<Record<string, StreamDraft>>({})

watch(
  streams,
  (list) => {
    const next: Record<string, StreamDraft> = {}
    for (const item of list) {
      const current = streamDrafts.value[item.roomId]
      next[item.roomId] =
        current?.touched === true
          ? current
          : { rtmpUrl: item.rtmpUrl, streamKey: '', touched: false, saving: false }
    }
    streamDrafts.value = next
  },
  { immediate: true, deep: true },
)

function draftOf(roomId: string): StreamDraft {
  return (
    streamDrafts.value[roomId] ?? { rtmpUrl: '', streamKey: '', touched: false, saving: false }
  )
}

/**
 * What a line has to say about itself, in one sentence.
 *
 * The incomplete case is the one worth naming: a server with no key looks set up
 * — there is text in the field — and it is the state in which a room silently
 * offers no "Diffuser". Saying so here is cheaper than finding out at 9 a.m.
 */
function streamState(item: RoomStream): { text: string; ok: boolean } {
  if (item.rtmpUrl === '' && !item.hasKey) {
    return { text: 'Aucune diffusion : cette salle ne propose pas « Diffuser »', ok: false }
  }
  if (item.rtmpUrl === '') {
    return { text: 'Clé enregistrée, mais aucun serveur : réglage incomplet', ok: false }
  }
  if (!item.hasKey) {
    return { text: 'Serveur renseigné, mais aucune clé : réglage incomplet', ok: false }
  }
  return { text: 'Diffusion prête', ok: true }
}

async function saveStream(item: RoomStream): Promise<void> {
  const draft = draftOf(item.roomId)
  draft.saving = true
  try {
    const typed = draft.streamKey.trim()
    const updated = await store.setStream({
      roomId: item.roomId,
      rtmpUrl: draft.rtmpUrl.trim(),
      // Left out when nothing was typed: absent means unchanged all the way down
      // to the column, and sending an empty string instead would wipe the key
      // every time somebody fixed a typo in the address.
      ...(typed === '' ? {} : { streamKey: typed }),
    })
    streamDrafts.value[item.roomId] = {
      rtmpUrl: updated.rtmpUrl,
      streamKey: '',
      touched: false,
      saving: false,
    }
    toast.say(
      updated.rtmpUrl !== '' && updated.hasKey
        ? `Diffusion enregistrée pour « ${updated.name} »`
        : `Diffusion incomplète pour « ${updated.name} » : la salle ne diffusera pas`,
    )
  } catch {
    draft.saving = false
    /* already reported */
  }
}

const streamToClear = ref<RoomStream | null>(null)
const clearStreamConfirmation = ref(false)

function askClearStream(item: RoomStream): void {
  streamToClear.value = item
  clearStreamConfirmation.value = true
}

/**
 * Erasing is its own gesture, behind its own confirmation.
 *
 * Because it cannot be undone from here: the console has never held the key, so
 * a mistaken click is repaired by going and fetching it from wherever it was
 * issued, which on the day is a person and a web console somewhere else.
 */
async function confirmClearStream(): Promise<void> {
  const item = streamToClear.value
  if (item == null) return
  try {
    await store.setStream({ roomId: item.roomId, rtmpUrl: '', streamKey: null })
    streamDrafts.value[item.roomId] = {
      rtmpUrl: '',
      streamKey: '',
      touched: false,
      saving: false,
    }
    toast.say(`Diffusion effacée pour « ${item.name} »`)
  } catch {
    /* already reported */
  }
}

function askRemoveIntegration(item: Integration): void {
  integrationToRemove.value = item
  removeConfirmation.value = true
}

async function confirmRemoveIntegration(): Promise<void> {
  const item = integrationToRemove.value
  if (item == null) return
  try {
    await integrationsStore.remove(item.id)
    toast.say(`« ${item.name} » supprimée`)
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <div
    id="settings-view"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-3.5"
  >
    <Panel title="L'événement">
      <label class="mb-[5px] block text-xs text-dim" for="event-name">Nom affiché</label>
      <input
        id="event-name"
        v-model="name.value.value"
        type="text"
        maxlength="80"
        :placeholder="derived.name"
        class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
      />
      <label class="mb-[5px] block text-xs text-dim" for="event-short-name">Nom court</label>
      <input
        id="event-short-name"
        v-model="shortName.value.value"
        type="text"
        maxlength="40"
        :placeholder="derived.shortName"
        class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
      />
      <label class="mb-[5px] block text-xs text-dim" for="event-openfeedback">
        Projet OpenFeedback
      </label>
      <input
        id="event-openfeedback"
        v-model="project.value.value"
        type="text"
        maxlength="80"
        placeholder="mon-evenement-2026"
        class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
      />
      <Button id="btn-event" variant="primary" class="w-full" @click="saveEvent">
        Enregistrer
      </Button>
      <Hint id="event-help">{{ eventHelp }}</Hint>
    </Panel>

    <Panel title="Programme">
      <label class="mb-[5px] block text-xs text-dim" for="program-url">
        URL de l'export « conference-center »
      </label>
      <input
        id="program-url"
        v-model="programUrl.value.value"
        type="url"
        placeholder="https://…/programme.json"
        class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
      />
      <div class="mb-[11px] flex gap-1.5">
        <Button id="btn-program-source" variant="primary" size="small" @click="saveSource">
          Enregistrer
        </Button>
        <Button
          id="btn-reimport"
          size="small"
          :disabled="!canReimport"
          :title="reimportTitle"
          @click="reimport"
        >
          Réimporter
        </Button>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full border-collapse text-[13px]">
          <thead>
            <tr class="text-[11px] tracking-[.08em] text-dim uppercase">
              <th class="pr-2.5 pb-2 text-left font-semibold">Version</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Créneaux</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Anomalies</th>
              <th class="pb-2"></th>
            </tr>
          </thead>
          <tbody id="snapshots">
            <tr v-if="snapshots.length === 0">
              <td colspan="4"><Empty>Aucun programme importé.</Empty></td>
            </tr>
            <tr
              v-for="snapshot in snapshots"
              v-else
              :key="snapshot.contentHash"
              :data-snapshot="snapshot.contentHash"
            >
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle font-mono text-[11px]">
                <span v-if="snapshot.active" class="text-ok">● actif </span>
                {{ snapshot.contentHash.slice(0, 10) }}
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
                {{ snapshot.sessionCount }}
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
                {{ snapshot.issueCount > 0 ? snapshot.issueCount : '—' }}
              </td>
              <td class="border-t border-edge py-[9px] align-middle">
                <!-- A failed import on the day is rolled back with one click. -->
                <Button
                  v-if="!snapshot.active"
                  size="small"
                  @click="activate(snapshot.contentHash)"
                >
                  Activer
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!--
        Les images, et ce qui manque.

        Les salles ne vont plus les chercher chez la source : elles les prennent
        sur le hub. Une image que le hub n'a pas obtenue manque donc sur tous les
        écrans à la fois — et c'est d'ici qu'on corrige l'export, pas depuis le
        journal de trois salles.
      -->
      <div class="mt-4 border-t border-edge pt-3.5" id="program-images">
        <h3 class="mb-1.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
          Images
        </h3>
        <p class="text-[13px] text-dim">
          {{ images.held }} image{{ images.held > 1 ? 's' : '' }} servie{{
            images.held > 1 ? 's' : ''
          }}
          aux salles depuis ce hub.
        </p>
        <ul v-if="images.failed.length > 0" class="mt-2 flex flex-col gap-1">
          <li
            v-for="failure in images.failed"
            :key="failure.url"
            class="text-[13px] text-alert"
            data-role="image-failure"
          >
            {{ failure.reason }} — <span class="break-all opacity-80">{{ failure.url }}</span>
          </li>
        </ul>
        <p v-else class="mt-1 text-[13px] text-dim">
          Aucune image manquante. Une salle n'a donc rien à aller chercher sur Internet.
        </p>
      </div>
    </Panel>

    <Panel title="Nos réseaux">
      <div id="socials">
        <Empty v-if="socialLinks.length === 0">
          Aucun compte déclaré. La boucle des salles saute cette page.
        </Empty>
        <div
          v-for="(link, index) in socialLinks"
          :key="index"
          class="mb-1.5 grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,2fr)_auto] items-center gap-1.5"
        >
          <input
            v-model="link.network"
            placeholder="Réseau"
            class="min-w-0 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm text-text"
          />
          <input
            v-model="link.handle"
            placeholder="@handle"
            class="min-w-0 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm text-text"
          />
          <input
            v-model="link.url"
            placeholder="https://…"
            class="min-w-0 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-sm text-text"
          />
          <Button variant="danger" size="small" title="Retirer ce compte" @click="socialLinks.splice(index, 1)">
            ×
          </Button>
        </div>
      </div>
      <div class="mt-2 flex gap-1.5">
        <Button id="btn-social-add" size="small" @click="socialLinks.push({ network: '', handle: '', url: '' })">
          Ajouter un compte
        </Button>
        <Button id="btn-social-links" variant="primary" size="small" @click="saveSocialLinks">
          Enregistrer
        </Button>
      </div>
    </Panel>

    <Panel title="Mur social — walls.io">
      <p class="mb-2 text-[13px] text-dim">
        Le hub lit les posts du mur walls.io par son API et les ajoute au mur social de la
        boucle, déjà modérés par walls.io. Le jeton d'accès se trouve dans les réglages du mur,
        sur walls.io. Il est chiffré sur le hub et ne descend jamais en salle.
      </p>
      <label class="mb-[5px] block text-xs text-dim" for="walls-io-token">Jeton d'accès API</label>
      <input
        id="walls-io-token"
        v-model="wallsIoToken"
        type="password"
        autocomplete="off"
        :placeholder="wallsIoStatus?.hasToken ? `Jeton enregistré (…${wallsIoStatus.tokenHint ?? ''})` : 'Aucun jeton'"
        class="mb-2 w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text"
      />
      <p id="walls-io-status" class="mb-3 text-[13px] text-dim">
        <template v-if="wallsIoStatus?.hasToken">
          {{ wallsIoStatus.imported }} post(s) walls.io sur le mur<template v-if="wallsIoStatus.lastPollAt">
            — dernière lecture {{ timeAgo(wallsIoStatus.lastPollAt) }}</template>.
          <span v-if="wallsIoStatus.lastError" class="text-alert">{{ wallsIoStatus.lastError }}</span>
        </template>
        <template v-else>Sans jeton, le mur social montre les messages du public et les posts partenaires.</template>
      </p>
      <div class="flex gap-2">
        <Button
          id="btn-walls-io-token"
          variant="primary"
          size="small"
          :disabled="wallsIoBusy || wallsIoToken.trim().length < 8"
          @click="saveWallsIoToken(wallsIoToken.trim())"
        >
          Enregistrer
        </Button>
        <Button
          v-if="wallsIoStatus?.hasToken"
          id="btn-walls-io-clear"
          size="small"
          :disabled="wallsIoBusy"
          @click="saveWallsIoToken(null)"
        >
          Retirer le jeton
        </Button>
      </div>
    </Panel>

    <Panel title="Écrans de salle">
      <p class="mb-2 text-[13px] text-dim">
        Ce qu'une régie peut choisir d'afficher, et ce que la boucle d'attente fait défiler.
        Retirer un écran ne change rien à ce qui est projeté en ce moment : c'est la régie
        qui décide, salle par salle.
      </p>

      <div id="screens" class="border-t border-edge pt-2">
        <label
          v-for="screen in SCREENS"
          :key="screen.value"
          class="flex items-baseline gap-3 py-1.5"
          :data-screen="screen.value"
        >
          <input v-model="screensOn[screen.value]" type="checkbox" class="w-auto" />
          <span class="flex-1">
            <strong class="block text-sm">{{ screen.label }}</strong>
            <span class="text-xs text-dim">{{ screen.hint }}</span>
          </span>
        </label>
      </div>

      <div class="mt-2">
        <Button id="btn-screens" variant="primary" size="small" @click="saveScreens">
          Enregistrer
        </Button>
      </div>
    </Panel>

    <Panel title="Intégrations">
      <div id="integrations">
        <Empty v-if="integrations.length === 0">
          Aucune intégration. Les avis ne partent que vers les consoles abonnées.
        </Empty>
        <div
          v-for="item in integrations"
          :key="item.id"
          class="mb-2 border-b border-edge pb-2 last:mb-0 last:border-b-0"
        >
          <div class="flex items-center gap-2">
            <Badge :variant="item.enabled ? 'running' : 'neutral'">{{ KIND_LABELS[item.kind] }}</Badge>
            <strong class="min-w-0 flex-1 truncate text-sm text-text">{{ item.name }}</strong>
            <label class="flex items-center gap-1 text-xs text-dim">
              <input
                :id="`integration-enabled-${item.id}`"
                type="checkbox"
                :checked="item.enabled"
                @change="toggleIntegration(item)"
              />
              Active
            </label>
          </div>
          <p class="mt-0.5 truncate text-xs text-dim" :title="item.url">
            {{ item.url }} · technique : {{ item.levels.technique }} · exploitation :
            {{ item.levels.exploitation }}
          </p>
          <p
            v-if="deliveryStatus(item) != null"
            class="mt-0.5 text-xs"
            :class="deliveryStatus(item)!.ok ? 'text-dim' : 'text-alert'"
          >
            {{ deliveryStatus(item)!.text }}
          </p>
          <div class="mt-1.5 flex gap-1.5">
            <Button size="small" :disabled="testing === item.id" @click="testIntegration(item)">
              {{ testing === item.id ? 'Envoi…' : 'Tester' }}
            </Button>
            <Button size="small" @click="openIntegration(item)">Modifier</Button>
            <Button variant="danger" size="small" @click="askRemoveIntegration(item)">Supprimer</Button>
          </div>
        </div>
      </div>
      <div class="mt-2 flex gap-1.5">
        <Button id="btn-integration-add" size="small" @click="openIntegration(null)">
          Ajouter une intégration
        </Button>
      </div>
      <Hint class="mt-2">
        Slack, Mattermost ou webhook JSON : les mêmes avis que les notifications, filtrés par famille.
      </Hint>
    </Panel>

    <Panel title="Clôture automatique">
      <div class="flex items-center gap-3 border-b border-edge pb-3">
        <div class="flex-1">
          <strong class="mb-[3px] block text-sm">Clôturer les conférences dépassées</strong>
          <span class="text-xs text-dim">
            Sans elle, un talk lancé reste « en cours » indéfiniment.
          </span>
        </div>
        <input id="auto-enabled" v-model="autoEnabled" type="checkbox" class="w-auto" />
      </div>
      <div class="flex items-baseline gap-3 pt-3">
        <label class="flex-1" for="auto-grace">
          <strong class="mb-[3px] block text-sm">Délai de grâce</strong>
          <span class="text-xs text-dim">Minutes après la fin du créneau avant clôture.</span>
        </label>
      </div>
      <input
        id="auto-grace"
        v-model="autoGrace"
        type="number"
        min="0"
        max="120"
        class="w-[92px] rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text"
      />
      <Button id="btn-auto-end" variant="primary" class="mt-3 w-full" @click="saveAutoEnd">
        Enregistrer
      </Button>
    </Panel>

    <Panel title="Stockage">
      <Hint id="vod-state" class="mt-0 mb-3">
        <template v-if="storage?.endpoint == null">
          <!-- No keys: nothing to set here, and saying so stops people filling in
               le formulaire en se demandant pourquoi rien ne part. -->
          Aucun stockage S3 configuré sur ce hub. Les clés se posent dans son environnement
          (<code>S3_ENDPOINT</code>, <code>S3_ACCESS_KEY_ID</code>,
          <code>S3_SECRET_ACCESS_KEY</code>) et demandent un redémarrage — c'est le seul réglage
          de cette page qui ne se change pas en cours d'événement.
        </template>
        <template v-else-if="!storage.configure">
          <!-- The most confusing of the three: the keys are there, the page is
               ouverte, et rien ne part parce qu'il manque un name de bucket. -->
          Clés en place sur <strong>{{ storage.endpoint }}</strong>, mais
          <strong>aucun bucket</strong> : renseignez-le ci-dessous.
        </template>
        <template v-else>
          Stockage prêt sur <strong>{{ storage.endpoint }}</strong>, bucket
          <strong>{{ storage.bucket }}</strong>.
          <template v-if="!storage.politique.actif">
            Le téléversement automatique est éteint : rien ne part sans demande.
          </template>
        </template>
      </Hint>

      <label class="mb-[5px] block text-xs text-dim" for="vod-bucket">Bucket</label>
      <input
        id="vod-bucket"
        v-model="bucket.value.value"
        type="text"
        maxlength="200"
        placeholder="rushes-cloudnord"
        class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
      />
      <label class="mb-[5px] block text-xs text-dim" for="vod-prefix">Préfixe</label>
      <input
        id="vod-prefix"
        v-model="prefix.value.value"
        type="text"
        maxlength="200"
        placeholder="cn26"
        class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
      />

      <label class="mb-2 flex items-center gap-2 text-sm">
        <input id="vod-auto" v-model="vodAuto" type="checkbox" class="w-auto" />
        Téléverser automatiquement
      </label>

      <div class="grid grid-cols-2 gap-2">
        <div>
          <label class="mb-[5px] block text-xs text-dim" for="vod-rate">Débit max (Ko/s)</label>
          <input id="vod-rate" v-model="rate" type="number" min="0" max="1000000"
            class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text" />
        </div>
        <div>
          <label class="mb-[5px] block text-xs text-dim" for="vod-cpu">CPU max (%)</label>
          <input id="vod-cpu" v-model="cpu" type="number" min="10" max="100"
            class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text" />
        </div>
        <div>
          <label class="mb-[5px] block text-xs text-dim" for="vod-margin">Marge (min)</label>
          <input id="vod-margin" v-model="margin" type="number" min="0" max="120"
            class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text" />
        </div>
        <div>
          <label class="mb-[5px] block text-xs text-dim" for="vod-part">Taille de part (Mo)</label>
          <input id="vod-part" v-model="part" type="number" min="5" max="64"
            class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text" />
        </div>
      </div>

      <div class="mt-3 flex gap-1.5">
        <Button id="btn-vod-save" variant="primary" size="small" @click="saveStorage">
          Enregistrer
        </Button>
        <!-- The button only makes sense if the hub has keys: without them there is
             a rien à éprouver, et le panneau le dit déjà en haut. -->
        <Button
          id="btn-vod-probe"
          size="small"
          :disabled="storage?.endpoint == null || checking"
          @click="probeStorage"
        >
          Éprouver la connexion
        </Button>
      </div>

      <div id="vod-check" class="mt-2">
        <!-- The check makes four network round trips: without this word, one
             croit que le bouton n'a rien fait et on reclique. -->
        <Hint v-if="checking" class="mt-0">Contrôle en cours…</Hint>
        <div
          v-else-if="check != null"
          class="rounded-lg border p-2"
          :class="check.ok ? 'border-edge' : 'border-alert/40'"
        >
          <div
            class="mb-1 text-[11px] font-semibold tracking-[.08em] uppercase"
            :class="check.ok ? 'text-dim' : 'text-alert'"
          >
            {{ check.ok ? 'Stockage joignable et accessible en écriture' : 'Contrôle interrompu' }}
          </div>
          <!-- The last step attempted carries the reason; the earlier ones say
               jusqu'où on est allé, ce qui est la moitié de l'information. -->
          <div
            v-for="step in check.etapes"
            :key="step.nom"
            class="flex items-baseline gap-2 text-[12px]"
          >
            <span>{{ step.ok ? '✓' : '✗' }}</span>
            <span :class="step.ok ? '' : 'text-alert'">
              {{ STORAGE_STEPS[step.nom] ?? step.nom }}
            </span>
            <span v-if="step.detail != null" class="min-w-0 flex-1 break-words text-dim">
              {{ step.detail }}
            </span>
          </div>
        </div>
      </div>
    </Panel>

    <Panel title="Diffusion">
      <Hint id="stream-state" class="mt-0 mb-3">
        Où chaque salle pousse son flux. Le hub garde la clé chiffrée et ne la redonne qu'à
        <strong>sa</strong> salle ; elle ne réapparaît jamais ici, même pour vous. Une salle
        n'obtient « Diffuser » que si le serveur <em>et</em> la clé sont renseignés.
      </Hint>

      <Empty v-if="streams.length === 0">Aucune salle déclarée.</Empty>

      <div v-for="item in streams" :key="item.roomId" class="border-t border-edge py-3 first:border-t-0 first:pt-0">
        <div class="mb-1.5 flex items-baseline justify-between gap-3">
          <strong class="text-sm">{{ item.name }}</strong>
          <span class="text-xs" :class="streamState(item).ok ? 'text-dim' : 'text-alert'">
            {{ streamState(item).text }}
          </span>
        </div>

        <label class="mb-[5px] block text-xs text-dim" :for="`stream-url-${item.roomId}`">
          Serveur
        </label>
        <input
          :id="`stream-url-${item.roomId}`"
          :value="draftOf(item.roomId).rtmpUrl"
          type="text"
          maxlength="500"
          placeholder="rtmp://live.exemple.fr/app"
          class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
          @input="
            streamDrafts[item.roomId] = {
              ...draftOf(item.roomId),
              rtmpUrl: ($event.target as HTMLInputElement).value,
              touched: true,
            }
          "
        />

        <label class="mb-[5px] block text-xs text-dim" :for="`stream-key-${item.roomId}`">
          Clé
        </label>
        <input
          :id="`stream-key-${item.roomId}`"
          :value="draftOf(item.roomId).streamKey"
          type="password"
          autocomplete="off"
          maxlength="500"
          :placeholder="item.hasKey ? '•••••••• — laisser vide pour conserver' : 'Aucune clé enregistrée'"
          class="mb-[11px] w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
          @input="
            streamDrafts[item.roomId] = {
              ...draftOf(item.roomId),
              streamKey: ($event.target as HTMLInputElement).value,
              touched: true,
            }
          "
        />

        <div class="flex gap-1.5">
          <Button
            :id="`btn-stream-save-${item.roomId}`"
            variant="primary"
            class="flex-1"
            :disabled="draftOf(item.roomId).saving"
            @click="saveStream(item)"
          >
            Enregistrer
          </Button>
          <Button
            :id="`btn-stream-clear-${item.roomId}`"
            :disabled="item.rtmpUrl === '' && !item.hasKey"
            @click="askClearStream(item)"
          >
            Effacer
          </Button>
        </div>
      </div>
    </Panel>

    <Panel title="Resynchronisation des salles">
      <label class="mb-[5px] block text-xs text-dim" for="resync-room">
        Salle à resynchroniser
      </label>
      <select
        id="resync-room"
        v-model="resyncRoom"
        class="mb-3 w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
      >
        <option value="">Toutes les salles</option>
        <option v-for="room in rooms" :key="room.id" :value="room.id">{{ room.name }}</option>
      </select>
      <Button id="btn-resync" class="w-full" @click="resyncConfirmation = true">
        Demander une resynchronisation
      </Button>
    </Panel>

    <ConfirmDialog
      v-model:open="resyncConfirmation"
      title="Resynchronisation"
      confirm-label="Demander"
      @confirm="confirmResync"
    >
      <span id="resync-text">
        Demander une resynchronisation complète à
        <strong>{{ resyncRoomName ?? 'toutes les salles' }}</strong>.
      </span>
    </ConfirmDialog>

    <ConfirmDialog
      v-model:open="clearStreamConfirmation"
      title="Effacer la diffusion"
      confirm-label="Effacer"
      @confirm="confirmClearStream"
    >
      <span id="clear-stream-text">
        <strong>{{ streamToClear?.name }}</strong> ne pourra plus diffuser, et la clé est perdue
        pour le hub : il faudra la reprendre là où elle a été émise.
      </span>
    </ConfirmDialog>

    <IntegrationDialog v-model:open="integrationDialog" :integration="editedIntegration" />

    <ConfirmDialog
      v-model:open="removeConfirmation"
      title="Supprimer l'intégration"
      confirm-label="Supprimer"
      @confirm="confirmRemoveIntegration"
    >
      Plus aucun avis ne partira vers <strong>{{ integrationToRemove?.name }}</strong>.
    </ConfirmDialog>
  </div>
</template>
