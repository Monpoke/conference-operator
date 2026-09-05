/**
 * The offset from the hub's clock, in a unit one can picture.
 *
 * "décalée de +5 693 432,6 s" is exact and unreadable. Past the minute only the
 * order of magnitude counts: a machine two hours from the hub does not have the
 * same problem as one two seconds away, and that is what needs reading.
 *
 * Here rather than in `@conference-operator/format`: the control app is the only surface
 * that displays it, because it is the only one that has to explain a countdown
 * that does not match the operator's watch.
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
