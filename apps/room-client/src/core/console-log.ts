/**
 * Formatting a log line for a terminal.
 *
 * The time was missing, and it is the first thing one looks for: faced with a
 * stack of reconnections, knowing whether they are ten seconds or an hour old
 * completely changes what to do.
 *
 * Two entry points use it — the Electron window and the headless launch — and
 * they were already diverging in format. One function, then.
 */
export type LogLevel = 'info' | 'warn' | 'error'

/** Short, aligned markers: the eye scans the column, not the text. */
const MARKERS: Record<LogLevel, string> = {
  info: '·',
  warn: '!',
  error: '✕',
}

/**
 * The **real** clock, even when the hub simulates the time.
 *
 * A log answers "when did this happen on this machine", not "at what point of the
 * simulated day". Mixing the two would make illegible the only thing one asks of
 * it during an incident.
 */
export function formatLogLine(
  level: LogLevel,
  message: string,
  context?: unknown,
  now: Date = new Date(),
): string {
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')

  const details = context == null ? '' : ` ${detail(context)}`
  return `${time} ${MARKERS[level]} ${message}${details}`
}

/**
 * Makes the context readable.
 *
 * The common case is `{ message: "..." }`: showing `{"message":"WebSocket closed
 * (code 1006: )"}` adds braces around the only useful information. An object with
 * one key is therefore flattened.
 */
function detail(context: unknown): string {
  if (typeof context === 'string') return context
  if (context != null && typeof context === 'object') {
    const entries = Object.entries(context as Record<string, unknown>)
    if (entries.length === 1 && typeof entries[0]![1] === 'string') return `— ${entries[0]![1]}`
    return entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')
  }
  return String(context)
}
