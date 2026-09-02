import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useConferencesStore } from './conferences.js'
import { useSessionStore } from './session.js'

/**
 * Les commodités qui déplacent tout le système.
 *
 * L'heure du hub y est seule, et c'est déjà beaucoup : la changer réaligne les
 * trois salles, fausse les timecodes VOD et déclenche des clôtures automatiques
 * à contretemps. Elle n'a rien à faire à côté des réglages qu'on touche le jour
 * J — d'où une vue à part, rendue seulement en mode dev, et un module que le
 * routeur charge à la demande pour qu'il n'entre pas dans le bundle servi en
 * production.
 */
export interface Clock {
  serverTime: string
  simulated: boolean
  controllable: boolean
}

export interface ResetReport {
  objets: number
  multiparts: number
  salles: number
}

export const useDevStore = defineStore('dev', () => {
  const clock = ref<Clock | null>(null)
  const report = ref<ResetReport | null>(null)

  const session = useSessionStore()

  async function load(): Promise<void> {
    clock.value = (await session.client.rpc.clock.get()) as Clock
  }

  async function setClock(at: string | null): Promise<void> {
    const result = (await session.client.rpc.clock.set({ at })) as Omit<Clock, 'controllable'>
    clock.value = { ...result, controllable: true }
  }

  /** Ce que la remise à zéro va viser, dit avant de la proposer. */
  async function resetTarget(): Promise<{ cible: string; salles: number }> {
    let cible = 'le préfixe du bucket'
    try {
      const statut = (await session.client.rpc.vod.status()) as {
        bucket?: string | null
        prefix?: string | null
      }
      cible =
        statut.prefix == null || statut.prefix === ''
          ? 'AUCUN PRÉFIXE RÉGLÉ'
          : `${statut.bucket ?? '?'} / ${statut.prefix}`
    } catch {
      // Le hub ne répond pas : on ouvre quand même, il refusera lui-même.
    }
    const salles = (await session.client.rpc.rooms.list().catch(() => [])) as unknown[]
    return { cible, salles: salles.length }
  }

  async function reset(): Promise<ResetReport> {
    report.value = (await session.client.rpc.vod.reset({ confirmation: 'RAZ' })) as ResetReport
    return report.value
  }

  return { clock, report, load, setClock, resetTarget, reset }
})

/**
 * Les moments du programme vers lesquels se déplacer.
 *
 * Déduits du programme importé, jamais écrits en dur : une date d'édition dans
 * le code ne vaut que pour cette édition-là, et les boutons devenaient
 * silencieusement inutiles au changement d'événement — un déplacement à une
 * date sans le moindre créneau ne montre rien et ne dit pas pourquoi.
 */
export function programMoments(
  sessions: { startsAt: string; endsAt?: string | null; kind: string }[],
): [string, string][] {
  const creneaux = sessions.filter((session) => session.startsAt)
  if (creneaux.length === 0) return []
  const tries = [...creneaux].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
  const premier = tries[0]!
  const dernier = tries[tries.length - 1]!
  const talks = tries.filter((session) => session.kind !== 'break')
  /**
   * La première **conférence**, pas le premier créneau de la journée.
   *
   * Une journée s'ouvre sur un accueil ou un petit déjeuner, qui sont des
   * pauses : le bouton menait donc à 08:35 sur un export dont la première
   * conférence est à 09:00, et l'on croyait l'horloge fausse alors que c'était
   * l'étiquette. C'est la même règle que le milieu de journée juste en dessous,
   * et que `conferenceAPiloter` en régie — un créneau qu'on ne peut pas lancer
   * n'est pas un moment vers lequel se déplacer.
   *
   * Le repli sur le premier créneau couvre le programme qui n'aurait que des
   * pauses : quatre boutons valent mieux que trois, même si celui-ci vise alors
   * un déjeuner.
   */
  const premiereConference = talks[0] ?? premier
  const milieu = talks[Math.floor(talks.length / 2)] ?? tries[Math.floor(tries.length / 2)]!

  const decale = (iso: string, minutes: number): string =>
    new Date(Date.parse(iso) + minutes * 60_000).toISOString()

  const moments: [string, string][] = [
    // Celui-ci vise bien le **premier créneau**, pause comprise : « avant
    // ouverture », c'est avant que la salle n'ouvre ses portes.
    ['Avant ouverture', decale(premier.startsAt, -30)],
    ['Première conférence', decale(premiereConference.startsAt, 5)],
    ['Milieu de journée', decale(milieu.startsAt, 5)],
    // Cinq minutes après la fin du dernier créneau : c'est là que la clôture
    // automatique se déclenche, et c'est ce qu'on vient vérifier.
    ['Fin de journée', decale(dernier.endsAt ?? dernier.startsAt, 5)],
  ]
  // Dédoublonné : sur un programme d'un seul créneau, quatre boutons qui mènent
  // au même instant se lisent comme quatre choix.
  const vus = new Set<string>()
  return moments.filter(([, iso]) => (vus.has(iso) ? false : (vus.add(iso), true)))
}

/** Un instant ISO, dans la forme qu'un `datetime-local` accepte. */
export function forInput(iso: string): string {
  const date = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Le programme actif, pour les raccourcis d'horloge. */
export function activeSessions(): { startsAt: string; endsAt?: string | null; kind: string }[] {
  return useConferencesStore().planning?.sessions ?? []
}
