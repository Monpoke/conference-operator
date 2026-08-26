import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * Les conférences, sous deux angles qui ne se remplacent pas.
 *
 * Le premier tableau ne montre que ce qui a été **démarré** : il répond à « où
 * en est-on ». Le planning répond à « et après, il y a quoi » — la question
 * qu'on pose à l'organisateur toute la journée, et pour laquelle il fallait
 * jusqu'ici rouvrir le site de l'événement.
 */
export interface SessionState {
  sessionId: string
  roomId?: string | null
  roomName?: string | null
  title?: string | null
  status: string
  scheduledStartsAt?: string | null
  scheduledEndsAt?: string | null
  remainingMs?: number | null
  decidedBy?: string | null
}

export interface PlannedSession {
  id: string
  roomId?: string | null
  roomName?: string | null
  title: string
  kind: string
  speakers: string[]
  startsAt: string
  endsAt?: string | null
  startedAt?: string | null
  endedAt?: string | null
  decidedBy?: string | null
  feedbackUrl?: string | null
  feedbackIdOverride?: string | null
  overriddenAs?: string | null
  /** Pause héritée d'une autre salle : elle n'a pas d'existence propre. */
  sharedFrom?: string | null
}

export interface Planning {
  sessions: PlannedSession[]
  rooms: { id: string; name: string }[]
  timezone: string
  /** Heure du hub — elle peut être simulée, et c'est elle qui fait foi. */
  serverTime: string
  openFeedbackProjectId?: string | null
}

export interface FeedbackCheck {
  projet: string
  projetTrouve: boolean
  detail: string
  talksConnus?: number | null
  manquants: { title: string; feedbackId: string }[]
}

export const useConferencesStore = defineStore('conferences', () => {
  const states = ref<SessionState[]>([])
  const planning = ref<Planning | null>(null)
  const hasActiveProgram = ref(true)
  const room = ref('')

  /** Repliée par défaut — voir `ConferencesView`. */
  const actionsShown = ref(false)

  const session = useSessionStore()

  async function load(): Promise<void> {
    const [etats, snapshots, plan] = await Promise.all([
      session.client.rpc.sessions.states({ roomId: null }),
      session.client.rpc.program.snapshots(),
      session.client.rpc.program.planning(),
    ])
    states.value = etats as SessionState[]
    hasActiveProgram.value = (snapshots as { active?: boolean }[]).some((s) => s.active === true)
    planning.value = plan as Planning
  }

  /** Démarrer, terminer, remettre à venir — la table du cycle de vie décide. */
  async function decide(sessionId: string, action: 'start' | 'end' | 'reset'): Promise<void> {
    await session.client.rpc.sessions[action]({ sessionId })
    await load()
  }

  /**
   * Considérer un créneau autrement que l'export ne le dit.
   *
   * Relu depuis le hub après coup : c'est lui qui sert le programme corrigé, et
   * le reconstruire ici le ferait diverger de ce que voient les salles.
   */
  async function override(sessionId: string, action: 'talk' | 'break' | null): Promise<void> {
    await session.client.rpc.sessions.override({ sessionId, action })
    await load()
  }

  async function setFeedbackId(sessionId: string, feedbackId: string | null): Promise<void> {
    await session.client.rpc.sessions.feedbackId({ sessionId, feedbackId })
    await load()
  }

  /**
   * Contrôle des liens OpenFeedback.
   *
   * Sur demande et non en continu : il sort du hub pour interroger un service
   * tiers, et c'est un geste d'avant-événement — on le passe une fois le
   * programme importé, on corrige ce qu'il signale, et on n'y revient plus.
   */
  async function checkFeedback(): Promise<FeedbackCheck> {
    return (await session.client.rpc.program.controleOpenFeedback()) as FeedbackCheck
  }

  async function vodFolder(sessionId: string): Promise<unknown> {
    return await session.client.rpc.vod.conference({ sessionId })
  }

  async function requestVod(roomId: string, file: string | null): Promise<void> {
    await session.client.rpc.vod.request({ roomId, file })
  }

  return {
    states,
    planning,
    hasActiveProgram,
    room,
    actionsShown,
    load,
    decide,
    override,
    setFeedbackId,
    checkFeedback,
    vodFolder,
    requestVod,
  }
})

/** Où en est la journée pour ce créneau, d'après l'heure du hub. */
export function placeInDay(session: PlannedSession, nowMs: number): 'a-venir' | 'en-cours' | 'passe' {
  const start = Date.parse(session.startsAt)
  const end = session.endsAt == null ? null : Date.parse(session.endsAt)
  if (start > nowMs) return 'a-venir'
  // Fin inconnue : le créneau court jusqu'à preuve du contraire, plutôt que
  // d'être déclaré passé à la seconde où il commence.
  if (end == null || nowMs < end) return 'en-cours'
  return 'passe'
}

/**
 * L'action que le menu propose.
 *
 * Celle qui **contredit** l'export : l'autre ne ferait rien. Un créneau déjà
 * décidé propose donc de revenir dessus, et le choix vide rend au programme.
 */
export function overrideChoice(session: PlannedSession): {
  scheduled: 'talk' | 'break'
  action: 'talk' | 'break'
} {
  const decided = session.overriddenAs ?? null
  const scheduled =
    decided == null ? (session.kind as 'talk' | 'break') : decided === 'break' ? 'talk' : 'break'
  return { scheduled, action: scheduled === 'break' ? 'talk' : 'break' }
}
