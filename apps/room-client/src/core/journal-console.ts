/**
 * Mise en forme d'une ligne de journal pour un terminal.
 *
 * L'heure manquait, et c'est la première chose qu'on cherche : devant une pile
 * de reconnexions, savoir si elles datent de dix secondes ou d'une heure change
 * complètement la conduite à tenir.
 *
 * Deux points de sortie l'utilisent — la fenêtre Electron et le lancement sans
 * interface — et ils divergeaient déjà de format. Une seule fonction, donc.
 */
export type NiveauJournal = 'info' | 'warn' | 'error'

/** Marqueurs courts et alignés : l'œil balaie la colonne, pas le texte. */
const MARQUEURS: Record<NiveauJournal, string> = {
  info: '·',
  warn: '!',
  error: '✕',
}

/**
 * Horloge **réelle**, même quand le hub simule l'heure.
 *
 * Un journal répond à « quand est-ce arrivé sur cette machine », pas à « à quel
 * moment de la journée simulée ». Mélanger les deux rendrait illisible la seule
 * chose qu'on lui demande pendant un incident.
 */
export function formaterLigneJournal(
  niveau: NiveauJournal,
  message: string,
  contexte?: unknown,
  maintenant: Date = new Date(),
): string {
  const heure = [maintenant.getHours(), maintenant.getMinutes(), maintenant.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')

  const details = contexte == null ? '' : ` ${detailler(contexte)}`
  return `${heure} ${MARQUEURS[niveau]} ${message}${details}`
}

/**
 * Rend le contexte lisible.
 *
 * Le cas courant est `{ message: "..." }` : afficher `{"message":"WebSocket
 * closed (code 1006: )"}` ajoute des accolades autour de la seule information
 * utile. Un objet à une clé est donc aplati.
 */
function detailler(contexte: unknown): string {
  if (typeof contexte === 'string') return contexte
  if (contexte != null && typeof contexte === 'object') {
    const entries = Object.entries(contexte as Record<string, unknown>)
    if (entries.length === 1 && typeof entries[0]![1] === 'string') return `— ${entries[0]![1]}`
    return entries.map(([cle, valeur]) => `${cle}=${JSON.stringify(valeur)}`).join(' ')
  }
  return String(contexte)
}
