/**
 * Instants, read in the event's timezone.
 *
 * Every surface displays times in the timezone of the event, never the one of
 * the machine looking at them: a room PC set to the wrong zone must not make an
 * operator miss a slot.
 */

/**
 * Formatters, built once per timezone.
 *
 * `Intl.DateTimeFormat` is expensive to construct and cheap to reuse. The
 * console was building one **per table row**, inside a list redrawn every ten
 * seconds; that construction was the dominant cost of rendering the schedule.
 */
const hourMinute = new Map<string, Intl.DateTimeFormat>()

export function timeFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? ''
  const known = hourMinute.get(key)
  if (known != null) return known
  const built = new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone == null ? {} : { timeZone }),
  })
  hourMinute.set(key, built)
  return built
}

/** An ISO instant as `14:05`, in the event's timezone. */
export function time(iso: string, timeZone: string | undefined): string {
  return timeFormatter(timeZone).format(new Date(iso))
}

/**
 * How long ago, for a "last seen" line.
 *
 * A date in the future is not a negative gap to display: the hub's clock and
 * the browser's are not the same one, and "seen −6010436 s ago" means nothing
 * to anybody.
 *
 * `nowMs` is a parameter rather than a call to `Date.now()` so the function
 * stays pure — and so a surface that knows the hub's clock offset can pass a
 * corrected instant instead of the machine's.
 */
export function timeAgo(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (iso == null || iso === '') return 'jamais'
  const seconds = Math.round((nowMs - Date.parse(iso)) / 1000)
  if (seconds < 1) return "à l'instant"
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds / 3600)} h`
}
