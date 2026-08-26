import { createHubClient, type HubClient } from '@cloudnord/hub-client'
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
        signedIn.value = false
      },
      onError: (cause) => {
        toast.fail(cause instanceof Error ? cause.message : 'Échec de la requête')
      },
    }),
  )

  const mode = computed(() => boot.value?.mode ?? 'production')
  const dev = computed(() => mode.value === 'dev')
  const eventName = computed(() => boot.value?.event.name ?? '')
  const google = computed(() => boot.value?.google ?? null)

  function start(payload: Boot): void {
    boot.value = payload
    // A token in storage is a claim, not a session: the first protected call
    // decides. Showing the console and letting it fall back on a 401 is what
    // the page did, and it is the right order — the alternative is an extra
    // round trip in front of every load.
    signedIn.value = client.value.token.read() != null
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
      const response = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const body = (await response.json().catch(() => null)) as { token?: string } | null
      if (!response.ok || body?.token == null) {
        error.value = 'Identifiants refusés.'
        return
      }
      client.value.token.write(body.token)
      signedIn.value = true
    } catch {
      error.value = 'Le hub est injoignable.'
    } finally {
      signingIn.value = false
    }
  }

  /**
   * Local sign-out.
   *
   * Deliberately does not tell the hub: this is also the path taken on a 401,
   * where the session is already dead and talking to it would only add an error
   * to the one being handled.
   */
  function signOut(): void {
    client.value.token.clear()
    signedIn.value = false
  }

  return { boot, signedIn, signingIn, error, client, mode, dev, eventName, google, start, signIn, signOut }
})
