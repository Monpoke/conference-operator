/**
 * The days of a program, always in the event's time zone.
 *
 * Read on a machine set to another zone, a 23:30 slot would otherwise land on
 * the wrong day — and the day shown by default is the one the room is living.
 */
const keyFormat = (zone: string) =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: zone })

export function dayKeyOf(at: string | number, zone: string): string {
  return keyFormat(zone).format(new Date(at))
}

export function programDays(instants: readonly string[], zone: string): { value: string; label: string }[] {
  const label = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: zone })
  const days = new Map<string, string>()
  for (const at of instants) {
    const key = dayKeyOf(at, zone)
    if (!days.has(key)) days.set(key, label.format(new Date(at)))
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([value, text]) => ({ value, label: text }))
}

/**
 * The day to open on: the one asked for, else today, else the nearest edge.
 *
 * Before the event its first day, after it its last: that is the day one comes
 * looking for, never an empty list.
 */
export function openDay(days: readonly string[], today: string, asked: string | null): string | null {
  if (asked != null && days.includes(asked)) return asked
  if (days.includes(today)) return today
  if (days.length === 0) return null
  return today > days[days.length - 1]! ? days[days.length - 1]! : days[0]!
}
