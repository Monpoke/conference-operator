/**
 * Reads a duration out loud, the way an operator needs it.
 *
 * Four functions rather than one with options, because the four answer four
 * different questions, and each rounds differently on purpose. Getting them
 * mixed up is what made the two copies drift apart in the first place.
 */

/**
 * A duration in minutes, spelled out.
 *
 * Past the hour, a count in minutes stops being usable: across two days, the
 * drift against the programme was showing up as five digits.
 *
 * This is the room-control version. The console carried its own, identical
 * below 24 hours and without the day branch — so adopting this one leaves every
 * value the console actually produces untouched, and fixes the rest.
 */
export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, '0')}`
  return `${Math.floor(hours / 24)} j ${hours % 24} h`
}

/**
 * Countdown on the slot, to the second.
 *
 * Minutes are enough to decide, seconds to hold the end of a talk: it is in the
 * last two minutes that this display gets watched continuously. Past the hour,
 * the hour comes first.
 *
 * The minus sign is U+2212, not a hyphen: it lines up with the digits in a
 * tabular font, where a hyphen sits too high and too short.
 */
export function stopwatch(ms: number): string {
  const total = Math.floor(Math.abs(ms) / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const head = hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}` : String(minutes)
  return `${ms < 0 ? '−' : ''}${head}:${String(seconds).padStart(2, '0')}`
}

/**
 * Same reading, fixed width, for a list.
 *
 * Always two digits for minutes, so that rows line up under one another — which
 * `stopwatch` deliberately does not do, since a lone leading zero reads as
 * noise when the number stands on its own.
 */
export function shortDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const rest = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
  return hours > 0 ? `${hours}:${rest}` : rest
}

/**
 * What is left of the slot, in words.
 *
 * Minutes alone are not enough here: rounded, eight seconds become "0 min", and
 * the question would lose the one figure that lets you answer it without
 * thinking.
 */
export function remaining(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  return duration(Math.round(seconds / 60))
}
