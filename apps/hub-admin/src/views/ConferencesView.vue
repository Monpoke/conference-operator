<script setup lang="ts">
import { isTransitionAllowed } from '@cloudnord/room-state'
import { Badge, Button, Empty, Hint, Panel, useToast } from '@cloudnord/components'
import { timeFormatter } from '@cloudnord/format'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import FeedbackIdDialog from '../components/FeedbackIdDialog.vue'
import VodFolderDialog from '../components/VodFolderDialog.vue'
import {
  overrideChoice,
  placeInDay,
  useConferencesStore,
  type FeedbackCheck,
  type PlannedSession,
  type SessionState,
} from '../stores/conferences.js'

/**
 * The talks, and the schedule.
 *
 * Two tables in the same tab because they answer two questions asked one after the
 * other: "where are we" and then "what comes next". Splitting them into two views
 * would mean navigating between them all day long.
 *
 * Every time is read in the **event's** time zone. The console opens from
 * anywhere — a train, another country — and the program does not shift: showing
 * the machine's own time would announce a talk an hour too early to whoever rings
 * the room.
 */
const store = useConferencesStore()
const { states, planning, hasActiveProgram, room, actionsShown } = storeToRefs(store)
const toast = useToast()

const zone = computed(() => planning.value?.timezone ?? 'Europe/Paris')

const hour = (iso: string | null | undefined): string =>
  iso == null ? '—' : timeFormatter(zone.value).format(new Date(iso))

const slots = computed(() =>
  (planning.value?.sessions ?? []).filter(
    (session) => room.value === '' || session.roomId === room.value,
  ),
)

/**
 * The day only appears when there is more than one.
 *
 * At a one-day event it would say nothing and take the title's place.
 */
const dayFormatter = computed(
  () =>
    new Intl.DateTimeFormat('fr-FR', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      timeZone: zone.value,
    }),
)

const severalDays = computed(
  () => new Set(slots.value.map((s) => dayFormatter.value.format(new Date(s.startsAt)))).size > 1,
)

/** The hub's time, not the browser's: it may be simulated, and it is authoritative. */
const now = computed(() =>
  planning.value == null ? Date.now() : Date.parse(planning.value.serverTime),
)

function placeOf(session: PlannedSession): 'a-venir' | 'en-cours' | 'passe' {
  return placeInDay(session, now.value)
}

function slotLabel(session: PlannedSession): string {
  const day = severalDays.value
    ? `${dayFormatter.value.format(new Date(session.startsAt))} `
    : ''
  const end = session.endsAt == null ? '' : `–${hour(session.endsAt)}`
  return `${day}${hour(session.startsAt)}${end}`
}

/** What is left of the slot: the overrun is what triggers a decision. */
function remaining(state: SessionState): { text: string; tone: string } {
  if (state.status !== 'running' || state.remainingMs == null) {
    return { text: '—', tone: 'text-dim' }
  }
  const minutes = Math.round(state.remainingMs / 60000)
  if (minutes >= 0) {
    return { text: `${minutes} min`, tone: minutes <= 5 ? 'text-warn' : '' }
  }
  return { text: `+${Math.abs(minutes)} min`, tone: 'font-semibold text-alert' }
}

/**
 * The actions follow the lifecycle table, not a condition written here.
 *
 * It is the table the hub applies on write and the control app reads to grey out
 * its buttons. A hand-written condition said the same thing — but by a maintained
 * coincidence, and it is that kind of coincidence that stops being true the day the
 * table changes.
 */
function actions(etat: SessionState): { libelle: string; action: 'start' | 'end' | 'reset'; danger: boolean }[] {
  const offertes: { libelle: string; action: 'start' | 'end' | 'reset'; danger: boolean }[] = []
  if (isTransitionAllowed(etat.status as never, 'end')) {
    offertes.push({ libelle: 'Terminer', action: 'end', danger: false })
  }
  if (isTransitionAllowed(etat.status as never, 'start')) {
    offertes.push({
      libelle: etat.status === 'ended' ? 'Relancer' : 'Commencer',
      action: 'start',
      danger: false,
    })
  }
  if (isTransitionAllowed(etat.status as never, 'reset')) {
    offertes.push({ libelle: 'Remettre à venir', action: 'reset', danger: true })
  }
  return offertes
}

async function agir(etat: SessionState, action: 'start' | 'end' | 'reset'): Promise<void> {
  try {
    await store.decide(etat.sessionId, action)
    toast.say('Conférence mise à day')
  } catch {
    /* already reported */
  }
}

/**
 * What actually happened: what the lifecycle really recorded.
 *
 * The full instant goes into the tooltip — the time is enough to read the day, the
 * whole date serves editing and the VOD export.
 */
function actual(session: PlannedSession): { text: string; running: boolean; title: string } | null {
  if (session.startedAt == null) return null
  const by =
    session.decidedBy == null
      ? ''
      : ` · décidé par ${session.decidedBy === 'auto' ? 'la règle horaire' : session.decidedBy}`
  return {
    text: hour(session.startedAt),
    running: session.endedAt == null,
    title: session.startedAt + (session.endedAt == null ? '' : ` → ${session.endedAt}`) + by,
  }
}

const decisions = computed(
  () => (planning.value?.sessions ?? []).filter((s) => s.overriddenAs != null).length,
)

async function changeOverride(session: PlannedSession, menu: HTMLSelectElement): Promise<void> {
  // The contract accepts only these two words, or nothing: the menu offers no
  // others, but it is the type that guarantees it rather than trust.
  const action = menu.value === '' ? null : (menu.value as 'talk' | 'break')
  const before = session.overriddenAs ?? ''
  try {
    await store.override(session.id, action)
    toast.say(
      action === 'break'
        ? 'Créneau considéré comme break'
        : action === 'talk'
          ? 'Créneau considéré comme conférence'
          : 'Créneau rendu au programme',
    )
  } catch {
    /*
     * Put back by hand to its previous value.
     *
     * Reloading the store is not enough: the data comes back identical, so Vue sees
     * no change to propagate and the `<select>` keeps the option the operator
     * clicked. The menu would then stay on a decision nobody saved — one that
     * reaches neither the rooms nor the QR codes.
     */
    menu.value = before
  }
}

const check = ref<FeedbackCheck | null>(null)
const checkError = ref('')
const checking = ref(false)

async function verifierLiens(): Promise<void> {
  checking.value = true
  checkError.value = ''
  check.value = null
  try {
    check.value = await store.checkFeedback()
  } catch (cause) {
    checkError.value = cause instanceof Error ? cause.message : 'Contrôle impossible.'
  } finally {
    checking.value = false
  }
}

const feedbackOpen = ref(false)
const feedbackSlot = ref<PlannedSession | null>(null)

function openFeedback(session: PlannedSession): void {
  feedbackSlot.value = session
  feedbackOpen.value = true
}

const vodOpen = ref(false)
const vodSlot = ref<PlannedSession | null>(null)

function openVod(session: PlannedSession): void {
  vodSlot.value = session
  vodOpen.value = true
}
</script>

<template>
  <div
    id="conferences-view"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5"
  >
    <Panel class="col-span-full" title="Conférences — toutes salles">
      <div class="overflow-x-auto">
        <table class="w-full border-collapse text-[13px]">
          <thead>
            <tr class="text-[11px] tracking-[.08em] text-dim uppercase">
              <th class="pr-2.5 pb-2 text-left font-semibold">Salle</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Conférence</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Prévu</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Reste</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">État</th>
              <th class="pb-2"></th>
            </tr>
          </thead>
          <tbody id="conferences">
            <tr v-if="!hasActiveProgram">
              <td colspan="6"><Empty>Aucun programme actif.</Empty></td>
            </tr>
            <tr v-else-if="states.length === 0">
              <td colspan="6">
                <Empty>
                  Aucune conférence démarrée pour le moment. Les décisions se prennent depuis la
                  régie de chaque salle, ou ici une fois lancées.
                </Empty>
              </td>
            </tr>
            <tr v-for="etat in states" v-else :key="etat.sessionId" :data-session="etat.sessionId">
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
                {{ etat.roomName ?? etat.roomId ?? '—' }}
              </td>
              <!-- The title, not the identifier: nobody recognises a talk by its id. -->
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
                {{ etat.title ?? etat.sessionId }}
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle text-dim">
                {{ etat.scheduledStartsAt == null
                  ? '—'
                  : `${hour(etat.scheduledStartsAt)}–${hour(etat.scheduledEndsAt)}` }}
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
                <span :class="remaining(etat).tone">{{ remaining(etat).text }}</span>
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
                <Badge :variant="etat.status === 'running' ? 'running' : 'ended'">
                  {{ etat.status === 'running' ? 'en cours' : 'terminée' }}
                </Badge>
                <!--
                  L'auteur, et pas seulement le fait que ce soit automatique. Une
                  case vide sur une décision humaine laissait « je n'ai pas fait
                  ça » sans réponse : c'est la première question posée devant
                  cette ligne.
                -->
                <span v-if="etat.decidedBy != null" class="ml-1 text-dim">
                  {{ etat.decidedBy === 'auto' ? 'auto' : etat.decidedBy }}
                </span>
              </td>
              <td class="border-t border-edge py-[9px] align-middle">
                <div class="flex gap-1.5">
                  <Button
                    v-for="offerte in actions(etat)"
                    :key="offerte.action"
                    size="small"
                    :variant="offerte.danger ? 'danger' : 'neutral'"
                    @click="agir(etat, offerte.action)"
                  >
                    {{ offerte.libelle }}
                  </Button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>

    <!--
      Le planning, en dessous, et dans le même onglet.

      Le tableau du dessus ne montre que ce qui a été **démarré** : il répond à
      « où en est-on », jamais à « et après, il y a quoi ». Or c'est la question
      qu'on pose à l'organisateur toute la journée, et jusqu'ici il fallait
      rouvrir le site de l'événement pour y répondre.
    -->
    <Panel class="col-span-full">
      <div class="mb-2.5 flex flex-wrap items-center gap-2">
        <h2 class="mb-0 flex-1 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
          Planning du programme actif
        </h2>
        <select
          id="planning-salle"
          v-model="room"
          class="w-auto shrink-0 rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text"
        >
          <option value="">Toutes les salles</option>
          <option v-for="salle in planning?.rooms ?? []" :key="salle.id" :value="salle.id">
            {{ salle.name }}
          </option>
        </select>
        <!--
          Le contrôle des liens de feedback : sur demande et non en continu. Il
          sort du hub pour interroger OpenFeedback, et c'est un geste
          d'before-événement — on le passe une fois le programme importé, on
          corrige ce qu'il signale, et on n'y revient plus.
        -->
        <Button
          id="btn-check-feedback"
          size="small"
          class="shrink-0"
          :disabled="checking"
          @click="verifierLiens"
        >
          Vérifier les liens
        </Button>
        <!--
          La colonne « Action » est repliée par défaut.

          Elle est la seule de ce tableau qui *écrit* quelque chose, au milieu de
          six colonnes qui ne font que lire — et elle écrit une décision qui se
          propage à toutes les surfaces : un créneau marqué break disparaît de
          l'antenne, de la régie et des QR. Un menu déroulant posé sur chaque
          ligne d'un planning qu'on parcourt toute la journée en cherchant un
          horaire finit par se cliquer sans qu'on l'ait voulu.

          La replier ne cache rien : le bouton dit combien de décisions sont en
          vigueur, et se déplie d'un clic.
        -->
        <Button
          id="btn-planning-actions"
          size="small"
          class="shrink-0"
          :aria-expanded="actionsShown"
          @click="actionsShown = !actionsShown"
        >
          {{ actionsShown ? 'Masquer les actions' : 'Modifier les créneaux'
          }}{{ decisions === 0 ? '' : ` (${decisions} décision${decisions > 1 ? 's' : ''})` }}
        </Button>
      </div>

      <div v-if="checking || check != null || checkError !== ''" id="check-feedback" class="mb-2.5">
        <Hint v-if="checking" class="mt-0">Interrogation d'OpenFeedback…</Hint>
        <Hint v-else-if="checkError !== ''" class="mt-0 text-alert">{{ checkError }}</Hint>
        <Hint v-else-if="check != null" class="mt-0">
          <!-- Project not found: the silliest and most total failure — a
               faute de frappe dans un champ, et les vingt-sept adresses sont mortes. -->
          <template v-if="!check.projetTrouve">
            <strong class="text-alert">
              Projet « {{ check.projet }} » introuvable chez OpenFeedback.
            </strong>
            {{ check.detail }}
          </template>
          <template v-else-if="check.talksConnus == null">
            <strong>Projet trouvé.</strong> {{ check.detail }}
          </template>
          <template v-else-if="check.manquants.length === 0">
            <strong class="text-ok">
              {{ check.talksConnus }} talks chez OpenFeedback, tous les créneaux ont le leur.
            </strong>
            {{ check.detail }}
          </template>
          <template v-else>
            <strong class="text-warn">
              {{ check.manquants.length }} créneau{{ check.manquants.length > 1 ? 'x' : '' }}
              sans page OpenFeedback
            </strong>
            <span class="text-dim">sur {{ check.talksConnus }} talks connus.</span>
            {{ check.detail }}
            <ul class="mt-1.5 list-disc pl-4">
              <li v-for="manquant in check.manquants" :key="manquant.feedbackId">
                {{ manquant.title }}
                <span class="font-mono text-[11px] text-dim">{{ manquant.feedbackId }}</span>
              </li>
            </ul>
          </template>
        </Hint>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full border-collapse text-[13px]">
          <thead>
            <tr class="text-[11px] tracking-[.08em] text-dim uppercase">
              <th class="pr-2.5 pb-2 text-left font-semibold">Prévu</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Réel</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Salle</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Conférence</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">Feedback</th>
              <th class="pr-2.5 pb-2 text-left font-semibold">VOD</th>
              <th v-if="actionsShown" class="pb-2 text-left font-semibold">Action</th>
            </tr>
          </thead>
          <tbody id="planning">
            <tr v-if="planning == null || planning.sessions.length === 0">
              <td colspan="7">
                <Empty>Aucun programme actif. Il s'importe depuis les réglages.</Empty>
              </td>
            </tr>
            <tr v-else-if="slots.length === 0">
              <td colspan="7"><Empty>Aucun créneau dans cette salle.</Empty></td>
            </tr>
            <tr
              v-for="session in slots"
              v-else
              :key="session.id"
              :data-creneau="session.id"
              :data-quand="placeOf(session)"
              :class="{
                'bg-surface2': placeOf(session) === 'en-cours',
                'opacity-55': placeOf(session) === 'passe',
              }"
            >
              <td
                class="border-t border-edge py-[9px] pr-2.5 align-middle whitespace-nowrap tabular-nums"
                :class="
                  placeOf(session) === 'en-cours' ? 'font-semibold text-text' : 'text-dim'
                "
              >
                <span
                  v-if="placeOf(session) === 'en-cours'"
                  class="mr-1.5 inline-block h-3.5 w-[3px] translate-y-0.5 rounded-full bg-brand"
                ></span>
                {{ slotLabel(session) }}
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle whitespace-nowrap tabular-nums">
                <span v-if="actual(session) == null" class="text-dim">—</span>
                <span v-else :title="actual(session)!.title">
                  {{ actual(session)!.text }}–<span
                    v-if="actual(session)!.running"
                    class="text-brand"
                    >en cours</span
                  ><template v-else>{{ hour(session.endedAt) }}</template>
                </span>
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle whitespace-nowrap">
                {{ session.roomName ?? '—' }}
              </td>
              <!--
                Les pauses restent dans la liste — elles font partie de la
                journée — mais en retrait : ce n'est pas ce qu'on cherche en
                ouvrant le planning.
              -->
              <td
                class="border-t border-edge py-[9px] pr-2.5 align-middle"
                :class="{ 'text-dim': session.kind === 'break' }"
              >
                {{ session.title }}
                <div v-if="session.speakers.length > 0" class="text-xs text-dim">
                  {{ session.speakers.join(', ') }}
                </div>
                <div v-if="session.sharedFrom != null" class="text-xs text-dim">
                  pause commune, héritée d'une autre salle
                </div>
                <!--
                  Dit en toutes lettres ce que le trait montre : le surlignage
                  seul se confondrait avec une ligne survolée, et l'hour
                  affichée peut être simulée — auquel cas « en ce moment » est la
                  seule chose qui explique pourquoi c'est cette ligne-là qui est
                  marquée.
                -->
                <div
                  v-if="placeOf(session) === 'en-cours'"
                  class="text-xs font-semibold text-brand"
                >
                  en ce moment
                </div>
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle whitespace-nowrap">
                <!-- An empty cell rather than a dead link: with no OpenFeedback project
                     réglé, ou sur une pause, il n'y a rien à noter. -->
                <a
                  v-if="session.feedbackUrl != null"
                  class="font-semibold text-brand no-underline"
                  target="_blank"
                  rel="noopener"
                  :href="session.feedbackUrl"
                >
                  noter ↗
                </a>
                <span v-else class="text-dim">—</span>
                <Button
                  v-if="session.kind !== 'break'"
                  size="small"
                  class="ml-1.5"
                  :class="session.feedbackIdOverride != null ? 'text-warn' : 'text-dim'"
                  :data-feedback-session="session.id"
                  :title="
                    session.feedbackIdOverride != null
                      ? 'Identifiant OpenFeedback corrigé'
                      : 'Identifiant OpenFeedback'
                  "
                  @click="openFeedback(session)"
                >
                  {{ session.feedbackIdOverride != null ? 'id ✱' : 'id' }}
                </Button>
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
                <!--
                  Rien sur une pause : personne ne cherche le rush du déjeuner, et
                  un bouton qui ouvrirait une modale vide sur vingt-sept lignes
                  ferait douter des vingt-sept.
                -->
                <Button
                  v-if="session.kind !== 'break' && session.sharedFrom == null"
                  size="small"
                  :data-vod-session="session.id"
                  title="Où en est la captation de cette conférence"
                  @click="openVod(session)"
                >
                  captation
                </Button>
                <span v-else class="text-dim">—</span>
              </td>
              <td v-if="actionsShown" class="border-t border-edge py-[9px] align-middle">
                <!--
                  Une pause héritée d'une autre salle ne s'édite pas ici : c'est
                  le créneau d'origine qu'on corrige, et la projection suit. Un
                  menu sur la copie laisserait croire à deux décisions
                  indépendantes.
                -->
                <span
                  v-if="session.sharedFrom != null"
                  class="text-dim"
                  title="Pause héritée d'une autre salle"
                >
                  héritée
                </span>
                <select
                  v-else
                  class="w-auto rounded-lg border border-edge bg-canvas px-2 py-1 text-xs text-text"
                  :data-session-action="session.id"
                  :value="session.overriddenAs ?? ''"
                  @change="changeOverride(session, $event.target as HTMLSelectElement)"
                >
                  <option value="">
                    Aucune — {{ overrideChoice(session).scheduled === 'break' ? 'pause' : 'conférence' }}
                    au programme
                  </option>
                  <option :value="overrideChoice(session).action">
                    {{ overrideChoice(session).action === 'talk'
                      ? 'Considérer comme conférence'
                      : 'Considérer comme break' }}
                  </option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Hint>
        « Prévu » vient du programme, « Réel » du cycle de vie — l'instant du « Commencer » et
        celui du « Terminer », clôture automatique comprise. Les deux sont lus dans le zone de
        l'événement, pas celui du poste d'où l'on regarde. Le lien « noter » ouvre la page
        OpenFeedback de la conférence, la même que celle du QR projeté en salle.
      </Hint>

      <Hint v-if="planning != null && planning.openFeedbackProjectId == null" id="planning-feedback-aide">
        <strong>Aucun projet OpenFeedback réglé</strong> : la colonne « Feedback » remaining vide, et
        les salles ne projettent aucun QR « notez ce talk ». Il se règle dans
        <strong>Réglages → L'événement</strong>, une fois pour tout l'événement.
      </Hint>
    </Panel>

    <FeedbackIdDialog v-model:open="feedbackOpen" :session="feedbackSlot" />
    <VodFolderDialog v-model:open="vodOpen" :session="vodSlot" :timezone="zone" />
  </div>
</template>
