import Database from 'better-sqlite3'
import { createAuth, createAuthOptions, migrateAuth } from './src/auth.js'
const sqlite = new Database(':memory:')
const options = createAuthOptions({ sqlite, secret: 'x'.repeat(40), publicUrl: 'http://localhost:8787', onDeviceRequest: () => {}, isKnownClient: () => true })
await migrateAuth(options)
const ctx = await createAuth(options).$context
console.log('createUser.length =', ctx.internalAdapter.createUser.length)
console.log('createUser source:', ctx.internalAdapter.createUser.toString().slice(0, 320))
console.log('updatePassword.length =', ctx.internalAdapter.updatePassword.length)
