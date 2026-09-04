import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '@cloudnord/hub-server/server'
import { provisionOperator } from '@cloudnord/hub-server/operators'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract } from '@cloudnord/contract'
import { RoomApp } from '../src/core/room-app.js'
import { createMockObsTransport } from '../src/core/obs-mock.js'

/**
 * The whole chain, from the footage on disk to the object at the storage.
 *
 * This is the only test that proves it works. The others each hold their own end
 * — the signature, the registry, the regulator, the slicing — and all of them can
 * be green while the file arrives corrupt at the other end, because the only
 * place the bytes are put back together is at S3.
 *
 * Here there is a real hub, a real room, a real simulated OBS writing a real
 * file, and a fake S3 that recomposes the object the way the real one does. What
 * is checked at the end is the only thing that matters on the event's evening:
 * that what arrived over there is **byte for byte** what was recorded here.
 */

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'control@cloudnord.fr', name: 'Régie', password: 'motdepasse-control-2026' }
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const TRACK_1 = 'track-1-teilhard-de-chardin'
/** 10:20 UTC: "HoneySwamp" runs from 10:00 to 10:50. */
const PENDANT_LE_TALK = Date.parse('2026-10-30T10:20:00.000Z')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A pocket S3: multipart, parts, completion, abort, listing.
 *
 * It does not verify signatures — that is `s3.test.ts`'s job, on AWS's official
 * vectors. It does the one thing this test needs done for real: glue the parts
 * back together **in part-number order**, and return the complete object.
 */
function fakeStorage(tls: { key: string; cert: string } | null = null) {
  // `FastifyInstance` spelled out: serving over HTTPS changes the underlying
  // server's type, and the rest of this fake storage has no reason to know two
  // variants of it.
  const app: FastifyInstance =
    tls == null
      ? Fastify({ logger: false })
      : (Fastify({ logger: false, https: tls } as never) as unknown as FastifyInstance)
  const multiparts = new Map<string, Map<number, Buffer>>()
  const objects = new Map<string, Buffer>()
  const aborted: string[] = []
  let counter = 0

  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

  app.route({
    method: ['GET', 'PUT', 'POST', 'DELETE'],
    url: '/*',
    handler: (request, reply) => {
      // `/bucket/key...` — path-style addressing, the one the hub uses.
      const path = decodeURIComponent(request.url.split('?')[0] ?? '')
      const key = path.replace(/^\/[^/]+\/?/, '')
      const query = new URL(request.url, 'http://s3.local').searchParams
      const body = request.body as Buffer | undefined

      if (request.method === 'POST' && query.has('uploads')) {
        counter += 1
        const uploadId = `mp-${counter}`
        multiparts.set(uploadId, new Map())
        return reply
          .type('application/xml')
          .send(`<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`)
      }

      if (request.method === 'PUT' && query.has('uploadId')) {
        const parts = multiparts.get(query.get('uploadId') ?? '')
        if (parts == null) return reply.status(404).send('<Error><Code>NoSuchUpload</Code></Error>')
        const partNumber = Number(query.get('partNumber'))
        parts.set(partNumber, body ?? Buffer.alloc(0))
        // The ETag is what the hub will keep and ask for again at completion.
        return reply.header('etag', `"part-${partNumber}"`).send('')
      }

      if (request.method === 'PUT') {
        objects.set(key, body ?? Buffer.alloc(0))
        return reply.header('etag', '"objet"').send('')
      }

      if (request.method === 'POST' && query.has('uploadId')) {
        const uploadId = query.get('uploadId') ?? ''
        const parts = multiparts.get(uploadId)
        if (parts == null) return reply.status(404).send('<Error><Code>NoSuchUpload</Code></Error>')
        // Glued back in **part-number** order, not arrival order: that is what the
        // real one does, and it is what makes a replayed part harmless.
        const order = [...parts.keys()].sort((a, b) => a - b)
        objects.set(key, Buffer.concat(order.map((n) => parts.get(n) as Buffer)))
        multiparts.delete(uploadId)
        return reply.type('application/xml').send('<CompleteMultipartUploadResult/>')
      }

      if (request.method === 'DELETE' && query.has('uploadId')) {
        const uploadId = query.get('uploadId') ?? ''
        aborted.push(uploadId)
        multiparts.delete(uploadId)
        return reply.status(204).send('')
      }

      if (request.method === 'GET' && query.has('uploads')) {
        const open = [...multiparts.keys()]
          .map((id) => `<Upload><Key>x</Key><UploadId>${id}</UploadId></Upload>`)
          .join('')
        return reply
          .type('application/xml')
          .send(`<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>${open}</ListMultipartUploadsResult>`)
      }

      return reply.status(400).send('<Error><Code>InvalidRequest</Code></Error>')
    },
  })

  return { app, objects, aborted, multiparts }
}

/**
 * A certificate authority made for the occasion, and a server certificate signed
 * by it.
 *
 * This is an internal storage's case: Node has no reason to trust that CA — it is
 * in no store, and Node does not even use the system's. Without the PEM, the
 * connection fails on `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.
 */
function makeCa(folder: string): { caPem: string; key: string; cert: string } {
  const ca = join(folder, 'ca.pem')
  const caKey = join(folder, 'ca.key')
  const srvKey = join(folder, 'srv.key')
  const srvCsr = join(folder, 'srv.csr')
  const srvPem = join(folder, 'srv.pem')
  const ext = join(folder, 'ext.cnf')
  const run = (command: string): void => {
    execSync(command, { stdio: 'ignore' })
  }
  run(`openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes -keyout ${caKey} -out ${ca} -subj "/CN=CA interne de test" -addext "basicConstraints=critical,CA:TRUE"`)
  run(`openssl req -newkey rsa:2048 -nodes -keyout ${srvKey} -out ${srvCsr} -subj "/CN=localhost"`)
  writeFileSync(ext, 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n')
  run(`openssl x509 -req -in ${srvCsr} -CA ${ca} -CAkey ${caKey} -CAcreateserial -out ${srvPem} -days 1 -sha256 -extfile ${ext}`)
  return {
    caPem: ca,
    key: readFileSync(srvKey, 'utf8'),
    cert: readFileSync(srvPem, 'utf8'),
  }
}

let hub: Hub
let storage: ReturnType<typeof fakeStorage>
let storageApp: FastifyInstance
let origin: string
let dir: string
let room: RoomApp
let control: string

const act = async (payload: unknown) => {
  const response = await fetch(`${control}/control/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return (await response.json()) as { ok: boolean; message?: string }
}

const uploads = async () =>
  (await (await fetch(`${control}/control/uploads`)).json()) as {
    ok: boolean
    entries: { file: string; state: string; percent: number }[]
    verdict: { allowed: boolean; text: string }
  }

/** Waits for a condition to hold, or gives up: the assertions will speak. */
async function until(condition: () => boolean | Promise<boolean>, limitMs = 15_000): Promise<void> {
  const deadline = Date.now() + limitMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await sleep(100)
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-vod-'))

  storage = fakeStorage()
  storageApp = storage.app
  await storageApp.listen({ port: 0, host: '127.0.0.1' })
  const s3Address = storageApp.server.address()
  const s3Port = typeof s3Address === 'object' && s3Address != null ? s3Address.port : 0

  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
    devicePollInterval: '1s',
    mode: 'dev',
    simulatedTime: new Date(PENDANT_LE_TALK).toISOString(),
    s3Endpoint: `http://127.0.0.1:${s3Port}`,
    s3AccessKeyId: 'key-de-test',
    s3SecretAccessKey: 'secret-de-test',
  })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`

  await provisionOperator(hub.auth, OPERATOR)
  const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.ensureFromTracks(snapshot.program.rooms)

  // The bucket is set from the console: without it, the hub has the keys and no
  // destination — and that is exactly what it answers.
  hub.services.settings.update({
    vodBucket: 'rushes',
    vodPrefix: 'cn26',
    // Five megabytes is S3's minimum; the simulated footage is tiny, so it will
    // leave in a single send. The slicing itself is covered elsewhere.
    vodPolitique: { taillePartMo: 5 },
  })

  let token: string | null = null
  room = new RoomApp({
    dataDir: dir,
    hubOrigin: origin,
    clientId: CLIENT_ID,
    roomId: TRACK_1,
    displayPort: 0,
    obsTransportFactory: (instance) =>
      createMockObsTransport({ instance, recordingDir: join(dir, 'rec') }),
    readToken: () => token,
    writeToken: (value) => {
      token = value
    },
    onPairingCode: (code) => {
      void (async () => {
        const response = await fetch(`${origin}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
        })
        const session = (await response.json()) as { token: string }
        const admin: ContractRouterClient<typeof contract> = createORPCClient(
          new RPCLink({ origin, url: '/rpc', headers: () => ({ authorization: `Bearer ${session.token}` }) }),
        )
        await admin.devices.approve({ userCode: code.user_code, clientId: CLIENT_ID, roomId: TRACK_1 })
      })()
    },
  })

  control = await room.startDisplay()
  const paired = await room.ensurePaired()
  await room.connectHub(paired!)
  await room.connectObs()
  room.runtime.refreshSessions()
})

afterEach(async () => {
  await room.close()
  await hub.close().catch(() => {})
  await storageApp.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Records a talk: the OBS mock writes a real file on stop.
 *
 * Then **ages the produced files**, which is necessary now that the writing
 * window is judged on the machine's own clock: footage stopped a moment ago is,
 * rightly, "still being written" for thirty seconds, and the uploader skips its
 * turn on it. These tests are about what happens to **finished** footage; making
 * them wait half a minute would say nothing more.
 *
 * This detour hides nothing: before, they only passed because the hub's corrected
 * clock — two months ahead of the machine's, simulated day oblige — made
 * everything just written look old. That is exactly the defect that showed a
 * running take as footage ready to leave in the VOD modal.
 */
async function recordATalk(): Promise<void> {
  expect((await act({ action: 'recording.start' })).ok).toBe(true)
  await sleep(50)
  expect((await act({ action: 'recording.stop' })).ok).toBe(true)
  // The recordings root is the one OBS-B announces: we give the stop time to
  // return its path, otherwise the footage is not listed yet.
  await sleep(100)
  ageTheRushes(join(dir, 'rec'))
}

/** One hour back on the whole folder: files nothing is writing any more. */
function ageTheRushes(root: string): void {
  const longAgo = new Date(Date.now() - 3_600_000)
  for (const name of readdirSync(root)) {
    utimesSync(join(root, name), longAgo, longAgo)
  }
}

describe('from footage to storage', () => {
  it('uploads footage and sidecar, byte for byte', async () => {
    await recordATalk()

    const listing = await room.listRecordings()
    const rush = listing.entries[0]
    expect(rush).toBeDefined()
    const onDisk = readFileSync(join(listing.root as string, rush!.file))

    expect((await act({ action: 'vod.upload', file: rush!.file })).ok).toBe(true)
    await until(async () => (await uploads()).entries.some((e) => e.state === 'termine'))

    const view = await uploads()
    expect(view.entries.find((e) => e.file === rush!.file)).toMatchObject({
      state: 'termine',
      percent: 100,
    })

    // The key carries the **footage**'s date, the room, and the name OBS produced.
    const key = [...storage.objects.keys()].find((k) => k.endsWith(rush!.file))
    expect(key).toBeDefined()
    expect(key).toContain(`cn26/2026-10-30/${TRACK_1}/`)

    // The only check that matters on the event's evening.
    expect(storage.objects.get(key as string)?.equals(onDisk)).toBe(true)

    // The sidecar follows, under the same key bar the extension: editing finds
    // title, speakers and markers again without going back through the hub.
    const sidecarKey = key?.replace(/\.[^.]+$/, '.json')
    expect(storage.objects.has(sidecarKey as string)).toBe(true)
    const sidecar = JSON.parse(String(storage.objects.get(sidecarKey as string))) as {
      title: string
      videoFile: string
    }
    expect(sidecar.videoFile).toBe(rush!.file)
    expect(sidecar.title).toBeTruthy()
  })

  it('records the upload in the hub\'s registry, room included', async () => {
    await recordATalk()
    const listing = await room.listRecordings()
    await act({ action: 'vod.upload', file: listing.entries[0]!.file })
    await until(async () => (await uploads()).entries.some((e) => e.state === 'termine'))

    // This is what the console shows: without that row, the organiser would not
    // know what has been brought home and what is still missing.
    const registry = hub.services.vod!.uploads(null, () => 'Track #1')
    expect(registry.some((l) => l.roomId === TRACK_1 && l.state === 'termine')).toBe(true)
    expect(registry.some((l) => l.kind === 'sidecar')).toBe(true)
  })

  it('does not upload the same footage twice', async () => {
    await recordATalk()
    const listing = await room.listRecordings()
    await act({ action: 'vod.upload', file: listing.entries[0]!.file })
    await until(async () => (await uploads()).entries.some((e) => e.state === 'termine'))
    const objectsBefore = storage.objects.size

    await act({ action: 'vod.upload', file: null })
    await sleep(300)
    // Paying twice for the transfer of three-gigabyte footage on the event's
    // network is exactly what a "Tout téléverser" clicked twice must not do.
    expect(storage.objects.size).toBe(objectsBefore)
  })

  it('refuses to upload during a recording, and says why', async () => {
    await recordATalk()
    const listing = await room.listRecordings()

    // We start a take again: the disk that would be read is the one OBS is writing.
    await act({ action: 'recording.start' })
    await act({ action: 'vod.upload', file: listing.entries[0]!.file })
    await sleep(300)

    const view = await uploads()
    expect(view.verdict.allowed).toBe(false)
    expect(view.verdict.text).toContain('enregistrement')
    expect(storage.objects.size).toBe(0)

    await act({ action: 'recording.stop' })
  })

  it('obeys the console, which does not have the files', async () => {
    await recordATalk()

    // The request comes down the command stream, like a resynchronisation: a room
    // momentarily cut off would catch up on it when it reconnects.
    const token = await (async () => {
      const response = await fetch(`${origin}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
      })
      return ((await response.json()) as { token: string }).token
    })()
    const admin: ContractRouterClient<typeof contract> = createORPCClient(
      new RPCLink({ origin, url: '/rpc', headers: () => ({ authorization: `Bearer ${token}` }) }),
    )
    expect(await admin.vod.request({ roomId: TRACK_1, file: null })).toEqual({ ok: true })

    await until(async () => (await uploads()).entries.some((e) => e.state === 'termine'))
    expect(storage.objects.size).toBeGreaterThan(0)

    // And the control app reports it: a room that starts saturating its uplink
    // with nobody having asked for it on site would read as an incident.
    const notices = room.runtime.state().notifications.map((n) => n.text)
    expect(notices.some((text) => text.includes('Rapatriement des rushes demandé'))).toBe(true)
  })

  it('exposes no storage key to the room', async () => {
    // Everything the room receives from the hub, flattened: no access key, no
    // secret. A control machine lives in a corridor, switched on all day.
    const raw = JSON.stringify(room.store.settings())
    expect(raw).not.toContain('secret-de-test')
    expect(raw).not.toContain('key-de-test')
    // It only knows that there is a destination, and under which rules.
    expect(room.store.settings().vod?.actif).toBe(true)
  })
})

describe('when the storage gives way', () => {
  it('keeps the storage\'s error rather than marking it done', async () => {
    await recordATalk()
    const listing = await room.listRecordings()

    // The bucket disappears between two talks — rights revoked, quota reached.
    await storageApp.close()

    await act({ action: 'vod.upload', file: listing.entries[0]!.file })
    await until(async () => (await uploads()).entries.some((e) => e.state !== 'en-cours'), 5_000)

    const view = await uploads()
    const entry = view.entries.find((e) => e.file === listing.entries[0]!.file)
    expect(entry?.state).not.toBe('termine')
  })
})

/**
 * An internal storage, behind a home-made certificate authority.
 *
 * The case came up for real, and it is instructive: `UNABLE_TO_GET_ISSUER_
 * CERT_LOCALLY`. Node does not use the system's certificate store, it ships its
 * own list of public CAs — a company CA is not in it.
 *
 * What this test protects is not the line of code that sets `ca`, it is the fact
 * that **the room has nothing to know**: the CA comes down from the hub at sync
 * time. Setting an environment variable on three Electron machines on an event
 * morning is a gesture one forgets on the third, and the omission is only
 * discovered in the evening, when the footage does not leave.
 */
describe('storage behind an internal CA', () => {
  let caDir: string
  let storageTls: ReturnType<typeof fakeStorage>
  let appTls: FastifyInstance
  let hubTls: Hub
  let roomTls: RoomApp
  let controlTls: string
  let dirTls: string

  /** Brings the whole chain up over HTTPS. A null `caCert` = the hub pushes nothing. */
  async function mountAll(withCa: boolean): Promise<void> {
    caDir = mkdtempSync(join(tmpdir(), 'cloudnord-ca-'))
    dirTls = mkdtempSync(join(tmpdir(), 'cloudnord-vodtls-'))
    const ca = makeCa(caDir)

    storageTls = fakeStorage({ key: ca.key, cert: ca.cert })
    appTls = storageTls.app
    await appTls.listen({ port: 0, host: '127.0.0.1' })
    const address = appTls.server.address()
    const port = typeof address === 'object' && address != null ? address.port : 0

    hubTls = await createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: ':memory:',
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
      devicePollInterval: '1s',
      mode: 'dev',
      simulatedTime: new Date(PENDANT_LE_TALK).toISOString(),
      s3Endpoint: `https://localhost:${port}`,
      s3AccessKeyId: 'key-de-test',
      s3SecretAccessKey: 'secret-de-test',
      ...(withCa ? { s3CaCert: ca.caPem } : {}),
    })
    await hubTls.app.listen({ port: 0, host: '127.0.0.1' })
    const hubAddress = hubTls.app.server.address()
    const originHub = `http://127.0.0.1:${typeof hubAddress === 'object' && hubAddress != null ? hubAddress.port : 0}`

    await provisionOperator(hubTls.auth, OPERATOR)
    const snapshot = hubTls.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
    hubTls.services.rooms.ensureFromTracks(snapshot.program.rooms)
    hubTls.services.settings.update({ vodBucket: 'rushes', vodPolitique: { taillePartMo: 5 } })

    let token: string | null = null
    roomTls = new RoomApp({
      dataDir: dirTls,
      hubOrigin: originHub,
      clientId: CLIENT_ID,
      roomId: TRACK_1,
      displayPort: 0,
      obsTransportFactory: (instance) =>
        createMockObsTransport({ instance, recordingDir: join(dirTls, 'rec') }),
      readToken: () => token,
      writeToken: (value) => {
        token = value
      },
      onPairingCode: (code) => {
        void (async () => {
          const response = await fetch(`${originHub}/api/auth/sign-in/email`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
          })
          const session = (await response.json()) as { token: string }
          const admin: ContractRouterClient<typeof contract> = createORPCClient(
            new RPCLink({ origin: originHub, url: '/rpc', headers: () => ({ authorization: `Bearer ${session.token}` }) }),
          )
          await admin.devices.approve({ userCode: code.user_code, clientId: CLIENT_ID, roomId: TRACK_1 })
        })()
      },
    })
    controlTls = await roomTls.startDisplay()
    const got = await roomTls.ensurePaired()
    await roomTls.connectHub(got!)
    await roomTls.connectObs()
    roomTls.runtime.refreshSessions()
  }

  afterEach(async () => {
    await roomTls?.close()
    await hubTls?.close().catch(() => {})
    await appTls?.close().catch(() => {})
    rmSync(caDir, { recursive: true, force: true })
    rmSync(dirTls, { recursive: true, force: true })
  })

  const actTls = async (payload: unknown) => {
    const response = await fetch(`${controlTls}/control/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return (await response.json()) as { ok: boolean; message?: string }
  }

  const uploadsTls = async () =>
    (await (await fetch(`${controlTls}/control/uploads`)).json()) as {
      entries: { file: string; state: string; error: string | null }[]
    }

  async function record(): Promise<string> {
    await actTls({ action: 'recording.start' })
    await sleep(50)
    await actTls({ action: 'recording.stop' })
    await sleep(100)
    // Same reason as above: footage stopped a moment ago stays "still being
    // written" for half a minute, and the uploader skips its turn on it.
    ageTheRushes(join(dirTls, 'rec'))
    const listing = await roomTls.listRecordings()
    return listing.entries[0]!.file
  }

  it('fails clearly when the CA is not known', async () => {
    await mountAll(false)
    const rush = await record()

    await actTls({ action: 'vod.upload', file: rush })
    await until(async () => (await uploadsTls()).entries.some((e) => e.error != null), 8_000)

    const error = (await uploadsTls()).entries.find((e) => e.file === rush)?.error ?? ''
    // The message must name the trust failure, not talk about the network: one
    // does not go looking for a firewall when a certificate is missing.
    expect(error).toMatch(/CERT|SIGNATURE|SELF_SIGNED/)
    expect(storage.objects.size).toBe(0)
  })

  it('uploads without the room having to know anything about the CA', async () => {
    await mountAll(true)
    const rush = await record()

    // The CA came down at sync time, with the rest of the policy. No environment
    // variable was set on this machine.
    expect(roomTls.store.settings().vod?.caCert).toContain('BEGIN CERTIFICATE')

    await actTls({ action: 'vod.upload', file: rush })
    await until(async () => (await uploadsTls()).entries.some((e) => e.state === 'termine'), 15_000)

    const entry = (await uploadsTls()).entries.find((e) => e.file === rush)
    expect(entry?.state).toBe('termine')
    expect(entry?.error).toBeNull()

    const key = [...storageTls.objects.keys()].find((k) => k.endsWith(rush))
    expect(key).toBeDefined()
    // And never the storage's secret key: the room only received an authority
    // certificate, which is public by construction.
    const settingsJson = JSON.stringify(roomTls.store.settings())
    expect(settingsJson).not.toContain('secret-de-test')
  })
})

/**
 * The reset, seen from the room.
 *
 * What these tests protect fits in two sentences. A room that is not in
 * development **refuses** to erase its footage, even on the hub's order: a
 * development room and an event hub can end up plugged into each other — that is
 * precisely the accident the mode badge exists to make visible. And what is
 * erased is limited to what the application knows about: the recordings root is a
 * folder an operator typed into a form, sometimes a shared disk.
 */
describe('resetting the footage', () => {
  /**
   * The same room, seen as a development machine.
   *
   * `mode` is only read at the moment of the gesture: touching it up here avoids
   * bringing up a second full chain — hub, pairing, OBS — to exercise two lines
   * of guard.
   */
  function inDevelopment(): RoomApp {
    ;(room as unknown as { options: { mode: string } }).options.mode = 'dev'
    return room
  }

  async function filesPresent(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises')
    const listing = await room.listRecordings()
    return await readdir(listing.root as string)
  }

  it('refuses to erase when the room is not in development', async () => {
    // The second lock, and the reason it exists: a development room and an event
    // hub can end up plugged into each other — that is precisely the accident the
    // control app's mode badge makes visible. The hub guards its side; the room
    // guards its own, as close to the disk as possible.
    await recordATalk()
    const before = await filesPresent()

    // `room` is brought up with no mode: that is, in production, the default.
    expect(await room.resetVod()).toBe(0)
    expect(await filesPresent()).toEqual(before)
  })

  it('erases the footage, its sidecars and the verdicts — and nothing else', async () => {
    await recordATalk()
    const listing = await room.listRecordings()
    const root = listing.root as string

    // A verdict laid down by hand: it lives in `.controles-vod.json`, at the
    // root, and describes a review that is moot once the footage has gone.
    await act({ action: 'vod.verdict', file: listing.entries[0]!.file, status: 'ok' })
    // And a file the application did not produce: the recordings folder is
    // sometimes shared with something else.
    writeFileSync(join(root, 'notes-de-la-control.txt'), 'à ne pas effacer')

    expect(await inDevelopment().resetVod()).toBeGreaterThan(0)

    const remaining = await filesPresent()
    expect(remaining.filter((name) => name.endsWith('.mkv'))).toEqual([])
    expect(remaining.filter((name) => name.endsWith('.json'))).toEqual([])
    expect(remaining).not.toContain('.controles-vod.json')
    // What the operator dropped there stays: emptying a folder one does not own
    // entirely is not a gesture one can take back.
    expect(remaining).toContain('notes-de-la-control.txt')
  })

  it('forgets the upload queue along the way', async () => {
    await recordATalk()
    const listing = await room.listRecordings()
    await act({ action: 'vod.upload', file: listing.entries[0]!.file })
    await until(async () => (await uploads()).entries.some((e) => e.state === 'termine'))

    await inDevelopment().resetVod()
    // Keeping "terminé" rows pointing at erased files would make the modal say
    // everything is safe.
    expect((await uploads()).entries).toEqual([])
  })
})
