/**
 * Creation of an operator account.
 *
 * Public sign-up is closed on the hub: without this command, nobody can open the
 * console, and so nobody can approve a machine or moderate.
 *
 *   pnpm --filter @conference-operator/hub-server operator <email> "<name>" <password>
 */
import { loadConfig } from '../config.js'
import { openHubDatabase } from '../db.js'
import { createAuth, createAuthOptions, migrateAuth } from '../auth.js'
import { provisionOperator } from '../operators.js'

const [email, name, password] = process.argv.slice(2)

if (email == null || name == null || password == null) {
  console.error(
    'Usage : pnpm --filter @conference-operator/hub-server operator <email> "<nom>" <mot-de-passe>',
  )
  process.exit(1)
}
if (password.length < 8) {
  console.error('Le mot de passe doit faire au moins 8 caractères.')
  process.exit(1)
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

const { id, created } = await provisionOperator(createAuth(options), { email, name, password })
console.log(
  created
    ? `Opérateur créé : ${email} (${id})`
    : `Compte existant : ${email} (${id}) — mot de passe remplacé`,
)
console.log(`Console : ${config.publicUrl}/admin`)

sqlite.close()
process.exit(0)
