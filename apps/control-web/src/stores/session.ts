import { CONTROL_SESSION_HEADER } from '@conference-operator/contract'
import { useToast } from '@conference-operator/components'
import { createHubAuth, createHubClient, type HubClient } from '@conference-operator/hub-client'
import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import type { BootScope } from '../boot.js'

/**
 * The token key, **shared with the console**.
 *
 * Same origin, so same storage: an operator signed in to `/admin` on their phone
 * opens `/regie` already signed in. Signing in twice on the same device in the
 * middle of an event is precisely the friction being removed — and a second key
 * would have reintroduced it for nothing.
 */
export const TOKEN_KEY = 'hub-admin'

/**
 * The identity of **this tab**, and of it alone.
 *
 * `sessionStorage`, and the choice is the heart of the matter: it survives an F5
 * — a reload mid-talk must not lose the room — and dies with the tab.
 * `localStorage` would be shared between tabs, which is exactly what we are
 * trying to tell apart; a module variable would not survive the reload.
 *
 * The in-memory fallback covers browsers that refuse storage: two tabs would be
 * confused there on reload, and that is an acceptable defect compared with a
 * page that does not open.
 *
 * The stored key keeps its name: it is written on operators' devices.
 */
const SESSION_KEY = 'regie-session'
let fallback: string | null = null

export function thisTabSession(): string {
  try {
    const known = globalThis.sessionStorage?.getItem(SESSION_KEY)
    if (known != null && known !== '') return known
    const fresh = newIdentifier()
    globalThis.sessionStorage?.setItem(SESSION_KEY, fresh)
    return fresh
  } catch {
    fallback ??= newIdentifier()
    return fallback
  }
}

function newIdentifier(): string {
  return globalThis.crypto?.randomUUID?.() ?? `regie-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Who is signed in, and the client everything goes through.
 *
 * Only exists for the remote scope: served by a room machine, the control app
 * talks only to its own local loopback and has nobody to authenticate. The store
 * is mounted all the same — it does nothing until something calls it — rather
 * than made conditional, because a store that sometimes exists reads twice as
 * badly as one that is sometimes of no use.
 */
export const useSessionStore = defineStore('session', () => {
  const signedIn = ref(false)
  const identity = ref<string | null>(null)
  const signingIn = ref(false)
  const error = ref<string | null>(null)
  const google = ref<{ domain: string } | null>(null)

  const toast = useToast()

  /**
   * `shallowRef`: the client carries a link, not data.
   *
   * Making it deeply reactive would walk an oRPC proxy on every access — and that
   * proxy answers to *any* property name, so the walk stops at nothing useful.
   */
  const client = shallowRef<HubClient>(
    createHubClient({
      tokenKey: TOKEN_KEY,
      /*
       * The tab announces itself on every call.
       *
       * It is what the lock keys on, not the account: without this header the hub
       * refuses to take or to drive a room rather than fall back on the address —
       * a silent fallback that would only be discovered the day two tabs drive the
       * same room.
       */
      headers: () => ({ [CONTROL_SESSION_HEADER]: thisTabSession() }),
      onExpired: () => forget(),
      onError: (cause) => {
        toast.fail(cause instanceof Error ? cause.message : 'Échec de la requête')
      },
    }),
  )

  const auth = createHubAuth({ token: client.value.token })

  /**
   * Two ways of arriving signed in, and only one leaves a token.
   *
   * A token in storage is a claim, not a session: it is the first protected call
   * that settles it. A return from Google, on the other hand, leaves no token —
   * only a cookie — so one has to ask before concluding that nobody is signed in.
   */
  function start(boot: BootScope): void {
    google.value = boot.google
    if (client.value.token.read() != null) {
      signedIn.value = true
      return
    }
    void resume()
  }

  async function resume(): Promise<void> {
    const email = await auth.resume()
    if (email == null) return
    identity.value = email
    signedIn.value = true
  }

  async function signIn(email: string, password: string): Promise<void> {
    signingIn.value = true
    error.value = null
    try {
      const result = await auth.signIn(email, password)
      if (!result.ok) {
        error.value = result.message
        return
      }
      identity.value = email
      signedIn.value = true
    } finally {
      signingIn.value = false
    }
  }

  /**
   * `callbackURL` brings us back **to this very page**.
   *
   * The Google round trip loses the query string but keeps the path: an operator
   * signing in from `/regie/track-1` must find their room again, not the choice
   * screen. That is where the difference from the console counts — the console
   * has a single address to come back to, the control app has one per room.
   */
  async function signInWithGoogle(): Promise<void> {
    error.value = null
    const result = await auth.googleUrl(globalThis.location.pathname)
    if (!result.ok) {
      error.value = result.message
      return
    }
    globalThis.location.assign(result.url)
  }

  /** Forgets the session here, saying nothing to the hub: it is also a 401's path. */
  function forget(): void {
    client.value.token.clear()
    identity.value = null
    signedIn.value = false
  }

  async function signOut(): Promise<void> {
    await auth.signOut()
    forget()
  }

  return {
    signedIn,
    signingIn,
    error,
    identity,
    google,
    client,
    start,
    resume,
    signIn,
    signInWithGoogle,
    signOut,
  }
})
