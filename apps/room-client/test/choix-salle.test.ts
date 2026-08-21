import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '@cloudnord/hub-server/server'
import { provisionOperator } from '@cloudnord/hub-server/operators'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract } from '@cloudnord/contract'
import { RoomApp } from '../src/core/room-app.js'
import { createMockObsTransport } from '../src/core/obs-mock.js'
import type { DisplayPayload } from '../src/core/display-server.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_2 = 'track-2-mf-1092'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let hub: Hub
let origin: string
let dir: string
let room: RoomApp
let regie: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-choix-'))
  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
    devicePollInterval: '1s',
  })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`

  await provisionOperator(hub.auth, OPERATOR)
  const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.ensureFromTracks(snapshot.program.rooms)

  let token: string | null = null
  room = new RoomApp({
    dataDir: dir,
    hubOrigin: origin,
    clientId: CLIENT_ID,
    displayPort: 0,
    obsTransportFactory: (instance) =>
      createMockObsTransport({ instance, recordingDir: join(dir, 'rec') }),
    readToken: () => token,
    writeToken: (valeur) => {
      token = valeur
    },
  })
  regie = await room.startDisplay()
})

afterEach(async () => {
  await room.close()
  await hub.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

const agir = async (payload: unknown) => {
  const response = await fetch(`${regie}/control/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as { ok: boolean; message?: string } }
}
const etat = async () => (await (await fetch(`${regie}/display/data`)).json()) as DisplayPayload

/** Approuve la demande en cours, en gardant la salle que la console propose. */
async function approuverEnGardantLaProposition(): Promise<string> {
  const reponse = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  const session = (await reponse.json()) as { token: string }
  const admin: ContractRouterClient<typeof contract> = createORPCClient(
    new RPCLink({ origin, url: '/rpc', headers: () => ({ authorization: `Bearer ${session.token}` }) }),
  )

  const attente = await admin.devices.pending()
  expect(attente).toHaveLength(1)

  // La console lit la salle demandée dans le scope, comme le fait sa page.
  const scope = attente[0]!.scope ?? ''
  const demandee = scope.startsWith('room:') ? scope.slice('room:'.length) : ''
  expect(demandee).toBe(TRACK_2)

  const code = room.pairingState().userCode!
  await admin.devices.approve({ userCode: code, clientId: CLIENT_ID, roomId: demandee })
  return demandee
}

describe("choix de la salle à l'allumage", () => {
  it("propose les salles avant de demander un code", async () => {
    const jeton = await room.ensurePaired()

    // Aucun code tant qu'aucune salle n'est choisie : la console n'aurait
    // aucun moyen de deviner laquelle, et le code serait affiché pour rien.
    expect(jeton).toBeNull()
    const payload = await etat()
    expect(payload.pairing?.userCode).toBeUndefined()
    expect(payload.pairing?.rooms?.map((s) => s.id).sort()).toEqual([
      'hands-on',
      'track-1-teilhard-de-chardin',
      'track-2-mf-1092',
    ])
  }, 40_000)

  it("transmet le choix jusqu'à la console, qui le retrouve pré-sélectionné", async () => {
    void agir({ action: 'pairing.chooseRoom', roomId: TRACK_2 })

    for (let i = 0; i < 40 && room.pairingState().userCode == null; i += 1) await sleep(200)
    expect(room.pairingState().userCode).toBeTruthy()
    expect(room.pairingState().requestedRoomId).toBe(TRACK_2)

    const retenue = await approuverEnGardantLaProposition()
    expect(retenue).toBe(TRACK_2)

    for (let i = 0; i < 60 && room.store.settings().roomId == null; i += 1) await sleep(250)
    expect(room.store.settings().roomId).toBe(TRACK_2)
  }, 60_000)

  it("refuse une salle qui n'existe pas", async () => {
    await room.ensurePaired()
    const resultat = await agir({ action: 'pairing.chooseRoom', roomId: 'salle-inventee' })

    expect(resultat.status).toBe(409)
    expect(resultat.body.message).toContain('Salle inconnue')
  }, 40_000)

  it("expose la liste publique sans le moindre jeton", async () => {
    // Une machine non appairée n'a rien à présenter : sans procédure publique,
    // elle ne pourrait pas proposer de choix.
    const reponse = await fetch(`${origin}/rpc/rooms/public`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: {} }),
    })
    expect(reponse.status).toBe(200)
    const salles = ((await reponse.json()) as { json: { id: string; name: string }[] }).json
    expect(salles).toHaveLength(3)
    // Identifiant et nom seulement : pas de configuration OBS, pas de clé RTMP.
    expect(Object.keys(salles[0]!).sort()).toEqual(['id', 'name'])
  }, 40_000)
})
