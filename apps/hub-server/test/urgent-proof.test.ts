import { describe, expect, it } from 'vitest'
import type { OperatorContext } from '../src/context.js'
import { FRESH_SSO_MS, requireUrgentProof, urgentProofOf } from '../src/urgent-proof.js'

/**
 * The proof an urgent message takes, for every kind of account.
 *
 * Better Auth stubbed: the case that matters — an account with a password **and**
 * Google linked, signed in through Google — cannot be produced over HTTP without
 * a real provider.
 */
function context(options: {
  providers: string[]
  sessionAgeMs: number
  passwordOk?: boolean
}): OperatorContext {
  return {
    headers: new Headers(),
    operator: { id: 'u1', email: 'pierre@cloudnord.fr', roles: ['admin'] },
    auth: {
      api: {
        listUserAccounts: async () => options.providers.map((providerId) => ({ providerId })),
        getSession: async () => ({ session: { createdAt: new Date(Date.now() - options.sessionAgeMs) } }),
        verifyPassword: async () => {
          if (options.passwordOk !== true) throw new Error('INVALID_PASSWORD')
          return { status: true }
        },
      },
    },
  } as unknown as OperatorContext
}

describe('the proof of an urgent message', () => {
  it('takes a fresh Google session from an account that also has a password', async () => {
    const both = context({ providers: ['credential', 'google'], sessionAgeMs: 30_000 })
    expect(await urgentProofOf(both)).toEqual({ password: true, sso: true, fresh: true })
    await expect(requireUrgentProof(both, undefined)).resolves.toBeUndefined()
  })

  it('asks again once the session is old: a new sign-in, or the password', async () => {
    const stale = context({ providers: ['credential', 'google'], sessionAgeMs: FRESH_SSO_MS + 1_000, passwordOk: true })
    await expect(requireUrgentProof(stale, undefined)).rejects.toThrow('reconnectez-vous')
    await expect(requireUrgentProof(stale, 'control-password-2026')).resolves.toBeUndefined()
  })

  it('never takes a fresh session alone from a password-only account', async () => {
    const local = context({ providers: ['credential'], sessionAgeMs: 1_000 })
    await expect(requireUrgentProof(local, undefined)).rejects.toThrow('Mot de passe requis')
    await expect(requireUrgentProof(local, 'wrong')).rejects.toThrow('Mot de passe incorrect')
  })
})
