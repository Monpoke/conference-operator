import { ORPCError } from '@orpc/server'
import { requirePermission, type OperatorContext } from './context.js'

/**
 * An urgent message, confirmed by a fresh proof of identity.
 *
 * An urgent message takes over every screen of a room, the hall screen and the
 * live banner: an open console left on a table must not be enough to send one.
 * Hence a right of its own — `message:urgent` — and, at the moment of sending,
 * proof that whoever presses is the account's owner:
 *
 * - an account with a password may type it again;
 * - an account linked to Google may sign in there again: its proof is a session
 *   opened less than `FRESH_SSO_MS` ago, and the provider decides how hard to ask
 *   (its own session, a second factor) — that is what SSO means.
 *
 * Either one, not the account's "kind": an operator provisioned with a password
 * and later linked to Google signs in through Google, and was asked a password
 * they had never used.
 */
export const FRESH_SSO_MS = 5 * 60_000

export interface UrgentProof {
  /** The account has a password on the hub. */
  password: boolean
  /** The account is linked to an identity provider. */
  sso: boolean
  /** The current session is recent enough to count as signing in again. */
  fresh: boolean
}

/** Which proofs this operator can give, and whether the session already is one. */
export async function urgentProofOf(context: OperatorContext): Promise<UrgentProof> {
  const accounts = (await context.auth.api.listUserAccounts({ headers: context.headers })) as {
    providerId: string
  }[]
  const session = await context.auth.api.getSession({ headers: context.headers })
  const createdAt = session == null ? Number.NaN : new Date(session.session.createdAt).getTime()
  return {
    password: accounts.some((account) => account.providerId === 'credential'),
    sso: accounts.some((account) => account.providerId !== 'credential'),
    fresh: Date.now() - createdAt < FRESH_SSO_MS,
  }
}

/** Refuses an urgent message without the right, or without a fresh proof. */
export async function requireUrgentProof(context: OperatorContext, password: string | undefined): Promise<void> {
  requirePermission(context.operator, 'message:urgent')
  const proof = await urgentProofOf(context)
  if (password != null && password !== '' && proof.password) {
    try {
      await context.auth.api.verifyPassword({ body: { password }, headers: context.headers })
      return
    } catch {
      throw new ORPCError('FORBIDDEN', { message: 'Mot de passe incorrect.', data: { reason: 'password' } })
    }
  }
  // Signed in again through the provider a moment ago: that is the proof.
  if (proof.sso && proof.fresh) return
  throw new ORPCError('FORBIDDEN', {
    message: proof.sso
      ? 'Confirmation requise : reconnectez-vous (SSO) ou saisissez votre mot de passe.'
      : 'Mot de passe requis pour un message urgent.',
    data: { reason: proof.sso ? 'sso-reauth' : 'password' },
  })
}
