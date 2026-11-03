/**
 * The operator's words for the machine's identifiers.
 *
 * The room machine answers with its own vocabulary — `Écran : loop`,
 * `Scène : HOLD` — and the hub reports scene roles as constants. Shown as they
 * are, they read as a second language next to buttons labelled « Boucle
 * entière » and « Habillage ». One table, read by the toasts, the rooms tab and
 * the panels, so the same thing is called the same everywhere.
 */
export const SCREEN_LABELS: Record<string, string> = {
  loop: 'Boucle entière',
  sponsors: 'Sponsors',
  wallsio: 'Mur social',
  agenda: 'Agenda',
  countdown: 'Compte à rebours',
  message: 'Message',
  feedback: 'Notez le talk',
  wall: 'Mur & questions',
  question: 'Question choisie',
  programme: 'Programme',
}

export const SCENE_LABELS: Record<string, string> = {
  LIVE: 'Direct',
  HOLD: 'Habillage',
  RELAY: 'Relais',
  TALK: 'Talk complet',
  CAM_ONLY: 'Caméra seule',
  SLIDES_ONLY: 'Slides seules',
}

export function screenLabel(mode: string | null | undefined): string {
  if (mode == null) return 'inconnu'
  return SCREEN_LABELS[mode] ?? mode
}

export function sceneLabel(role: string | null | undefined): string {
  if (role == null) return 'scène non remontée'
  return SCENE_LABELS[role] ?? role
}
