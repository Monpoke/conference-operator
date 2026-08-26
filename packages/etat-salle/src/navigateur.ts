/**
 * Ce que les pages autonomes reçoivent de l'automate.
 *
 * Les pages — régie, console du hub — n'ont pas d'étape de build : elles
 * s'ouvrent depuis une chaîne de caractères, sans réseau, sans CDN et sans
 * bundler. Elles ne peuvent donc pas `import`. Ce module est l'entrée que
 * `scripts/build-navigateur.mjs` fige dans `MACHINE_JS`, que les pages inlinent
 * dans un `<script>` — même patron que la feuille Tailwind de `@cloudnord/ui`.
 *
 * Il n'exporte que du calcul pur : rien de zod, rien de Node, aucun accès au
 * DOM. C'est ce qui permet à la même fonction de décider la couleur d'une
 * pastille dans la console et l'état affiché en régie, à la milliseconde près,
 * sans que l'une des deux ait à recopier un seuil.
 */
export {
  BREAK_PROCHE_MS,
  CLOTURE_PAR_DEFAUT,
  ETATS_SALLE,
  FIN_PROCHE_MS,
  RETARD_MS,
  aClore,
  conferenceAPiloter,
  doitEtreClose,
  etatDesCreneaux,
  etatDuProgramme,
  finEffectiveA,
  pauseDesCreneaux,
  prochaineConference,
} from './conference.js'
export type {
  Creneau,
  Pause,
  ReglageCloture,
  RoomConferenceState,
  SessionStatuses,
} from './conference.js'

export {
  APPARENCE,
  ETATS_DU_HUB,
  VUE_PERIMEE_MS,
  apparenceDe,
  contourDe,
  etatFaisantFoi,
} from './apparence.js'
export type { Apparence } from './apparence.js'

export {
  ACTIONS,
  STATUTS,
  decisionApplicable,
  refusDeTransition,
  statutApres,
  transitionAutorisee,
} from './cycle-de-vie.js'
export type { ActionConference, StatutConference } from './cycle-de-vie.js'

export { timelinePosition } from '@cloudnord/program/selectors'
