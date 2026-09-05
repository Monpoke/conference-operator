import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract } from '@conference-operator/contract'
import { anonymousTokenStore, browserTokenStore, type TokenStore } from './token.js'

/**
 * The hub, typed, from a browser.
 *
 * What this replaces is a hand-written RPC client living inside a template
 * literal: forty procedure paths written as strings, none of them checked
 * against the contract, and a 401 handled at the one call site that remembered
 * to. The montage itself is not new — it is the one the integration tests have
 * been using since the contract landed.
 */
export interface HubClientOptions {
  /**
   * Where the hub answers. Defaults to the page's own origin.
   *
   * Only worth setting from a test, or from a surface served by somebody else
   * than the hub — the room-control app talks to its *local* server, not to
   * this one.
   */
  origin?: string
  /**
   * `localStorage` key holding the operator's bearer token, or `null` to call
   * the hub anonymously — which is what the public surfaces do.
   */
  tokenKey?: string | null
  /** Extra headers, evaluated per request (the room client identifies itself here). */
  headers?: () => Record<string, string>
  /**
   * The hub said the session is over.
   *
   * Called as the response is read, so the caller can put the sign-in screen
   * back up while the failed call unwinds. The token is already cleared by the
   * time this runs: a 401 means the hub has stopped honouring it, and keeping
   * it would only produce a second one.
   */
  onExpired?: () => void
  /**
   * Anything else that failed, on its way out.
   *
   * A hook, not a handler: the error is rethrown either way. It exists so that
   * a surface can raise one toast in one place instead of at forty call sites.
   */
  onError?: (error: unknown) => void
  /**
   * The `fetch` to send with. Defaults to the page's own.
   *
   * Exposed so a test can answer without a server, and so a surface that has to
   * go through something else — a proxy, an instrumented fetch — is not forced
   * to reach for a global.
   */
  fetch?: RPCLinkOptions['fetch']
}

/** The link's own option bag, narrowed to what this layer forwards. */
type RPCLinkOptions = ConstructorParameters<typeof RPCLink<Record<never, never>>>[0]

export interface HubClient {
  rpc: ContractRouterClient<typeof contract>
  token: TokenStore
}

/**
 * Raised the moment the hub answers 401, before oRPC decodes anything.
 *
 * The status is read off the response rather than off the decoded error on
 * purpose. oRPC surfaces a 401 whose body it cannot parse as
 * `MALFORMED_ORPC_RESPONSE` with no status attached — so an expired session and
 * a garbled payload look alike by the time the error reaches the caller. At the
 * transport, "the hub answered 401" is a fact with one meaning.
 */
export class SessionExpiredError extends Error {
  /** Survives whatever wrapping happens on the way up. */
  readonly sessionExpired = true

  constructor() {
    super('Session expirée')
    this.name = 'SessionExpiredError'
  }
}

/** True for the error above, however deeply the link wrapped it. */
function isSessionExpired(error: unknown): boolean {
  for (let cursor = error, depth = 0; cursor != null && depth < 5; depth += 1) {
    if ((cursor as { sessionExpired?: unknown }).sessionExpired === true) return true
    cursor = (cursor as { cause?: unknown }).cause
  }
  return false
}

export function createHubClient(options: HubClientOptions = {}): HubClient {
  const token =
    options.tokenKey == null ? anonymousTokenStore() : browserTokenStore(options.tokenKey)

  const send: NonNullable<RPCLinkOptions['fetch']> =
    options.fetch ?? ((url, init) => globalThis.fetch(url, init))

  const rpc: ContractRouterClient<typeof contract> = createORPCClient(
    new RPCLink({
      origin: options.origin,
      url: '/rpc',
      headers: () => {
        const bearer = token.read()
        return {
          ...(bearer == null ? {} : { authorization: `Bearer ${bearer}` }),
          ...(options.headers?.() ?? {}),
        }
      },
      async fetch(url, init, clientOptions, path) {
        const response = await send(url, init, clientOptions, path)
        if (response.status === 401) {
          token.clear()
          options.onExpired?.()
          throw new SessionExpiredError()
        }
        return response
      },
      /*
       * One interceptor around the whole call rather than a check at each call
       * site. The console had its failure branch inside its own `appeler()`,
       * which worked precisely as long as nobody called `fetch` directly — and
       * by the end, three places did.
       */
      interceptors: [
        async (interceptorOptions) => {
          try {
            return await interceptorOptions.next()
          } catch (error) {
            // An expired session is not an error to raise a toast about: it has
            // its own screen, and `onExpired` has already put it up.
            if (!isSessionExpired(error)) options.onError?.(error)
            throw error
          }
        },
      ],
    }),
  )

  return { rpc, token }
}
