<script setup lang="ts">
import { BANNER_TEMPLATES, type Banner } from '@conference-operator/contract'
import {
  Badge,
  Button,
  ConfirmDialog,
  Empty,
  Field,
  Hint,
  Panel,
  Select,
  useToast,
} from '@conference-operator/components'
import { timeAgo } from '@conference-operator/format'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UrgentConfirmDialog from '../components/UrgentConfirmDialog.vue'
import { useMessagesStore, type UrgentProof } from '../stores/messages.js'
import { useSessionStore } from '../stores/session.js'
import { useFeaturesStore } from '../stores/features.js'

/**
 * What the hub addresses to the rooms.
 *
 * Two gestures nothing brings together but the screen: a **message**, which takes
 * the whole room or speaks to the operator, and a **live banner**, which is
 * composited over the video without interrupting anything — that is the whole
 * difference, and it justifies the two not looking alike.
 *
 * Both leave for the room chosen at the top of the page, and each says so again
 * in its own panel: the selector used to sit inside the message form, and the
 * banner went to "the rooms chosen above" without naming them.
 */
const store = useMessagesStore()
const features = useFeaturesStore()
void features.load()

/** The "Questions" template points the room at the wall: gone with the questions. */
const templates = computed(() =>
  BANNER_TEMPLATES.filter((template) => template.name !== 'Questions' || features.questions),
)
const { rooms, banners, target, onScreens, screenLog } = storeToRefs(store)
const toast = useToast()
const session = useSessionStore()
const canUrgent = computed(() => session.can('message:urgent'))

const ALL_LEVELS = [
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Important' },
  { value: 'urgent', label: 'Urgent' },
]
/** Urgent is its own right: not offered to an account without it — the hub refuses it anyway. */
const LEVELS = computed(() => ALL_LEVELS.filter((option) => option.value !== 'urgent' || canUrgent.value))

const recipients = computed(() => [
  { value: '', label: 'Toutes les salles' },
  ...rooms.value.map((room) => ({ value: room.id, label: room.name })),
])

function roomName(roomId: string | null): string {
  if (roomId == null) return 'Toutes les salles'
  return rooms.value.find((room) => room.id === roomId)?.name ?? roomId
}

const targetName = computed(() => roomName(target.value === '' ? null : target.value))

const text = ref('')
const level = ref<'info' | 'warning' | 'urgent'>('info')
const audience = ref<'operator' | 'audience'>('operator')
const minutesInput = ref('')

/**
 * Says where the message goes **before** it leaves.
 *
 * The confusion would cost dearly: a note to the operator projected in front of
 * the audience cannot be undone. The warning is therefore computed, not fired by a
 * `change` — which is what guarantees it is right on the first render and not only
 * after the first interaction.
 */
const toAudience = computed(() => audience.value === 'audience')

/** Asked before anything goes up on a room's projector — never after. */
const confirmOpen = ref(false)
const screens = computed(() =>
  target.value === '' ? 'les écrans de toutes les salles' : `l'écran de ${targetName.value}`,
)

const bannerText = ref('')
const bannerLevel = ref<'info' | 'warning' | 'urgent'>('info')

/** Changing room changes the history being consulted. */
watch(target, () => void store.load())

// — Urgent: confirmed by who sends it (see `UrgentConfirmDialog`) —
const urgentOpen = ref(false)
const urgentProof = ref<UrgentProof | null>(null)
/** What the urgent dialog would send: a message, or a banner. */
const urgentKind = ref<'message' | 'banner'>('message')
const urgentText = computed(() => (urgentKind.value === 'message' ? text.value : bannerText.value))
const urgentSummary = computed(() =>
  urgentKind.value === 'banner'
    ? `Bandeau urgent sur ${target.value === '' ? 'toutes les salles' : targetName.value}, par-dessus le live.`
    : toAudience.value
      ? `Projeté en urgence sur ${screens.value}, sur le bandeau live et sur l'écran global du hall.`
      : `Alerte urgente dans la régie de ${target.value === '' ? 'toutes les salles' : targetName.value}.`,
)

async function askUrgent(kind: 'message' | 'banner'): Promise<void> {
  urgentKind.value = kind
  urgentProof.value = null
  urgentOpen.value = true
  try {
    urgentProof.value = await store.urgentProof()
  } catch {
    urgentOpen.value = false
  }
}

async function confirmUrgent(password: string | undefined): Promise<void> {
  if (urgentKind.value === 'banner') await deliverBanner(password)
  else await deliver(password)
}

/**
 * Through the provider and back, the draft kept for the way back.
 *
 * In `sessionStorage`: it is this tab's, and dies with it. The page reopens the
 * dialog on return, with the fields as they were.
 */
const DRAFT = 'messages.urgent-draft'

function reauth(): void {
  const draft = {
    kind: urgentKind.value,
    target: target.value,
    text: text.value,
    level: level.value,
    audience: audience.value,
    minutes: minutesInput.value,
    bannerText: bannerText.value,
    bannerLevel: bannerLevel.value,
  }
  try {
    globalThis.sessionStorage.setItem(DRAFT, JSON.stringify(draft))
  } catch {
    // No storage: the draft is lost, the operator will retype it.
  }
  void session.reauthWithGoogle()
}

function restoreDraft(): void {
  let raw: string | null = null
  try {
    raw = globalThis.sessionStorage.getItem(DRAFT)
    globalThis.sessionStorage.removeItem(DRAFT)
  } catch {
    return
  }
  if (raw == null) return
  const draft = JSON.parse(raw) as {
    kind: 'message' | 'banner'
    target: string
    text: string
    level: 'info' | 'warning' | 'urgent'
    audience: 'operator' | 'audience'
    minutes: string
    bannerText: string
    bannerLevel: 'info' | 'warning' | 'urgent'
  }
  target.value = draft.target
  text.value = draft.text
  level.value = draft.level
  audience.value = draft.audience
  minutesInput.value = draft.minutes
  bannerText.value = draft.bannerText
  bannerLevel.value = draft.bannerLevel
  void askUrgent(draft.kind)
}

// The room screens: polled, they come up through the rooms' outbox.
let screensTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  restoreDraft()
  void store.loadScreens().catch(() => {})
  screensTimer = setInterval(() => void store.loadScreens().catch(() => {}), 10_000)
})
onBeforeUnmount(() => {
  if (screensTimer != null) clearInterval(screensTimer)
})

/**
 * Taking a screen's message down, whoever put it up.
 *
 * The room reports the removal through its outbox: the list is re-read a few
 * seconds later rather than trimmed here, so that it keeps saying what the
 * screens really show.
 */
async function clearScreen(roomId: string | null): Promise<void> {
  try {
    await store.clearScreen(roomId)
    toast.say(roomId == null ? 'Retrait demandé à toutes les salles' : `Retrait demandé à ${roomName(roomId)}`)
    setTimeout(() => void store.loadScreens().catch(() => {}), 3_000)
  } catch {
    /* already reported */
  }
}

const LEVEL_LABELS: Record<string, string> = { info: 'Info', warning: 'Important', urgent: 'Urgent' }
const SOURCE_LABELS: Record<string, string> = { regie: 'régie', hub: 'console' }

function send(): void {
  if (text.value.trim().length === 0) {
    toast.fail('Renseignez un message')
    return
  }
  if (level.value === 'urgent') {
    void askUrgent('message')
    return
  }
  if (toAudience.value) {
    confirmOpen.value = true
    return
  }
  void deliver()
}

async function deliver(password?: string): Promise<void> {
  const minutes = Number(minutesInput.value)
  try {
    await store.send({
      text: text.value.trim(),
      level: level.value,
      audience: audience.value,
      minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
      ...(password != null ? { password } : {}),
    })
    text.value = ''
    toast.say('Message envoyé')
    void store.loadScreens().catch(() => {})
  } catch {
    // Already reported by the client's error hook.
  }
}

/**
 * A template fills the field, it does not send.
 *
 * It is a starting point, not a rail: the date, the duration and the room's name
 * change every time.
 */
function applyTemplate(banner: Banner): void {
  bannerText.value = banner.text
  bannerLevel.value = banner.level
}

async function showBanner(): Promise<void> {
  if (bannerText.value.trim().length === 0) {
    toast.fail('Renseignez un texte')
    return
  }
  if (bannerLevel.value === 'urgent') {
    void askUrgent('banner')
    return
  }
  await deliverBanner()
}

async function deliverBanner(password?: string): Promise<void> {
  try {
    await store.showBanner({ text: bannerText.value.trim(), level: bannerLevel.value }, password)
    toast.say('Bandeau affiché')
  } catch {
    /* already reported */
  }
}

/** Putting a past banner back: an urgent one goes through the confirmation again. */
function replay(message: Banner): void {
  if (message.level === 'urgent') {
    bannerText.value = message.text
    bannerLevel.value = message.level
    void askUrgent('banner')
    return
  }
  void store.showBanner(message)
}

async function hideBanner(): Promise<void> {
  try {
    await store.hideBanner()
    toast.say('Bandeau retiré')
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <div id="messages-view" class="flex flex-col gap-3.5">
    <Panel>
      <div class="flex flex-wrap items-end gap-x-4 gap-y-1">
        <div class="w-full max-w-sm">
          <Select id="msg-room" v-model="target" label="Salle ciblée" :options="recipients" />
        </div>
        <Hint class="flex-1">
          Le message et le bandeau live partent tous deux vers cette salle.
        </Hint>
      </div>
    </Panel>

    <Panel>
      <div class="mb-2.5 flex flex-wrap items-center gap-2">
        <h2 class="mb-0 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
          Envoyer un message
        </h2>
        <Badge id="msg-target" class="px-1.5 py-0.5 text-[11px] tracking-normal">
          → {{ targetName }}
        </Badge>
      </div>

      <Field id="msg-text" v-model="text" label="Message" placeholder="Texte du message" />
      <div class="grid gap-x-3 sm:grid-cols-[2fr_1fr_1fr]">
        <Select
          id="msg-audience"
          v-model="audience"
          label="Qui le voit"
          :options="[
            { value: 'operator', label: `L'opérateur de la salle (bandeau de régie)` },
            { value: 'audience', label: 'Le public (écran de la salle)' },
          ]"
        />
        <Select id="msg-level" v-model="level" label="Niveau" :options="LEVELS" />
        <!--
          `inputmode` et non `type="number"` : Vue applique un cast numérique
          implicite aux `input[type=number]`, et rendait donc un `number` au
          `defineModel<string>` de `Field` — un avertissement à chaque frappe, et
          un modèle qui ment sur son type. Le champ reste numérique là où ça
          compte, le clavier du téléphone, et il peut être réellement vide : c'est
          cette valeur-là qui signifie « jusqu'à remplacement ».
        -->
        <Field
          id="msg-minutes"
          v-model="minutesInput"
          inputmode="numeric"
          label="Durée (min, vide = jusqu'à remplacement)"
          placeholder="10"
        />
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <Hint id="msg-warning" class="flex-1">
          <template v-if="toAudience">
            <strong class="text-warn">Ce message sera projeté devant le public</strong>
            et remplacera ce qui est à l'écran.
          </template>
          <template v-else>
            Ce message n'apparaîtra que dans le bandeau de la régie, pas sur l'écran de la salle.
          </template>
        </Hint>
        <Button id="btn-send-message" variant="primary" class="shrink-0" @click="send">
          Envoyer
        </Button>
      </div>
    </Panel>

    <!--
      Bandeau live : superposé à la vidéo, il n'interrompt rien — c'est toute
      la différence avec un message d'écran, qui prend la salle entière.
    -->
    <Panel>
      <div class="mb-2.5 flex flex-wrap items-center gap-2">
        <h2 class="mb-0 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
          Bandeau live
        </h2>
        <Badge id="banner-target" class="px-1.5 py-0.5 text-[11px] tracking-normal">
          → {{ targetName }}
        </Badge>
        <Button id="btn-banner-hide" size="small" class="ml-auto" @click="hideBanner">
          Masquer le bandeau
        </Button>
      </div>

      <div id="banner-templates" class="mb-[11px] flex flex-wrap gap-1.5">
        <Button
          v-for="template in templates"
          :key="template.name"
          size="small"
          @click="applyTemplate(template.message)"
        >
          {{ template.name }}
        </Button>
      </div>

      <div class="mb-[11px] flex flex-wrap gap-1.5">
        <input
          id="banner-text"
          v-model="bannerText"
          maxlength="240"
          placeholder="Texte du bandeau"
          class="min-w-0 flex-1 basis-60 rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
        />
        <select
          id="banner-level"
          v-model="bannerLevel"
          class="w-auto shrink-0 rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text"
        >
          <option v-for="option in LEVELS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
        <Button id="btn-banner-show" variant="primary" class="shrink-0" @click="showBanner">
          Afficher
        </Button>
      </div>

      <Hint>
        Part dans <strong>{{ targetName }}</strong> et se superpose aux scènes live —
        le talk continue dessous. Un modèle remplit le champ : le texte reste
        modifiable avant envoi.
      </Hint>

      <h3 class="mt-3.5 mb-2.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
        Déjà passés
      </h3>
      <div id="banner-history">
        <Empty v-if="banners.length === 0">Aucun bandeau diffusé pour le moment.</Empty>
        <div
          v-for="(past, index) in banners"
          :key="`${past.issuedAt}-${index}`"
          class="flex items-center gap-3 border-t border-edge py-3 first:border-t-0"
        >
          <div class="flex-1">
            <strong class="mb-[3px] block text-sm">{{ past.message.text }}</strong>
            <span class="text-xs text-dim">
              {{ past.message.level }} · {{ timeAgo(past.issuedAt) }} ·
              {{ roomName(past.roomId) }}
            </span>
          </div>
          <Badge v-if="past.visible" variant="running">en cours</Badge>
          <Button
            size="small"
            @click="past.visible ? hideBanner() : replay(past.message)"
          >
            {{ past.visible ? 'Masquer' : 'Remettre' }}
          </Button>
        </div>
      </div>
    </Panel>

    <!--
      What the room screens say: the control apps' messages as well as the
      console's, reported by the rooms a few seconds after the fact.
    -->
    <Panel>
      <div class="mb-2.5 flex flex-wrap items-center gap-2">
        <h2 class="mb-0 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
          À l'écran dans les salles
        </h2>
        <Button
          v-if="onScreens.length > 1"
          id="btn-screens-clear-all"
          size="small"
          class="ml-auto"
          @click="clearScreen(null)"
        >
          Tout retirer
        </Button>
      </div>
      <div id="screens-current">
        <Empty v-if="onScreens.length === 0">Aucun message projeté en ce moment.</Empty>
        <div
          v-for="entry in onScreens"
          :key="entry.roomId"
          class="flex items-center gap-3 border-t border-edge py-3 first:border-t-0"
          :data-room="entry.roomId"
        >
          <div class="flex-1">
            <strong class="mb-[3px] block text-sm break-words">{{ entry.text }}</strong>
            <span class="text-xs text-dim">
              {{ entry.roomName ?? entry.roomId }} · depuis la {{ SOURCE_LABELS[entry.source ?? 'regie'] }}
              · {{ timeAgo(entry.occurredAt) }}
            </span>
          </div>
          <Badge :variant="entry.level === 'urgent' ? 'alert' : entry.level === 'warning' ? 'warning' : 'neutral'">
            {{ LEVEL_LABELS[entry.level ?? 'info'] }}
          </Badge>
          <Button size="small" :data-role="`btn-screen-clear-${entry.roomId}`" @click="clearScreen(entry.roomId)">
            Retirer
          </Button>
        </div>
      </div>

      <h3 class="mt-3.5 mb-2.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
        Journal des écrans
      </h3>
      <div id="screens-log">
        <Empty v-if="screenLog.length === 0">Aucun message d'écran pour le moment.</Empty>
        <div
          v-for="(entry, index) in screenLog"
          :key="`${entry.roomId}-${entry.occurredAt}-${index}`"
          class="border-t border-edge py-2 text-xs first:border-t-0"
        >
          <span class="text-dim">{{ timeAgo(entry.occurredAt) }} · {{ entry.roomName ?? entry.roomId }} ·</span>
          <template v-if="entry.action === 'shown'">
            <strong class="text-text">{{ entry.text }}</strong>
            <span class="text-dim">
              ({{ LEVEL_LABELS[entry.level ?? 'info'] }}, {{ SOURCE_LABELS[entry.source ?? 'regie'] }})
            </span>
          </template>
          <span v-else class="text-dim">retiré de l'écran</span>
        </div>
      </div>
    </Panel>

    <UrgentConfirmDialog
      v-model:open="urgentOpen"
      :proof="urgentProof"
      :summary="urgentSummary"
      :text="urgentText"
      @confirm="confirmUrgent"
      @reauth="reauth"
    />

    <ConfirmDialog
      v-model:open="confirmOpen"
      title="Projeter devant le public ?"
      tone="warn"
      confirm-label="Projeter"
      @confirm="deliver"
    >
      <p id="msg-confirm-text">
        Ce message va s'afficher sur <strong>{{ screens }}</strong> et remplacer ce qui y est
        projeté :
      </p>
      <p class="mt-2 rounded-lg border border-edge bg-canvas p-3 break-words">{{ text }}</p>
    </ConfirmDialog>
  </div>
</template>
