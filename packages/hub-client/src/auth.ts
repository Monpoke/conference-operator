import type { TokenStore } from './token.js'

/**
 * Better Auth, seen from the browser.
 *
 * These calls do not go through oRPC: the hub mounts Better Auth under
 * `/api/auth`, outside the contract. They live here and not in an application
 * because they now have two callers — the console and the mobile control app —
 * and those are exactly the paths where a divergence is expensive: a `signOut`
 * that forgets to tell the hub leaves a Google session that reopens on the next
 * reload, and the button looks like it does nothing.
 *
 * No framework, and no state: each application keeps its own store and its own
 * screen. It is the layout that separates them — a desktop form and a phone form
 * do not have the same shape — not what they ask of the hub.
 */

/** What a sign-in attempt returns: nothing, or a displayable reason. */
export type SignInResult = { ok: true } | { ok: false; message: string }

export interface HubAuthOptions {
  /** Where to write the bearer token of a password sign-in. */
  token: TokenStore
  /** Injectable for the tests: no network, no clock. */
  fetch?: typeof globalThis.fetch
}

export interface HubAuth {
  /** Is a cookie session already open? Returns the known address, or `null`. */
  resume(): Promise<string | null>
  signIn(email: string, password: string): Promise<SignInResult>
  /** Returns the address to navigate to, or a reason. */
  googleUrl(callbackURL: string): Promise<{ ok: true; url: string } | { ok: false; message: string }>
  signOut(): Promise<void>
}

export function createHubAuth(options: HubAuthOptions): HubAuth {
  const send = options.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args))

  async function body<T>(response: Response): Promise<T | null> {
    return (await response.json().catch(() => null)) as T | null
  }

  return {
    /**
     * Is there a cookie session behind us?
     *
     * Asked only when there is no token, and never blocking: the sign-in screen
     * is the right thing to show meanwhile. A return from Google leaves **no**
     * token, only a cookie — without this question, a successful Google sign-in
     * fell back to the sign-in screen.
     */
    async resume() {
      try {
        const response = await send('/api/auth/get-session')
        if (!response.ok) return null
        const payload = await body<{ user?: { email?: string } }>(response)
        return payload?.user == null ? null : (payload.user.email ?? null)
      } catch {
        // Hub unreachable at load time: the sign-in screen will say what is
        // needed on the first attempt.
        return null
      }
    },

    /**
     * Password sign-in.
     *
     * Better Auth's endpoint rather than a contract procedure: it is the path
     * that must keep working when Google is unreachable, which is the whole
     * reason the password account exists.
     */
    async signIn(email, password) {
      try {
        const response = await send('/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }),
        })
        const payload = await body<{ token?: string }>(response)
        if (!response.ok || payload?.token == null) return { ok: false, message: 'Identifiants refusés.' }
        options.token.write(payload.token)
        return { ok: true }
      } catch {
        return { ok: false, message: 'Le hub est injoignable.' }
      }
    },

    /**
     * A **POST**, then a navigation to the address returned.
     *
     * Better Auth does not redirect from a GET on this path — it answers `null`,
     * which is exactly what a naive `location.assign` produces: a blank page, and
     * nothing to say what was missing.
     */
    async googleUrl(callbackURL) {
      try {
        const response = await send('/api/auth/sign-in/social', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'google', callbackURL }),
        })
        const payload = await body<{ url?: string; message?: string }>(response)
        if (!response.ok || payload?.url == null) {
          return { ok: false, message: payload?.message ?? 'Google indisponible.' }
        }
        return { ok: true, url: payload.url }
      } catch {
        return { ok: false, message: 'Le hub est injoignable.' }
      }
    },

    /**
     * Sign-out, telling the hub first.
     *
     * A Google session lives in a **cookie**: only the server can close it.
     * Clearing the local state alone would bring the sign-in screen back, and
     * `get-session` would reconnect on the next reload.
     *
     * The token is cleared whatever happens: staying signed in because the hub
     * did not answer is the opposite of what clicking asks for.
     */
    async signOut() {
      const bearer = options.token.read()
      try {
        await send('/api/auth/sign-out', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(bearer == null ? {} : { authorization: `Bearer ${bearer}` }),
          },
          body: '{}',
        })
      } catch {
        // See above.
      }
      options.token.clear()
    },
  }
}
