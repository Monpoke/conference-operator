/**
 * A read from the hub, tried again: a hub restarting answers 503 for half a minute.
 *
 * Six tries over about thirty seconds, then the error goes up. A video dressed with
 * the wrong theme looks finished and goes unnoticed; a failed montage is seen, and relaunched.
 */
export const RETRY_ATTEMPTS = 6
export const RETRY_DELAY_MS = 6_000

export type Wait = (ms: number) => Promise<void>
const pause: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function withRetries<T>(
  read: () => Promise<T>,
  options: { onRetry?: (error: unknown, attempt: number) => void; giveUpOn?: (error: unknown) => boolean; wait?: Wait } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read()
    } catch (error) {
      if (attempt >= RETRY_ATTEMPTS || options.giveUpOn?.(error) === true) throw error
      options.onRetry?.(error, attempt)
      await (options.wait ?? pause)(RETRY_DELAY_MS)
    }
  }
}
