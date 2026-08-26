/**
 * Where the operator's bearer token lives, between two page loads.
 *
 * `localStorage` and not a cookie, because that is what the console already
 * does and what the pairing flow writes. Everything here is defensive about it
 * being unavailable: a browser with site data blocked throws on the *accessor*,
 * not on the value, and a console that refuses to open because a preference
 * could not be read would be worse than one that asks to sign in again.
 */
export interface TokenStore {
  read(): string | null
  write(value: string): void
  clear(): void
}

/** A store backed by `localStorage`, degrading to memory when it is unusable. */
export function browserTokenStore(key: string): TokenStore {
  let fallback: string | null = null

  return {
    read() {
      try {
        return globalThis.localStorage?.getItem(key) ?? fallback
      } catch {
        return fallback
      }
    },
    write(value) {
      fallback = value
      try {
        globalThis.localStorage?.setItem(key, value)
      } catch {
        // Kept in memory for this page's lifetime. Nothing else to do, and
        // nothing worth interrupting the operator over.
      }
    },
    clear() {
      fallback = null
      try {
        globalThis.localStorage?.removeItem(key)
      } catch {
        // See above.
      }
    },
  }
}

/** A store that holds nothing — for the surfaces that call the hub anonymously. */
export function anonymousTokenStore(): TokenStore {
  return { read: () => null, write: () => {}, clear: () => {} }
}
