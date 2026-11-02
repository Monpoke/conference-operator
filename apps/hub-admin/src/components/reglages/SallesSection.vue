<script setup lang="ts">
import { Button, ConfirmDialog, Empty, Hint, Panel, useToast } from '@conference-operator/components'
import { storeToRefs } from 'pinia'
import { ref, watch } from 'vue'
import { useSettingsStore, type RoomStream } from '../../stores/settings.js'

/**
 * Réglages, Salles: what each room may stream and show, and what it asks for.
 *
 * Mounted with its siblings and only hidden: a draft survives a change of section.
 */
const store = useSettingsStore()
const { settings, rooms, streams } = storeToRefs(store)
const toast = useToast()

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

// — Room screens —
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
  { value: 'message', label: 'Message', hint: 'La bannière saisie en régie ou envoyée depuis la console.' },
  { value: 'feedback', label: 'Notez le talk', hint: 'Le QR code OpenFeedback du talk en cours.' },
  { value: 'wall', label: 'Mur & questions', hint: 'Les messages du public, modérés en régie.' },
  { value: 'question', label: 'Question choisie', hint: 'Une question du public, en grand.' },
  { value: 'wallsio', label: 'Mur social', hint: 'walls.io, les messages du public et les posts partenaires, en mosaïque.' },
  { value: 'rooms', label: 'Pendant ce temps…', hint: 'Ce qui se passe dans les autres salles.' },
  { value: 'socials', label: 'Nos réseaux', hint: 'Les comptes déclarés dans la section Événement.' },
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

// — Control app PIN (urgent messages from a room) —
const pin = ref('')

async function savePin(clear: boolean): Promise<void> {
  if (!clear && !/^\d{4,12}$/.test(pin.value)) {
    toast.say('Le code doit faire 4 à 12 chiffres')
    return
  }
  try {
    await store.setUrgentPin(clear ? null : pin.value)
    pin.value = ''
    toast.say(clear ? 'Code supprimé : les salles refuseront les messages urgents' : 'Code enregistré')
  } catch {
    /* already reported */
  }
}

// — Rooms nobody records —
async function setSansCaptation(roomId: string, none: boolean): Promise<void> {
  const others = (settings.value?.sallesSansCaptation ?? []).filter((id) => id !== roomId)
  try {
    await store.update({ sallesSansCaptation: none ? [...others, roomId] : others })
    toast.say(none ? 'Salle sans captation' : 'Captation prévue dans cette salle')
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <div class="flex flex-col gap-3.5">
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
            size="small"
            :disabled="draftOf(item.roomId).saving"
            @click="saveStream(item)"
          >
            Enregistrer
          </Button>
          <Button
            :id="`btn-stream-clear-${item.roomId}`"
            size="small"
            :disabled="item.rtmpUrl === '' && !item.hasKey"
            @click="askClearStream(item)"
          >
            Effacer
          </Button>
        </div>
      </div>
    </Panel>

    <Panel title="Écrans de salle">
      <p class="mb-2 text-[13px] text-dim">
        Ce qu'une régie peut choisir d'afficher, et ce que la boucle d'attente fait défiler.
        Retirer un écran ne change rien à ce qui est projeté en ce moment : c'est la régie
        qui décide, salle par salle.
      </p>

      <div id="screens" class="grid gap-x-6 border-t border-edge pt-2 md:grid-cols-2">
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

    <Panel title="Code PIN régie (messages urgents)">
      <Hint id="pin-state" class="mt-0 mb-3">
        <template v-if="store.urgentPinSet">Un code est défini.</template>
        <template v-else>
          Aucun code : les régies de salle refusent les messages urgents.
        </template>
        Demandé par la régie locale d'une salle pour afficher un message urgent — il est vérifié sur
        le poste, même sans hub.
      </Hint>
      <label for="urgent-pin">Nouveau code (4 à 12 chiffres)</label>
      <input
        id="urgent-pin"
        v-model="pin"
        type="password"
        inputmode="numeric"
        autocomplete="new-password"
        class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text"
      />
      <div class="mt-3 flex gap-2">
        <Button id="btn-pin-save" variant="primary" size="small" @click="savePin(false)">
          Enregistrer le code
        </Button>
        <Button v-if="store.urgentPinSet" id="btn-pin-clear" size="small" @click="savePin(true)">Supprimer</Button>
      </div>
    </Panel>

    <Panel title="Salles sans captation">
      <!-- Ne descend pas aux salles : seule la lecture d'un rush manquant change. -->
      <fieldset data-role="salles-sans-captation">
        <legend class="mb-2 text-[13px] text-dim">Un rush manquant y est normal : la VOD ne le signale pas comme un problème.</legend>
        <label v-for="room in rooms" :key="room.id" class="flex items-center gap-2 py-0.5 text-sm">
          <input
            type="checkbox"
            :data-sans-captation="room.id"
            :checked="settings?.sallesSansCaptation?.includes(room.id) ?? false"
            @change="setSansCaptation(room.id, ($event.target as HTMLInputElement).checked)"
          >
          {{ room.name }}
        </label>
      </fieldset>
    </Panel>

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
  </div>
</template>
