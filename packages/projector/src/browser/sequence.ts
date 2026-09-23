import type { DisplayMode, DureeScene, RoomScreen } from '@conference-operator/contract'
import type { Scene } from './scene.js'
import { accueil } from './scenes/accueil.js'
import { agenda, journeeAutre } from './scenes/agenda.js'
import { annonce, merci, sponsors } from './scenes/sponsors.js'
import { mur } from './scenes/mur.js'
import { message } from './scenes/message.js'
import { reseaux, salles } from './scenes/salles.js'
import { wallsio } from './scenes/wallsio.js'
import { conduite, feedbacks } from './scenes/affiches.js'
import { avis, banniere, decompte, direct, murHub, programme, question } from './scenes/operateur.js'

/** The number of slots mounted for the scenes whose count the hub decides. */
export const ANNONCES = 4
export const PAGES_SPONSORS = 8
/** The other rooms' schedules mounted at most — the contract's `MAX_PLANNINGS`. */
export const PLANNINGS = 6

export interface DefinitionScene {
  id: string
  /** Shown in the control panel (H). */
  nom: string
  fabrique: (el: HTMLElement) => Scene
  /** Shows the signature bottom right, as in the reference. */
  signature?: boolean
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

/** Every scene of the stage, in document order. */
export const SCENES: DefinitionScene[] = [
  { id: 'accueil', nom: 'Accueil', fabrique: accueil },
  { id: 'agenda', nom: 'Agenda', fabrique: (el) => agenda(el) },
  ...range(PLANNINGS).map((i) => ({
    id: `planning-${i + 1}`, nom: `Planning d'une autre salle ${i + 1}`, fabrique: (el: HTMLElement) => agenda(el, journeeAutre(i)),
  })),
  ...range(ANNONCES).map((i) => ({ id: `annonce-${i + 1}`, nom: `Annonce ${i + 1}`, fabrique: (el: HTMLElement) => annonce(el, i) })),
  { id: 'merci', nom: 'Merci à nos sponsors', fabrique: merci, signature: true },
  ...range(PAGES_SPONSORS).map((i) => ({
    id: `sponsors-${i + 1}`, nom: `Sponsors, page ${i + 1}`, fabrique: (el: HTMLElement) => sponsors(el, i), signature: true,
  })),
  { id: 'posts', nom: 'Mur social', fabrique: mur },
  { id: 'message-bienvenue', nom: 'Message : bienvenue', fabrique: (el) => message(el, 'bienvenue'), signature: true },
  { id: 'salles', nom: 'Pendant ce temps', fabrique: salles },
  { id: 'agenda-rappel', nom: 'Agenda (rappel)', fabrique: (el) => agenda(el) },
  { id: 'message-partage', nom: 'Message : partage', fabrique: (el) => message(el, 'partage'), signature: true },
  { id: 'reseaux', nom: 'Nos réseaux', fabrique: reseaux },
  { id: 'wallsio', nom: 'Walls.io', fabrique: wallsio },
  { id: 'message-silence', nom: 'Message : téléphones', fabrique: (el) => message(el, 'silence'), signature: true },
  { id: 'conduite', nom: 'Code de conduite', fabrique: conduite, signature: true },
  { id: 'feedbacks', nom: 'Feedbacks', fabrique: feedbacks, signature: true },
  // The operator's screens.
  { id: 'programme', nom: 'Programme', fabrique: programme },
  { id: 'decompte', nom: 'Compte à rebours', fabrique: decompte },
  { id: 'banniere', nom: 'Message', fabrique: banniere },
  { id: 'avis', nom: 'Avis sur la conférence', fabrique: avis },
  { id: 'question', nom: 'Question du public', fabrique: question },
  { id: 'mur-hub', nom: 'Vos messages', fabrique: murHub },
  { id: 'direct', nom: 'À l’antenne', fabrique: direct },
]

export const SCENE_IDS = SCENES.map((scene) => scene.id)

export interface Etape {
  scene: string
  /** Seconds on screen, the reference's — `groupe` lets the hub set another. */
  duree: number
  /** The kind of scene whose duration the hub setting overrides; `null` = held. */
  groupe: DureeScene | null
  /** How it comes in: slide, stinger, cut, fade, wipe, zoom, dip. */
  transition: string
  /** ms. */
  dureeTransition: number
  /** The hub setting that withdraws it; `null` = never withdrawn. */
  ecran: RoomScreen | null
  /**
   * The slot of a scene whose duration comes with its content — a sponsor page,
   * another room's schedule — rather than from its kind alone.
   */
  page?: { de: 'sponsors' | 'plannings'; index: number }
}

/**
 * The reference's durations, in seconds, when the hub sends none.
 *
 * A copy of the contract's `DUREES_PAR_DEFAUT` and not an import: importing a
 * value from the contract would bring zod into the projected page, ten times
 * its weight. A test holds the two equal.
 */
export const DUREES: Record<DureeScene, number> = {
  accueil: 10,
  agenda: 20,
  annonces: 8,
  merci: 6,
  sponsors: 8,
  posts: 15,
  'message-bienvenue': 7,
  salles: 12,
  'agenda-rappel': 20,
  'message-partage': 7,
  reseaux: 10,
  wallsio: 25,
  'message-silence': 7,
  conduite: 14,
  feedbacks: 10,
}

const etape = (
  scene: string,
  groupe: DureeScene | null,
  ecran: RoomScreen | null,
  transition = 'slide',
  dureeTransition = 900,
): Etape => ({ scene, duree: groupe == null ? 0 : DUREES[groupe], groupe, transition, dureeTransition, ecran })

/**
 * The welcome loop, in the reference's order and with its durations, plus the
 * two pages this screen had before it ("Pendant ce temps", "Nos réseaux").
 * A scene with nothing to show, or withdrawn on the hub, is skipped.
 */
export const BOUCLE: Etape[] = [
  etape('accueil', 'accueil', 'welcome', 'stinger', 1100),
  etape('agenda', 'agenda', 'agenda'),
  // The other rooms' days, right after this one's: 15 s each unless the hub says otherwise.
  ...range(PLANNINGS).map((i) => ({ ...etape(`planning-${i + 1}`, null, 'other-agendas'), page: { de: 'plannings' as const, index: i } })),
  ...range(ANNONCES).map((i) => etape(`annonce-${i + 1}`, 'annonces', 'announcements')),
  etape('merci', 'merci', 'sponsors-thanks'),
  ...range(PAGES_SPONSORS).map((i) => ({ ...etape(`sponsors-${i + 1}`, 'sponsors', 'sponsors'), page: { de: 'sponsors' as const, index: i } })),
  etape('posts', 'posts', 'posts', 'slide', 1000),
  etape('message-bienvenue', 'message-bienvenue', 'slogans'),
  etape('salles', 'salles', 'rooms'),
  etape('agenda-rappel', 'agenda-rappel', 'agenda'),
  etape('message-partage', 'message-partage', 'slogans'),
  etape('reseaux', 'reseaux', 'socials'),
  etape('wallsio', 'wallsio', 'wallsio'),
  etape('message-silence', 'message-silence', 'slogans'),
  etape('conduite', 'conduite', 'code-of-conduct'),
  etape('feedbacks', 'feedbacks', 'event-feedback'),
]

export interface Programmation {
  etapes: Etape[]
  /** `true`: it turns on its own; `false`: one screen, held until the operator changes it. */
  tourne: boolean
}

/**
 * What each display mode plays.
 *
 * The loop's own screens are the loop's scenes — the agenda, the walls.io wall
 * — so that putting one up from the control room shows exactly what the loop
 * shows, and the wall's iframe is the same one, already loaded. What the
 * operator puts up is shown even if the hub withdrew it: the hub decides what is
 * offered, never what a room is doing.
 */
export function programmation(mode: DisplayMode): Programmation {
  const seul = (scene: string): Programmation => ({ etapes: [etape(scene, null, null)], tourne: false })
  switch (mode) {
    case 'loop':
      return { etapes: BOUCLE, tourne: true }
    case 'sponsors':
      return {
        etapes: [
          etape('merci', 'merci', null),
          ...range(PAGES_SPONSORS).map((i) => ({ ...etape(`sponsors-${i + 1}`, 'sponsors', null), page: { de: 'sponsors' as const, index: i } })),
        ],
        tourne: true,
      }
    case 'agenda': return seul('agenda')
    case 'wallsio': return seul('wallsio')
    case 'programme': return seul('programme')
    case 'countdown': return seul('decompte')
    case 'message': return seul('banniere')
    case 'feedback': return seul('avis')
    case 'question': return seul('question')
    case 'wall': return seul('mur-hub')
    case 'live': return { etapes: [etape('direct', null, null, 'fade', 450)], tourne: false }
    default: return { etapes: BOUCLE, tourne: true }
  }
}
