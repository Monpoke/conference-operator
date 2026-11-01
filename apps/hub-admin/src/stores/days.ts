/** The days of an event, as filters offer them: always in the event's time zone. */

const keyFormatter = (zone: string) =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: zone })

/** `2026-10-30`, the day an instant falls on in that zone. */
export const dayKeyOf = (iso: string, zone: string): string => keyFormatter(zone).format(new Date(iso))

/** One option per day met, in order: `ven. 30 oct.`. */
export function dayOptions(instants: readonly (string | null | undefined)[], zone: string): { value: string; label: string }[] {
  const labels = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: zone })
  const days = new Map<string, string>()
  for (const iso of instants) {
    if (iso == null) continue
    const key = dayKeyOf(iso, zone)
    if (!days.has(key)) days.set(key, labels.format(new Date(iso)))
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([value, label]) => ({ value, label }))
}

/** A date typed in the browser, as the instants that bound it on this machine's clock. */
export function dayBounds(day: string): { depuis: string; avant: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (match == null) return null
  const [year, month, date] = match.slice(1).map(Number) as [number, number, number]
  return { depuis: new Date(year, month - 1, date).toISOString(), avant: new Date(year, month - 1, date + 1).toISOString() }
}
