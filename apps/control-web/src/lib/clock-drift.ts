/**
 * L'écart avec l'horloge du hub, dans une unité qu'on puisse se représenter.
 *
 * « décalée de +5 693 432,6 s » est exact et illisible. Au-delà de la minute
 * seul l'ordre de grandeur compte : un poste à deux heures du hub n'a pas le
 * même problème qu'un poste à deux secondes, et c'est ce qu'il faut lire.
 *
 * Ici plutôt que dans `@cloudnord/format` : la régie est la seule surface qui
 * l'affiche, parce qu'elle est la seule à devoir expliquer un compte à rebours
 * qui ne colle pas à la montre de l'opérateur.
 */
export function clockDrift(ms: number): string {
  const seconds = Math.abs(ms) / 1000
  if (seconds < 1) return 'horloge alignée'

  const sign = ms > 0 ? '+' : '−'
  const said = (value: number | string, unit: string): string =>
    `horloge décalée de ${sign}${value} ${unit}`

  if (seconds < 90) return said(seconds.toFixed(1).replace('.', ','), 's')
  const minutes = seconds / 60
  if (minutes < 90) return said(Math.round(minutes), 'min')
  const hours = minutes / 60
  if (hours < 48) return said(Math.round(hours), 'h')
  return said(Math.round(hours / 24), 'jours')
}
