import { createLocalAccountIssuer } from '@better-auth/core/db'
import type { Auth } from './auth.js'

export interface ProvisionResult {
  id: string
  /** `false` when the account already existed and the password was replaced. */
  created: boolean
}

/**
 * Provisions a hub operator, or resets their password.
 *
 * Public sign-up is closed (`disableSignUp`): accounts are created by the
 * organization, through this path.
 *
 * **The password is always set**, including on an existing account. Bailing out
 * with a no-op looked safer, but produced exactly the trap we want to avoid: the
 * command announced "ready" and the password asked for was not the account's —
 * sign-in failed with no explanation.
 */
export async function provisionOperator(
  auth: Auth,
  { email, name, password }: { email: string; name: string; password: string },
): Promise<ProvisionResult> {
  const ctx = await auth.$context
  const hash = await ctx.password.hash(password)

  const existing = await ctx.internalAdapter.findUserByEmail(email)
  if (existing?.user != null) {
    const id = existing.user.id
    const account = await ctx.internalAdapter.findCredentialAccount(id)
    if (account == null) {
      // Account created through another path (OAuth, import): it lacks the
      // "credential" account that carries the password.
      await ctx.internalAdapter.linkAccount({
        userId: id,
        providerId: 'credential',
        issuer: createLocalAccountIssuer('credential'),
        accountId: id,
        password: hash,
      })
    } else {
      await ctx.internalAdapter.updatePassword(id, hash)
    }
    return { id, created: false }
  }

  const user = await ctx.internalAdapter.createUser(
    { email, name, emailVerified: true },
    // Internal provisioning: neither OAuth nor SSO, we declare the email method.
    { method: 'email' },
  )
  // The same path as Better Auth's native sign-up: `linkAccount` with the local
  // issuer. `updatePassword` would not do — it updates an existing account, it
  // does not create one.
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    issuer: createLocalAccountIssuer('credential'),
    accountId: user.id,
    password: hash,
  })
  return { id: user.id, created: true }
}
