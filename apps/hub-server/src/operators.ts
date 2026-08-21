import { createLocalAccountIssuer } from '@better-auth/core/db'
import type { Auth } from './auth.js'

export interface ProvisionResult {
  id: string
  /** `false` quand le compte existait déjà et que le mot de passe a été remplacé. */
  created: boolean
}

/**
 * Provisionne un opérateur du hub, ou réinitialise son mot de passe.
 *
 * L'inscription publique est fermée (`disableSignUp`) : les comptes sont créés
 * par l'organisation, via ce chemin.
 *
 * **Le mot de passe est toujours posé**, y compris sur un compte existant.
 * Sortir sans rien faire semblait plus prudent, mais produisait exactement le
 * piège qu'on veut éviter : la commande annonçait « prêt » et le mot de passe
 * demandé n'était pas celui du compte — la connexion échouait sans explication.
 */
export async function provisionOperator(
  auth: Auth,
  { email, name, password }: { email: string; name: string; password: string },
): Promise<ProvisionResult> {
  const ctx = await auth.$context
  const hash = await ctx.password.hash(password)

  const existing = await ctx.internalAdapter.findUserByEmail(email)
  if (existing?.user != null) {
    const identifiant = existing.user.id
    const compte = await ctx.internalAdapter.findCredentialAccount(identifiant)
    if (compte == null) {
      // Compte créé par un autre chemin (OAuth, import) : il lui manque le
      // compte « credential » qui porte le mot de passe.
      await ctx.internalAdapter.linkAccount({
        userId: identifiant,
        providerId: 'credential',
        issuer: createLocalAccountIssuer('credential'),
        accountId: identifiant,
        password: hash,
      })
    } else {
      await ctx.internalAdapter.updatePassword(identifiant, hash)
    }
    return { id: identifiant, created: false }
  }

  const user = await ctx.internalAdapter.createUser(
    { email, name, emailVerified: true },
    // Provisionnement interne : ni OAuth ni SSO, on déclare la méthode e-mail.
    { method: 'email' },
  )
  // Même chemin que l'inscription native de Better Auth : `linkAccount` avec
  // l'issuer local. `updatePassword` ne conviendrait pas — il met à jour un
  // compte existant, il n'en crée pas.
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    issuer: createLocalAccountIssuer('credential'),
    accountId: user.id,
    password: hash,
  })
  return { id: user.id, created: true }
}
