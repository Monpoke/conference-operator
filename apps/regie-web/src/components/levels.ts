/**
 * Les niveaux, du plus calme au plus grave.
 *
 * « inconnu » n'y figure pas : ce n'est pas une gravité, c'est une absence de
 * mesure. Le confondre avec « ok » ferait passer un poste qu'on n'a pas su lire
 * pour un poste au repos.
 */
export const SEVERITY = ['ok', 'attention', 'alerte'] as const

export type Level = 'ok' | 'attention' | 'alerte' | 'inconnu'

/**
 * Le pire de deux niveaux — ce que la pastille du bandeau doit montrer.
 *
 * « inconnu » ne l'emporte sur rien : une mesure absente ne doit pas éteindre
 * l'alerte que l'autre est en train de donner.
 */
export function worst(a: Level, b: Level): Level {
  const rank = (level: Level): number => SEVERITY.indexOf(level as (typeof SEVERITY)[number])
  if (rank(a) < 0) return b
  if (rank(b) < 0) return a
  return rank(a) >= rank(b) ? a : b
}
