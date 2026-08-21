import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_1 = 'track-1-teilhard-de-chardin'
const TRACK_2 = 'track-2-mf-1092'

let hub: Hub
let origin: string
let jetonOperateur: string
let jetonSalle: string

async function rpc(chemin: string, entree: unknown, jeton?: string, clientId?: string) {
  const response = await fetch(`${origin}/rpc/${chemin}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(jeton != null ? { authorization: `Bearer ${jeton}` } : {}),
      ...(clientId != null ? { 'x-room-client-id': clientId } : {}),
    },
    body: JSON.stringify({ json: entree }),
  })
  return { status: response.status, body: (await response.json()) as { json?: never } }
}

beforeEach(async () => {
  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
  })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`

  await provisionOperator(hub.auth, OPERATOR)
  const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.ensureFromTracks(snapshot.program.rooms)

  const connexion = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  jetonOperateur = ((await connexion.json()) as { token: string }).token

  // Appairage simulé : la machine est liée, comme après approbation.
  hub.services.devices.bind({ clientId: CLIENT_ID, roomId: TRACK_1, approvedByUserId: 'op' })
  const claim = await rpc('devices/claim', {}, jetonOperateur, CLIENT_ID)
  jetonSalle = (claim.body.json as unknown as { token: string }).token
})

afterEach(async () => {
  await hub.close()
})

describe('échange du jeton de salle', () => {
  it('délivre un jeton distinct de la session d\'approbation', () => {
    expect(jetonSalle).toMatch(/^rt_/)
    expect(jetonSalle).not.toBe(jetonOperateur)
  })

  it('exige une session d\'opérateur et l\'identifiant de la machine', async () => {
    expect((await rpc('devices/claim', {}, undefined, CLIENT_ID)).status).toBe(401)
    expect((await rpc('devices/claim', {}, jetonOperateur)).status).toBe(400)
  })

  it('refuse une machine non appairée', async () => {
    const resultat = await rpc('devices/claim', {}, jetonOperateur, '01ZZZZZZZZZZZZZZZZZZZZZZZZ')
    expect(resultat.status).toBe(403)
  })
})

describe('ce que peut une salle', () => {
  const enSalle = (chemin: string, entree: unknown) => rpc(chemin, entree, jetonSalle)

  it('synchronise son programme', async () => {
    const resultat = await enSalle('rooms/sync', { since: null })
    expect(resultat.status).toBe(200)
    expect((resultat.body.json as unknown as { room: { id: string } }).room.id).toBe(TRACK_1)
  })

  it('remonte ses événements', async () => {
    const resultat = await enSalle('ingest/push', {
      batch: [
        {
          id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
          roomId: TRACK_1,
          seq: 1,
          occurredAt: '2026-10-30T09:00:00.000+00:00',
          monotonicMs: 1,
          delivery: 'required',
          payload: { type: 'incident', level: 'warn', message: 'test' },
        },
      ],
    })
    expect(resultat.status).toBe(200)
  })

  it('consulte l\'état des autres salles', async () => {
    // La régie affiche ce panneau : lecture seule, et légitime.
    const resultat = await enSalle('rooms/statuses', {})
    expect(resultat.status).toBe(200)
    expect((resultat.body.json as unknown as unknown[]).length).toBe(3)
  })

  it('pilote le cycle de vie de ses propres conférences', async () => {
    const session = hub.services.programs
      .active()!
      .program.sessions.find((s) => s.roomId === TRACK_1)!

    const demarre = await enSalle('sessions/start', { sessionId: session.id })
    expect(demarre.status).toBe(200)
    // La décision est tracée au nom de la salle, pas d'un opérateur.
    expect(hub.services.sessions.get(session.id)?.decidedBy).toBe(`salle:${TRACK_1}`)
  })
})

describe('ce que ne peut pas une salle', () => {
  const enSalle = (chemin: string, entree: unknown) => rpc(chemin, entree, jetonSalle)

  it('n\'importe pas de programme', async () => {
    const resultat = await enSalle('program/import', { sourceUrl: 'https://exemple/x.json' })
    expect(resultat.status).toBe(403)
  })

  it('ne modère pas le mur', async () => {
    expect((await enSalle('wall/pending', {})).status).toBe(403)
    expect((await enSalle('wall/moderate', { id: 'x', decision: 'approve' })).status).toBe(403)
  })

  it('n\'appaire ni ne révoque de machine', async () => {
    expect((await enSalle('devices/pending', {})).status).toBe(403)
    expect((await enSalle('devices/revoke', { clientId: CLIENT_ID })).status).toBe(403)
  })

  it('ne modifie pas les réglages du hub', async () => {
    expect((await enSalle('settings/update', { autoEndGraceMinutes: 60 })).status).toBe(403)
  })

  it('ne décide pas pour une autre salle', async () => {
    const session = hub.services.programs
      .active()!
      .program.sessions.find((s) => s.roomId === TRACK_2)!

    const resultat = await enSalle('sessions/start', { sessionId: session.id })
    expect(resultat.status).toBe(403)
  })

  it('ne voit que ses propres états de conférence', async () => {
    const sienne = hub.services.programs.active()!.program.sessions.find((s) => s.roomId === TRACK_1)!
    const autre = hub.services.programs.active()!.program.sessions.find((s) => s.roomId === TRACK_2)!
    hub.services.sessions.start(sienne.id, TRACK_1, 'op')
    hub.services.sessions.start(autre.id, TRACK_2, 'op')

    // Même en demandant explicitement l'autre salle.
    const resultat = await enSalle('sessions/states', { roomId: TRACK_2 })
    const etats = resultat.body.json as unknown as { sessionId: string }[]
    expect(etats.map((e) => e.sessionId)).toEqual([sienne.id])
  })
})

describe('révocation', () => {
  it('coupe immédiatement le jeton de la machine', async () => {
    expect((await rpc('rooms/sync', { since: null }, jetonSalle)).status).toBe(200)

    hub.services.devices.revoke(CLIENT_ID)

    const apres = await rpc('rooms/sync', { since: null }, jetonSalle)
    expect(apres.status).toBe(401)
  })

  it('n\'accepte pas un jeton inventé', async () => {
    expect((await rpc('rooms/sync', { since: null }, 'rt_inventé')).status).toBe(401)
  })

  it('ne stocke pas le jeton en clair', () => {
    // Une fuite de la base ne doit pas rendre les salles usurpables.
    const machines = hub.services.devices.list()
    expect(machines[0]?.tokenHash).not.toBe(jetonSalle)
    expect(machines[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
