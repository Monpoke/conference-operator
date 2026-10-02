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
 * - an account with a password types it again;
 * - an account signed in through Google has no password on the hub. Its proof is
 *   a session opened less than `FRESH_SSO_MS` ago: the console sends it through the
 *   provider again, which decides how hard to ask (its own session, a second
 *   factor) — that is what SSO means.
 */
export const FRESH_SSO_MS = 5 * 60_000

export interface UrgentProof {
  method: 'password' | 'sso'
  fresh: boolean
}

/** How this operator proves who they are: password if the account has one, SSO otherwise. */
export async function urgentProofOf(context: OperatorContext): Promise<UrgentProof> {
  const accounts = (await context.auth.api.listUserAccounts({ headers: context.headers })) as {
    providerId: string
  }[]
  if (accounts.some((account) => account.providerId === 'credential')) {
    return { method: 'password', fresh: false }
  }
  const session = await context.auth.api.getSession({ headers: context.headers })
  const createdAt = session == null ? Number.NaN : new Date(session.session.createdAt).getTime()
  return { method: 'sso', fresh: Date.now() - createdAt < FRESH_SSO_MS }
}

/** Refuses an urgent message without the right, or without a fresh proof. */
export async function requireUrgentProof(context: OperatorContext, password: string | undefined): Promise<void> {
  requirePermission(context.operator, 'message:urgent')
  const proof = await urgentProofOf(context)
  if (proof.method === 'sso') {
    if (!proof.fresh) {
      throw new ORPCError('FORBIDDEN', {
        message: 'Reconnexion requise : un message urgent se confirme en se reconnectant (SSO).',
        data: { reason: 'sso-reauth' },
      })
    }
    return
  }
  if (password == null || password === '') {
    throw new ORPCError('FORBIDDEN', {
      message: 'Mot de passe requis pour un message urgent.',
      data: { reason: 'password' },
    })
  }
  try {
    await context.auth.api.verifyPassword({ body: { password }, headers: context.headers })
  } catch {
    throw new ORPCError('FORBIDDEN', { message: 'Mot de passe incorrect.', data: { reason: 'password' } })
  }
}
