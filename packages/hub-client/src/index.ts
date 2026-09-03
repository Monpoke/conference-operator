/**
 * Typed browser access to the hub's oRPC contract.
 *
 * Kept out of the applications so that the console, and anything else that
 * ever talks to the hub from a browser, share one place where the token, the
 * expired session and the error hook are decided.
 */
export {
  createHubClient,
  SessionExpiredError,
  type HubClient,
  type HubClientOptions,
} from './client.js'
export { anonymousTokenStore, browserTokenStore, type TokenStore } from './token.js'
export {
  createHubAuth,
  type HubAuth,
  type HubAuthOptions,
  type SignInResult,
} from './auth.js'
