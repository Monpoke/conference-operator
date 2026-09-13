/**
 * Creation of an operator account.
 *
 * Public sign-up is closed on the hub: without this command, nobody can open the
 * console, and so nobody can approve a machine or moderate.
 *
 *   pnpm --filter @conference-operator/hub-server operator <email> "<name>" <password> [--role admin,moderation]
 *
 * Without `--role`, a new account is admin (this is how the first admin exists)
 * and an existing account keeps its groups.
 */
import { ACCESS_ROLE_NAMES, isAccessRole, type AccessRole } from '@conference-operator/contract'
import { loadConfig } from '../config.js'
import { openHubDatabase } from '../db.js'
import { createAuth, createAuthOptions, migrateAuth } from '../auth.js'
import { provisionOperator } from '../operators.js'

const args = process.argv.slice(2)
const roleFlag = args.indexOf('--role')
const roleValue = roleFlag === -1 ? undefined : args[roleFlag + 1]
if (roleFlag !== -1) args.splice(roleFlag, 2)
const [email, name, password] = args

const usage =
  'Usage : pnpm --filter @conference-operator/hub-server operator <email> "<nom>" <mot-de-passe> [--role admin,moderation]'

if (email == null || name == null || password == null || (roleFlag !== -1 && roleValue == null)) {
  console.error(usage)
  process.exit(1)
}
if (password.length < 8) {
  console.error('Le mot de passe doit faire au moins 8 caractères.')
  process.exit(1)
}

let roles: AccessRole[] | undefined
if (roleValue != null) {
  const names = roleValue.split(',').map((role) => role.trim()).filter((role) => role !== '')
  const unknown = names.filter((role) => !isAccessRole(role))
  if (names.length === 0 || unknown.length > 0) {
    console.error(
      `Rôle inconnu : ${unknown.join(', ') || '(vide)'}. Rôles possibles : ${ACCESS_ROLE_NAMES.join(', ')}`,
    )
    process.exit(1)
  }
  roles = names as AccessRole[]
}

const config = loadConfig()
const { sqlite } = openHubDatabase(config.databasePath)

// The same options as the server: the command writes into the database it reads.
const options = createAuthOptions({
  sqlite,
  secret: config.authSecret,
  publicUrl: config.publicUrl,
  onDeviceRequest: () => {},
  isKnownClient: () => true,
})
await migrateAuth(options)

const { id, created } = await provisionOperator(createAuth(options), {
  email,
  name,
  password,
  ...(roles != null ? { roles } : {}),
})
console.log(
  created
    ? `Opérateur créé : ${email} (${id}) — rôles : ${(roles ?? ['admin']).join(', ')}`
    : `Compte existant : ${email} (${id}) — mot de passe remplacé${roles != null ? `, rôles : ${roles.join(', ')}` : ''}`,
)
console.log(`Console : ${config.publicUrl}/admin`)

sqlite.close()
process.exit(0)
