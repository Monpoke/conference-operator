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
 * Les conférences, et le planning.
 *
 * Deux tableaux dans le même onglet parce qu'ils répondent à deux questions
 * qu'on se pose l'une après l'autre : « où en est-on » puis « et après ». Les
 * séparer en deux vues ferait naviguer entre les deux toute la journée.
 *
 * Toutes les heures sont lues dans le fuseau de l'**événement**. La console
 * s'ouvre depuis n'importe où — un train, un autre pays — et le programme, lui,
 * ne se décale pas : afficher l'heure du poste ferait annoncer un talk une
 * heure trop tôt à qui appelle la salle.
 */
const store = useConferencesStore()
const { states, planning, hasActiveProgram, room, actionsShown } = storeToRefs(store)
const toast = useToast()

const fuseau = computed(() => planning.value?.timezone ?? 'Europe/Paris')

const heure = (iso: string | null | undefined): string =>
  iso == null ? '—' : timeFormatter(fuseau.value).format(new Date(iso))

const creneaux = computed(() =>
  (planning.value?.sessions ?? []).filter(
    (session) => room.value === '' || session.roomId === room.value,
  ),
)

/**
 * Le jour n'apparaît que s'il y en a plusieurs.
 *
 * Sur un événement d'une journée, il ne dirait rien et prendrait la place du
 * titre.
 */
const jourFormatter = computed(
  () =>
    new Intl.DateTimeFormat('fr-FR', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      timeZone: fuseau.value,
    }),
)

const plusieursJours = computed(
  () => new Set(creneaux.value.map((s) => jourFormatter.value.format(new Date(s.startsAt)))).size > 1,
)

/** Heure du hub, pas du navigateur : elle peut être simulée, et elle fait foi. */
const maintenant = computed(() =>
  planning.value == null ? Date.now() : Date.parse(planning.value.serverTime),
)

function situer(session: PlannedSession): 'a-venir' | 'en-cours' | 'passe' {
  return placeInDay(session, maintenant.value)
}

function creneauLisible(session: PlannedSession): string {
  const jour = plusieursJours.value
    ? `${jourFormatter.value.format(new Date(session.startsAt))} `
    : ''
  const fin = session.endsAt == null ? '' : `–${heure(session.endsAt)}`
  return `${jour}${heure(session.startsAt)}${fin}`
}

/** Ce qui reste au programme : le dépassement est ce qui déclenche une décision. */
function reste(etat: SessionState): { texte: string; classe: string } {
  if (etat.status !== 'running' || etat.remainingMs == null) {
    return { texte: '—', classe: 'text-dim' }
  }
  const minutes = Math.round(etat.remainingMs / 60000)
  if (minutes >= 0) {
    return { texte: `${minutes} min`, classe: minutes <= 5 ? 'text-warn' : '' }
  }
  return { texte: `+${Math.abs(minutes)} min`, classe: 'font-semibold text-alert' }
}

/**
 * Les actions suivent la table du cycle de vie, pas une condition écrite ici.
 *
 * C'est celle que le hub applique en écriture et que la régie lit pour griser
 * ses boutons. Une condition écrite à la main disait la même chose — mais par
 * une coïncidence entretenue, et c'est ce genre de coïncidence qui cesse d'être
 * vraie le jour où la table change.
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
    toast.say('Conférence mise à jour')
  } catch {
    /* déjà remonté */
  }
}

/**
 * Le vécu : ce que le cycle de vie a réellement enregistré.
 *
 * L'instant complet passe en infobulle — l'heure suffit pour lire la journée,
 * la date entière sert au editing et à l'export VOD.
 */
function vecu(session: PlannedSession): { texte: string; encours: boolean; titre: string } | null {
  if (session.startedAt == null) return null
  const par =
    session.decidedBy == null
      ? ''
      : ` · décidé par ${session.decidedBy === 'auto' ? 'la règle horaire' : session.decidedBy}`
  return {
    texte: heure(session.startedAt),
    encours: session.endedAt == null,
    titre: session.startedAt + (session.endedAt == null ? '' : ` → ${session.endedAt}`) + par,
  }
}

const decisions = computed(
  () => (planning.value?.sessions ?? []).filter((s) => s.overriddenAs != null).length,
)

async function changerOverride(session: PlannedSession, menu: HTMLSelectElement): Promise<void> {
  // Le contrat n'accepte que ces deux mots, ou rien : le menu n'en propose pas
  // d'autres, mais c'est le type qui le garantit plutôt que la confiance.
  const action = menu.value === '' ? null : (menu.value as 'talk' | 'break')
  const avant = session.overriddenAs ?? ''
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
     * Remis à la main sur sa valeur d'avant.
     *
     * Recharger le store ne suffit pas : la donnée revient identique, donc Vue
     * ne voit aucun changement à propager et le `<select>` garde l'option que
     * l'opérateur a cliquée. Le menu resterait alors sur une décision que
     * personne n'a enregistrée — et qui ne descend ni aux salles ni aux QR.
     */
    menu.value = avant
  }
}

const controle = ref<FeedbackCheck | null>(null)
const controleErreur = ref('')
const controleEnCours = ref(false)

async function verifierLiens(): Promise<void> {
  controleEnCours.value = true
  controleErreur.value = ''
  controle.value = null
  try {
    controle.value = await store.checkFeedback()
  } catch (cause) {
    controleErreur.value = cause instanceof Error ? cause.message : 'Contrôle impossible.'
  } finally {
    controleEnCours.value = false
  }
}

const feedbackOuvert = ref(false)
const creneauFeedback = ref<PlannedSession | null>(null)

function ouvrirFeedback(session: PlannedSession): void {
  creneauFeedback.value = session
  feedbackOuvert.value = true
}

const vodOuverte = ref(false)
const creneauVod = ref<PlannedSession | null>(null)

function ouvrirVod(session: PlannedSession): void {
  creneauVod.value = session
  vodOuverte.value = true
}
</script>

<template>
  <div
    id="vue-conferences"
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
              <!-- Le titre, pas l'identifiant : personne ne reconnaît une conférence à son id. -->
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
                {{ etat.title ?? etat.sessionId }}
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle text-dim">
                {{ etat.scheduledStartsAt == null
                  ? '—'
                  : `${heure(etat.scheduledStartsAt)}–${heure(etat.scheduledEndsAt)}` }}
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
                <span :class="reste(etat).classe">{{ reste(etat).texte }}</span>
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
          d'avant-événement — on le passe une fois le programme importé, on
          corrige ce qu'il signale, et on n'y revient plus.
        -->
        <Button
          id="btn-controle-feedback"
          size="small"
          class="shrink-0"
          :disabled="controleEnCours"
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

      <div v-if="controleEnCours || controle != null || controleErreur !== ''" id="controle-feedback" class="mb-2.5">
        <Hint v-if="controleEnCours" class="mt-0">Interrogation d'OpenFeedback…</Hint>
        <Hint v-else-if="controleErreur !== ''" class="mt-0 text-alert">{{ controleErreur }}</Hint>
        <Hint v-else-if="controle != null" class="mt-0">
          <!-- Projet introuvable : la panne la plus bête et la plus totale — une
               faute de frappe dans un champ, et les vingt-sept adresses sont mortes. -->
          <template v-if="!controle.projetTrouve">
            <strong class="text-alert">
              Projet « {{ controle.projet }} » introuvable chez OpenFeedback.
            </strong>
            {{ controle.detail }}
          </template>
          <template v-else-if="controle.talksConnus == null">
            <strong>Projet trouvé.</strong> {{ controle.detail }}
          </template>
          <template v-else-if="controle.manquants.length === 0">
            <strong class="text-ok">
              {{ controle.talksConnus }} talks chez OpenFeedback, tous les créneaux ont le leur.
            </strong>
            {{ controle.detail }}
          </template>
          <template v-else>
            <strong class="text-warn">
              {{ controle.manquants.length }} créneau{{ controle.manquants.length > 1 ? 'x' : '' }}
              sans page OpenFeedback
            </strong>
            <span class="text-dim">sur {{ controle.talksConnus }} talks connus.</span>
            {{ controle.detail }}
            <ul class="mt-1.5 list-disc pl-4">
              <li v-for="manquant in controle.manquants" :key="manquant.feedbackId">
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
            <tr v-else-if="creneaux.length === 0">
              <td colspan="7"><Empty>Aucun créneau dans cette salle.</Empty></td>
            </tr>
            <tr
              v-for="session in creneaux"
              v-else
              :key="session.id"
              :data-creneau="session.id"
              :data-quand="situer(session)"
              :class="{
                'bg-surface2': situer(session) === 'en-cours',
                'opacity-55': situer(session) === 'passe',
              }"
            >
              <td
                class="border-t border-edge py-[9px] pr-2.5 align-middle whitespace-nowrap tabular-nums"
                :class="
                  situer(session) === 'en-cours' ? 'font-semibold text-text' : 'text-dim'
                "
              >
                <span
                  v-if="situer(session) === 'en-cours'"
                  class="mr-1.5 inline-block h-3.5 w-[3px] translate-y-0.5 rounded-full bg-brand"
                ></span>
                {{ creneauLisible(session) }}
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle whitespace-nowrap tabular-nums">
                <span v-if="vecu(session) == null" class="text-dim">—</span>
                <span v-else :title="vecu(session)!.titre">
                  {{ vecu(session)!.texte }}–<span
                    v-if="vecu(session)!.encours"
                    class="text-brand"
                    >en cours</span
                  ><template v-else>{{ heure(session.endedAt) }}</template>
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
                  seul se confondrait avec une ligne survolée, et l'heure
                  affichée peut être simulée — auquel cas « en ce moment » est la
                  seule chose qui explique pourquoi c'est cette ligne-là qui est
                  marquée.
                -->
                <div
                  v-if="situer(session) === 'en-cours'"
                  class="text-xs font-semibold text-brand"
                >
                  en ce moment
                </div>
              </td>
              <td class="border-t border-edge py-[9px] pr-2.5 align-middle whitespace-nowrap">
                <!-- Case vide plutôt que lien mort : sans projet OpenFeedback
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
                  @click="ouvrirFeedback(session)"
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
                  @click="ouvrirVod(session)"
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
                  @change="changerOverride(session, $event.target as HTMLSelectElement)"
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
        celui du « Terminer », clôture automatique comprise. Les deux sont lus dans le fuseau de
        l'événement, pas celui du poste d'où l'on regarde. Le lien « noter » ouvre la page
        OpenFeedback de la conférence, la même que celle du QR projeté en salle.
      </Hint>

      <Hint v-if="planning != null && planning.openFeedbackProjectId == null" id="planning-feedback-aide">
        <strong>Aucun projet OpenFeedback réglé</strong> : la colonne « Feedback » reste vide, et
        les salles ne projettent aucun QR « notez ce talk ». Il se règle dans
        <strong>Réglages → L'événement</strong>, une fois pour tout l'événement.
      </Hint>
    </Panel>

    <FeedbackIdDialog v-model:open="feedbackOuvert" :session="creneauFeedback" />
    <VodFolderDialog v-model:open="vodOuverte" :session="creneauVod" :timezone="fuseau" />
  </div>
</template>
