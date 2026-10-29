import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { provisionOperator } from '../src/operators.js'
import { createHub, type Hub } from '../src/server.js'

const TRACK_1 = 'track-1-teilhard-de-chardin'
const PHOTO = 'https://cdn.exemple/partenaire.png'
/** Its address names no type: stored without an extension. */
const AVATAR = 'https://cdn.exemple/avatar?id=42'
const PASSWORD = 'mot-de-passe-solide-42'

const running: { hub: Hub; dir: string }[] = []

afterEach(async () => {
  for (const { hub, dir } of running.splice(0)) {
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A hub on disk, its images and themes beside the database, with one operator signed in. */
async function start(email: string, authSecret = 'test-secret-'.padEnd(48, 'x')) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-sauvegarde-'))
  const hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: join(dir, 'hub.db'),
    publicUrl: 'http://127.0.0.1',
    authSecret,
    logLevel: 'fatal',
  })
  running.push({ hub, dir })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  const origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`
  await provisionOperator(hub.auth, { email, name: email, password: PASSWORD })
  const token = await signIn(origin, email)
  return { hub, dir, origin, authorization: `Bearer ${token}` }
}

async function signIn(origin: string, email: string): Promise<string | null> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  return response.ok ? ((await response.json()) as { token: string }).token : null
}

/** The first hub, configured the way a team leaves it the day before. */
async function configured() {
  const a = await start('regie@cloudnord.fr')
  a.hub.services.settings.update({ eventName: 'Cloud Nord 2026', openFeedbackProjectId: 'cn26' })
  a.hub.services.rooms.upsert({
    id: TRACK_1,
    name: 'Track #1',
    trackId: TRACK_1,
    obs: { A: { url: 'ws://10.0.0.5:4455', password: null }, B: { url: 'ws://10.0.0.6:4455', password: null } },
    sceneRoles: { A: {}, B: {} },
  })
  a.hub.services.rooms.setStream({ roomId: TRACK_1, rtmpUrl: 'rtmp://diffusion/live', streamKey: 'cle-secrete' })
  await a.hub.services.assets.store(PHOTO, Buffer.from('octets-png'), 'image/png')
  await a.hub.services.assets.store(AVATAR, Buffer.from('octets-avatar'), 'image/jpeg')
  const partner = a.hub.services.wall.saveHubPost({ author: 'NOVA Atelier', text: 'Merci !', image: PHOTO }, 'regie')!
  const forced = a.hub.services.wall.post({ source: 'wallsio', author: 'Cloud Nord', text: 'J-1', externalId: 'w-1', active: false })
  a.hub.services.wall.setForcedOnScreen(forced.id, true)
  a.hub.services.wall.post({ source: 'form', author: 'Public', text: 'message de test' })
  a.hub.services.wallsIo.config.setToken('jeton-walls-io-1234')
  return { a, partner, forced }
}

async function exportFrom(origin: string, authorization: string) {
  const response = await fetch(`${origin}/sauvegarde/export.json`, { headers: { authorization } })
  return { status: response.status, body: response.ok ? ((await response.json()) as Record<string, unknown>) : null }
}

async function restoreInto(origin: string, authorization: string | null, body: unknown) {
  const response = await fetch(`${origin}/sauvegarde/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization == null ? {} : { authorization }) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('the hub’s backup', () => {
  it('carries the configuration to a fresh hub, and leaves the day’s data behind', async () => {
    const { a, partner, forced } = await configured()
    const backup = await exportFrom(a.origin, a.authorization)
    expect(backup.status).toBe(200)
    // Sealed, never in clear.
    expect(JSON.stringify(backup.body)).not.toContain('jeton-walls-io-1234')
    expect(JSON.stringify(backup.body)).not.toContain('cle-secrete')

    const b = await start('admin@cloudnord.fr')
    const restored = await restoreInto(b.origin, b.authorization, backup.body)
    expect(restored.body.error).toBeUndefined()
    expect(restored.status).toBe(200)
    expect(restored.body.aRessaisir).toEqual([])

    expect(b.hub.services.settings.get()).toMatchObject({ eventName: 'Cloud Nord 2026', openFeedbackProjectId: 'cn26' })
    expect(b.hub.services.rooms.get(TRACK_1)?.obs.A.url).toBe('ws://10.0.0.5:4455')
    expect(b.hub.services.rooms.streams().find((room) => room.roomId === TRACK_1)).toMatchObject({ hasKey: true })
    expect(b.hub.services.wallsIo.config.token()).toBe('jeton-walls-io-1234')
    // The partner's post and its photo; the walls.io post still shown despite walls.io.
    expect(b.hub.services.assets.has(PHOTO)).toBe(true)
    expect(b.hub.services.assets.has(AVATAR)).toBe(true)
    expect((await b.hub.services.assets.read(b.hub.services.assets.keyOf(AVATAR)))?.bytes.toString()).toBe('octets-avatar')
    expect(b.hub.services.wall.screen().posts.map((post) => post.id).sort()).toEqual([partner.id, forced.id].sort())
    // The audience's test message stays behind.
    expect(b.hub.services.wall.pending()).toEqual([])
    // The first hub's operator signs in on the new one, with the same password.
    expect(await signIn(b.origin, 'regie@cloudnord.fr')).not.toBeNull()
  })

  it('keeps the new hub’s own admin, and names the secrets its key cannot open', async () => {
    const { a } = await configured()
    const backup = await exportFrom(a.origin, a.authorization)

    const b = await start('regie@cloudnord.fr', 'autre-secret-'.padEnd(48, 'y'))
    const restored = await restoreInto(b.origin, b.authorization, backup.body)

    expect(restored.status).toBe(200)
    expect(restored.body.comptesIgnores).toEqual(['regie@cloudnord.fr'])
    expect(restored.body.aRessaisir).toEqual([
      'Jeton walls.io (Réglages → Mur social — walls.io)',
      `Clé de diffusion de la salle ${TRACK_1} (Réglages → Diffusion)`,
    ])
    // The settings came across all the same.
    expect(b.hub.services.settings.get().eventName).toBe('Cloud Nord 2026')
  })

  it('opens to an operator only, and refuses what is not one of its backups', async () => {
    const { a } = await configured()
    expect((await exportFrom(a.origin, 'Bearer pas-une-session')).status).toBe(401)
    const backup = (await exportFrom(a.origin, a.authorization)).body!

    const b = await start('admin@cloudnord.fr')
    expect((await restoreInto(b.origin, null, backup)).status).toBe(401)
    expect((await restoreInto(b.origin, b.authorization, { bonjour: true })).status).toBe(400)
    const newer = await restoreInto(b.origin, b.authorization, { ...backup, migration: 'migration-a-venir' })
    expect(newer.status).toBe(400)
    expect(String(newer.body.error)).toContain('plus récent')
    expect(b.hub.services.settings.get().eventName).toBeNull()
  })

  it('writes back only files named like the stores name them', async () => {
    const { a } = await configured()
    const backup = (await exportFrom(a.origin, a.authorization)).body as { fichiers: { images: Record<string, string> } }
    backup.fichiers.images['../../evasion.sh'] = Buffer.from('#!/bin/sh').toString('base64')

    const b = await start('admin@cloudnord.fr')
    expect((await restoreInto(b.origin, b.authorization, backup)).status).toBe(200)
    expect(existsSync(join(b.dir, 'evasion.sh'))).toBe(false)
    expect(existsSync(join(b.dir, 'assets', '../../evasion.sh'))).toBe(false)
  })
})
