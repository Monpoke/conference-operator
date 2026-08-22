import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuth, createAuthOptions, migrateAuth, type Auth } from '../src/auth.js'
import { provisionOperator } from '../src/operators.js'
import { createHub, type Hub } from '../src/server.js'

/**
 * Appairage d'une machine de salle par device authorization grant (RFC 8628).
 *
 * Scénario réel : le PC de régie affiche un code court, un opérateur déjà
 * authentifié dans l'admin l'approuve, la machine récupère un jeton propre et
 * révocable. Aucun mot de passe partagé sur les trois machines.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'

interface Harness {
  auth: Auth
  onDeviceRequest: ReturnType<typeof vi.fn>
  knownClients: Set<string>
}

async function makeHarness(): Promise<Harness> {
  const sqlite = new Database(':memory:')
  const onDeviceRequest = vi.fn()
  const knownClients = new Set([CLIENT_ID])
  const options = createAuthOptions({
    sqlite,
    secret: 'test-secret-'.padEnd(48, 'x'),
    publicUrl: 'http://localhost:8787',
    onDeviceRequest,
    isKnownClient: (clientId) => knownClients.has(clientId),
    // Cadence resserrée : sinon chaque test attendrait 5 s entre deux polls.
    deviceInterval: '1s',
  })
  await migrateAuth(options)
  const auth = createAuth(options)
  await provisionOperator(auth, OPERATOR)
  return { auth, onDeviceRequest, knownClients }
}

/** Ouvre une session opérateur et renvoie les en-têtes à rejouer. */
async function signInOperator(auth: Auth): Promise<Headers> {
  const response = await auth.api.signInEmail({
    body: { email: OPERATOR.email, password: OPERATOR.password },
    returnHeaders: true,
  })
  const token = response.response.token
  const headers = new Headers()
  headers.set('authorization', `Bearer ${token}`)
  return headers
}

let harness: Harness
beforeEach(async () => {
  harness = await makeHarness()
})

describe('appairage d\'une machine de salle', () => {
  it('déroule le flux complet : code → approbation → jeton', async () => {
    const { auth, onDeviceRequest } = harness

    // 1. La machine demande un code au démarrage.
    const request = await auth.api.deviceCode({ body: { client_id: CLIENT_ID } })
    expect(request.device_code).toBeTruthy()
    expect(request.user_code).toBeTruthy()
    expect(request.interval).toBeGreaterThan(0)

    // Le hub sait qu'une machine attend : sans ça, l'admin verrait un code
    // sans savoir quelle machine le demande.
    expect(onDeviceRequest).toHaveBeenCalledWith(CLIENT_ID, undefined)

    // 2. Tant que personne n'a approuvé, le polling reste en attente.
    await expect(
      auth.api.deviceToken({
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: request.device_code,
          client_id: CLIENT_ID,
        },
      }),
    ).rejects.toMatchObject({ body: { error: 'authorization_pending' } })

    // 3. L'opérateur saisit le code dans l'admin, puis approuve.
    const headers = await signInOperator(auth)
    await auth.api.deviceVerify({ query: { user_code: request.user_code }, headers })
    await auth.api.deviceApprove({ body: { userCode: request.user_code }, headers })

    // 4. Le polling suivant délivre le jeton — après avoir respecté l'intervalle.
    await sleep(1_100)
    const granted = await auth.api.deviceToken({
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: request.device_code,
        client_id: CLIENT_ID,
      },
    })
    expect(granted).toMatchObject({ token_type: 'Bearer' })
    expect(granted.access_token).toBeTruthy()

    // 5. Ce jeton ouvre bien une session utilisable pour les appels oRPC.
    const deviceHeaders = new Headers({ authorization: `Bearer ${granted.access_token}` })
    const session = await auth.api.getSession({ headers: deviceHeaders })
    expect(session?.user.email).toBe(OPERATOR.email)
  })

  it('refuse un `client_id` inconnu', async () => {
    await expect(
      harness.auth.api.deviceCode({ body: { client_id: 'machine-non-declaree' } }),
    ).rejects.toBeDefined()
  })

  it('refuse d\'approuver sans session opérateur', async () => {
    const request = await harness.auth.api.deviceCode({ body: { client_id: CLIENT_ID } })
    await expect(
      harness.auth.api.deviceApprove({ body: { userCode: request.user_code }, headers: new Headers() }),
    ).rejects.toBeDefined()
  })

  it('n\'accorde aucun jeton après un refus explicite', async () => {
    const { auth } = harness
    const request = await auth.api.deviceCode({ body: { client_id: CLIENT_ID } })
    const headers = await signInOperator(auth)

    await auth.api.deviceVerify({ query: { user_code: request.user_code }, headers })
    await auth.api.deviceDeny({ body: { userCode: request.user_code }, headers })

    await sleep(1_100)
    await expect(
      auth.api.deviceToken({
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: request.device_code,
          client_id: CLIENT_ID,
        },
      }),
    ).rejects.toMatchObject({ body: { error: 'access_denied' } })
  })

  it('ne délivre pas deux fois un jeton pour le même code', async () => {
    const { auth } = harness
    const request = await auth.api.deviceCode({ body: { client_id: CLIENT_ID } })
    const headers = await signInOperator(auth)
    await auth.api.deviceVerify({ query: { user_code: request.user_code }, headers })
    await auth.api.deviceApprove({ body: { userCode: request.user_code }, headers })

    const body = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code' as const,
      device_code: request.device_code,
      client_id: CLIENT_ID,
    }
    await sleep(1_100)
    await auth.api.deviceToken({ body })
    // Un code volé et rejoué ne doit pas ouvrir une seconde session.
    await sleep(1_100)
    await expect(auth.api.deviceToken({ body })).rejects.toBeDefined()
  })

  it('impose la cadence de polling (RFC 8628 §3.5)', async () => {
    const { auth } = harness
    const request = await auth.api.deviceCode({ body: { client_id: CLIENT_ID } })
    const body = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code' as const,
      device_code: request.device_code,
      client_id: CLIENT_ID,
    }

    await expect(auth.api.deviceToken({ body })).rejects.toMatchObject({
      body: { error: 'authorization_pending' },
    })
    // Repoller immédiatement est puni : le client de salle doit respecter
    // `interval` et ralentir encore sur `slow_down`, sinon il s'auto-bloque
    // au démarrage — juste au moment où l'opérateur attend devant l'écran.
    await expect(auth.api.deviceToken({ body })).rejects.toMatchObject({
      body: { error: 'slow_down' },
    })
  })
})

/**
 * Consultation d'un code depuis la console.
 *
 * L'opérateur arrive par le lien que la régie affiche. Ce qu'il voit à côté —
 * la file des machines en attente — ne dit rien de *son* code : il faut le
 * qualifier avant qu'il ne cherche une machine qui n'y est pas.
 */
describe('consultation d\'un code d\'appairage', () => {
  const TRACK_1 = 'track-1-teilhard-de-chardin'
  let hub: Hub
  let origin: string
  let jetonOperateur: string

  async function rpc(chemin: string, entree: unknown) {
    const response = await fetch(`${origin}/rpc/${chemin}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jetonOperateur}` },
      body: JSON.stringify({ json: entree }),
    })
    return (await response.json()) as { json: Record<string, unknown> }
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
    hub.services.rooms.upsert({
      id: TRACK_1,
      name: 'Teilhard de Chardin',
      trackId: TRACK_1,
      obs: {
        A: { url: 'ws://127.0.0.1:4455', password: null },
        B: { url: 'ws://127.0.0.1:4456', password: null },
      },
      sceneRoles: { A: { LIVE: 'Capture' }, B: {} },
      displayPort: 7788,
      recordingRoot: null,
    })

    await provisionOperator(hub.auth, OPERATOR)
    const connexion = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
    })
    jetonOperateur = ((await connexion.json()) as { token: string }).token
  })

  afterEach(async () => {
    await hub.close()
  })

  it('reconnaît un code en attente et rend la salle demandée', async () => {
    const demande = await hub.auth.api.deviceCode({
      body: { client_id: CLIENT_ID, scope: `room:${TRACK_1}` },
    })

    const { json } = await rpc('devices/lookup', { userCode: demande.user_code })

    expect(json).toMatchObject({
      status: 'pending',
      reason: null,
      clientId: CLIENT_ID,
      requestedRoomId: TRACK_1,
      requestedRoomName: 'Teilhard de Chardin',
    })
  })

  it('distingue un code inconnu d\'une panne', async () => {
    // Une erreur générique ferait chercher du côté du hub ; c'est presque
    // toujours une faute de frappe, ou une base recréée depuis l'affichage.
    const { json } = await rpc('devices/lookup', { userCode: 'ZZZZ-ZZZZ' })

    expect(json).toMatchObject({ status: null, reason: 'inconnu', clientId: null })
  })

  it('explique le refus quand un autre opérateur a ouvert le code', async () => {
    const demande = await hub.auth.api.deviceCode({
      body: { client_id: CLIENT_ID, scope: `room:${TRACK_1}` },
    })
    // Un premier opérateur suit le lien de la machine : la consultation
    // rattache le code à sa session, côté Better Auth.
    await rpc('devices/lookup', { userCode: demande.user_code })

    await provisionOperator(hub.auth, { ...OPERATOR, email: 'second@cloudnord.fr' })
    const connexion = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'second@cloudnord.fr', password: OPERATOR.password }),
    })
    jetonOperateur = ((await connexion.json()) as { token: string }).token

    const { json } = await rpc('devices/approve', {
      userCode: demande.user_code,
      clientId: CLIENT_ID,
      roomId: TRACK_1,
    })

    // Le message anglais du plugin n'aide personne au fond d'une salle.
    expect(String((json as { message?: string }).message)).toContain('autre opérateur')
    expect(hub.services.devices.roomFor(CLIENT_ID)).toBeNull()
  })

  it('sort la machine de la file quand on la refuse', async () => {
    const demande = await hub.auth.api.deviceCode({
      body: { client_id: CLIENT_ID, scope: `room:${TRACK_1}` },
    })
    expect(hub.services.devices.pending()).toHaveLength(1)

    await rpc('devices/deny', { userCode: demande.user_code })

    // Sans ça, refuser n'avait aucun effet visible : la demande restait
    // affichée jusqu'à ce que quelqu'un l'appaire, et on la refusait deux fois.
    expect(hub.services.devices.pending()).toEqual([])
  })
})
