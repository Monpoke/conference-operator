import { createHubAuth, createHubClient, type HubClient } from '@cloudnord/hub-client'
import { useToast } from '@cloudnord/components'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { Boot } from '../boot.js'

/** Where the operator's token lives — the key the console has always used. */
export const TOKEN_KEY = 'hub-admin'

/**
 * Who is signed in, and the one client everything else calls through.
 *
 * The store owns the client rather than each view building its own, because the
 * expired-session branch has to be in exactly one place. The console used to
 * carry it inside its own `appeler()`, which held right up until three call
 * sites started using `fetch` directly.
 */
export const useSessionStore = defineStore('session', () => {
  const boot = ref<Boot | null>(null)
  const signedIn = ref(false)
  /** Who is signed in, when the hub says so — the return from Google carries it. */
  const identity = ref<string | null>(null)
  const signingIn = ref(false)
  const error = ref<string | null>(null)

  const toast = useToast()

  /**
   * `shallowRef`: the client holds a live link, not data.
   *
   * Making it deeply reactive would have Pinia walk an oRPC proxy on every
   * access, and that proxy answers to *any* property name — the walk does not
   * terminate on anything useful.
   */
  const client = shallowRef<HubClient>(
    createHubClient({
      tokenKey: TOKEN_KEY,
      onExpired: () => {
        forget()
      },
      onError: (cause) => {
        toast.fail(cause instanceof Error ? cause.message : 'Échec de la requête')
      },
    }),
  )

  /**
   * Better Auth lives in `@cloudnord/hub-client`, next to the token.
   *
   * The mobile control app makes exactly the same calls, and they are the ones
   * where a second copy costs dearly — a `signOut` that forgets to tell the hub
   * lets a Google session reopen on reload.
   */
  const hubAuth = createHubAuth({ token: client.value.token })

  const mode = computed(() => boot.value?.mode ?? 'production')
  const dev = computed(() => mode.value === 'dev')
  const eventName = computed(() => boot.value?.event.name ?? '')
  const google = computed(() => boot.value?.google ?? null)

  function start(payload: Boot): void {
    boot.value = payload
    /*
     * Two ways to arrive signed in, and only one of them leaves a token.
     *
     * A token in storage is a claim, not a session: the first protected call
     * decides. Showing the console and letting it fall back on a 401 is the
     * right order — the alternative is an extra round trip in front of every
     * load.
     *
     * Coming back from Google leaves no token at all, only a cookie. The hub
     * accepts either — `getSession` reads the bearer header or the cookie — so
     * the console has to ask before concluding that nobody is signed in.
     * Without this, a Google sign-in succeeded and landed back on the sign-in
     * screen.
     */
    if (client.value.token.read() != null) {
      signedIn.value = true
      return
    }
    void resume()
  }

  /**
   * Is there a cookie session behind us?
   *
   * Asked only when there is no token, and never blocking: the sign-in screen
   * is the right thing to show meanwhile, and it will say what it needs to at
   * the first attempt.
   */
  async function resume(): Promise<void> {
    const email = await hubAuth.resume()
    if (email == null) return
    identity.value = email
    signedIn.value = true
  }

  /**
   * Google sign-in.
   *
   * A **POST**, and then a navigation to the URL it answers with. Better Auth
   * does not redirect from a GET on this path — it replies `null`, which is
   * exactly what a naive `location.assign` on it produces: a blank page and no
   * way to tell why.
   *
   * `callbackURL` is where Google sends the operator back. `/admin` rather than
   * the current address: the round trip drops any query string anyway, and the
   * one address worth landing on is the one somebody would have typed.
   */
  async function signInWithGoogle(): Promise<void> {
    error.value = null
    const resultat = await hubAuth.googleUrl('/admin')
    if (!resultat.ok) {
      error.value = resultat.message
      return
    }
    globalThis.location.assign(resultat.url)
  }

  /**
   * Password sign-in.
   *
   * Better Auth's own endpoint rather than a contract procedure: the hub mounts
   * it under `/api/auth`, outside oRPC, and it is the path that must keep
   * working when Google is unreachable — which is the whole reason the password
   * account exists.
   */
  async function signIn(email: string, password: string): Promise<void> {
    signingIn.value = true
    error.value = null
    try {
      const resultat = await hubAuth.signIn(email, password)
      if (!resultat.ok) {
        error.value = resultat.message
        return
      }
      signedIn.value = true
    } finally {
      signingIn.value = false
    }
  }

  /**
   * Forgets the session here, without telling the hub.
   *
   * This is also the path a 401 takes, where the session is already dead and
   * talking to it would only add an error to the one being handled.
   */
  function forget(): void {
    client.value.token.clear()
    identity.value = null
    signedIn.value = false
  }

  /**
   * Sign-out proper.
   *
   * Tells the hub first, because a Google session lives in a **cookie**: only
   * the server can drop it. Clearing local state alone would put the sign-in
   * screen up, and `get-session` would sign the operator straight back in on
   * the next reload — a sign-out button that visibly does nothing.
   */
  async function signOut(): Promise<void> {
    await hubAuth.signOut()
    forget()
  }

  return {
    boot,
    signedIn,
    signingIn,
    error,
    identity,
    client,
    mode,
    dev,
    eventName,
    google,
    start,
    resume,
    signIn,
    signInWithGoogle,
    signOut,
  }
})
