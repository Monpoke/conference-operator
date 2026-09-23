import type { DisplayMode, RoomScreen } from '@conference-operator/contract'
import type { Scene } from './scene.js'
import { accueil } from './scenes/accueil.js'
import { agenda } from './scenes/agenda.js'
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
  { id: 'agenda', nom: 'Agenda', fabrique: agenda },
  ...range(ANNONCES).map((i) => ({ id: `annonce-${i + 1}`, nom: `Annonce ${i + 1}`, fabrique: (el: HTMLElement) => annonce(el, i) })),
  { id: 'merci', nom: 'Merci à nos sponsors', fabrique: merci, signature: true },
  ...range(PAGES_SPONSORS).map((i) => ({
    id: `sponsors-${i + 1}`, nom: `Sponsors, page ${i + 1}`, fabrique: (el: HTMLElement) => sponsors(el, i), signature: true,
  })),
  { id: 'posts', nom: 'Mur social', fabrique: mur },
  { id: 'message-bienvenue', nom: 'Message : bienvenue', fabrique: (el) => message(el, 'bienvenue'), signature: true },
  { id: 'salles', nom: 'Pendant ce temps', fabrique: salles },
  { id: 'agenda-rappel', nom: 'Agenda (rappel)', fabrique: agenda },
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
  /** Seconds on screen. */
  duree: number
  /** How it comes in: slide, stinger, cut, fade, wipe, zoom, dip. */
  transition: string
  /** ms. */
  dureeTransition: number
  /** The hub setting that withdraws it; `null` = never withdrawn. */
  ecran: RoomScreen | null
}

const etape = (scene: string, duree: number, ecran: RoomScreen | null, transition = 'slide', dureeTransition = 900): Etape =>
  ({ scene, duree, transition, dureeTransition, ecran })

/**
 * The welcome loop, in the reference's order and with its durations, plus the
 * two pages this screen had before it ("Pendant ce temps", "Nos réseaux").
 * A scene with nothing to show, or withdrawn on the hub, is skipped.
 */
export const BOUCLE: Etape[] = [
  etape('accueil', 10, 'welcome', 'stinger', 1100),
  etape('agenda', 20, 'agenda'),
  ...range(ANNONCES).map((i) => etape(`annonce-${i + 1}`, 8, 'announcements')),
  etape('merci', 6, 'sponsors-thanks'),
  ...range(PAGES_SPONSORS).map((i) => etape(`sponsors-${i + 1}`, 8, 'sponsors')),
  etape('posts', 15, 'posts', 'slide', 1000),
  etape('message-bienvenue', 7, 'slogans'),
  etape('salles', 12, 'rooms'),
  etape('agenda-rappel', 20, 'agenda'),
  etape('message-partage', 7, 'slogans'),
  etape('reseaux', 10, 'socials'),
  etape('wallsio', 25, 'wallsio'),
  etape('message-silence', 7, 'slogans'),
  etape('conduite', 14, 'code-of-conduct'),
  etape('feedbacks', 10, 'event-feedback'),
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
  const seul = (scene: string): Programmation => ({ etapes: [etape(scene, 0, null)], tourne: false })
  switch (mode) {
    case 'loop':
      return { etapes: BOUCLE, tourne: true }
    case 'sponsors':
      return {
        etapes: [etape('merci', 6, null), ...range(PAGES_SPONSORS).map((i) => etape(`sponsors-${i + 1}`, 8, null))],
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
    case 'live': return { etapes: [etape('direct', 0, null, 'fade', 450)], tourne: false }
    default: return { etapes: BOUCLE, tourne: true }
  }
}
