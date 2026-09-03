import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { RoomService } from '../src/services/rooms.js'
import { SettingsService } from '../src/services/sessions.js'
import { VodService, IncompleteStorage, s3Keys } from '../src/services/vod.js'
import type { S3Transport } from '../src/services/s3.js'
import { configSchema } from '../src/config.js'
import { createHub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The upload registry, and its housekeeping.
 *
 * What we hold here: that an interrupted rush **resumes** instead of starting
 * over, and that a multipart silently abandoned ends up being closed. Both are
 * paid for in the same place, at the end of the event — the first in network
 * hours redoing a three-gigabyte file already nine tenths uploaded, the second on
 * a storage bill nobody will read for months, for bytes nothing claims any more.
 *
 * No real S3 here: `fetch` is simulated. What matters is what the hub decides,
 * not what the storage answers — that is `s3.test.ts` and the room's end-to-end
 * test.
 *
 * `etapes`, `nom`, `taillePartOctets`, `recues`, `numero`, `octets`, `dureeMs`,
 * `objets`, `multiparts` and the step names are contract fields and values: they
 * do not get renamed.
 */

const TRACK_1 = 'track-1-teilhard-de-chardin'

let db: HubDatabase
let settings: SettingsService
/** An on-disk database: the seeding only proves itself across two starts. */
let directory: string
let databasePath: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cloudnord-vod-'))
  databasePath = join(directory, 'hub.db')
  db = openHubDatabase(':memory:').orm
  settings = new SettingsService(db)
  const rooms = new RoomService(db)
  rooms.upsert({
    id: TRACK_1,
    name: 'Track #1',
    trackId: TRACK_1,
    obs: {
      A: { url: 'ws://127.0.0.1:4455', password: null },
      B: { url: 'ws://127.0.0.1:4456', password: null },
    },
    sceneRoles: { A: {}, B: {} },
    displayPort: 7788,
    recordingRoot: null,
  })
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const KEYS = {
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: 'cle',
  secretAccessKey: 'secret',
  forcePathStyle: true,
}

/** A storage that always says yes, and remembers what it was asked. */
function fakeS3(): { transport: S3Transport; calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = []
  let number = 0
  const impl: S3Transport = async (url, options) => {
    calls.push({ url, method: options.method })
    if (url.includes('uploads=') && options.method === 'POST') {
      number += 1
      return {
        status: 200,
        body: `<InitiateMultipartUploadResult><UploadId>u${number}</UploadId></InitiateMultipartUploadResult>`,
      }
    }
    if (url.includes('uploads=')) {
      return { status: 200, body: '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>' }
    }
    return { status: 200, body: '<Ok/>' }
  }
  return { transport: impl, calls }
}

function service(transport: S3Transport, minutes = 30, now = () => new Date().toISOString()): VodService {
  return new VodService(db, settings, KEYS, minutes, now, () => {}, transport)
}

const A_RUSH = {
  roomId: TRACK_1,
  file: '2026-10-30_track1_1100_honeyswamp.mkv',
  sizeBytes: 40 * 1024 * 1024,
  kind: 'rush' as const,
  sessionId: 'sess-1',
}

describe('configuration', () => {
  it('has no keys until all three variables are there', () => {
    const base = { authSecret: 'x'.repeat(40) }
    expect(s3Keys(configSchema.parse(base))).toBeNull()
    expect(
      s3Keys(
        configSchema.parse({
          ...base,
          s3Endpoint: 'http://localhost:9000',
          s3AccessKeyId: 'cle',
          s3SecretAccessKey: 'secret',
        }),
      ),
    ).not.toBeNull()
  })

  it('refuses to start on a half-configured storage', () => {
    // Three out of four would raise a hub where the console announces a ready
    // storage and where every upload fails at the signature: one would look for
    // the failure in the bucket's rights, not in a `.env` short of a line.
    expect(() =>
      configSchema.parse({
        authSecret: 'x'.repeat(40),
        s3Endpoint: 'http://localhost:9000',
        s3AccessKeyId: 'cle',
      }),
    ).toThrow()
  })

  it('seeds the bucket from the environment, once only', async () => {
    // The case of a hub provisioned in advance, where nobody will open the
    // console before the event: with no seeding, it would start with its keys and
    // no destination.
    const first = await createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath,
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
      s3Endpoint: 'http://localhost:9000',
      s3AccessKeyId: 'cle',
      s3SecretAccessKey: 'secret',
      s3Bucket: 'rushes-amorce',
    })
    expect(first.services.settings.get().vodBucket).toBe('rushes-amorce')
    // And the hub announces itself ready on the first go: seeding later would have
    // made it say "no bucket set" on an otherwise complete installation.
    expect(first.services.vod?.ready()).toBe(true)

    // The console corrects it — we were aiming at last year's bucket.
    first.services.settings.update({ vodBucket: 'rushes-2027' })
    await first.close()

    const second = await createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath,
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
      s3Endpoint: 'http://localhost:9000',
      s3AccessKeyId: 'cle',
      s3SecretAccessKey: 'secret',
      s3Bucket: 'rushes-amorce',
    })
    // A restart does not overwrite again: a correction made during an event must
    // survive it, and it is precisely on that day that the hub gets restarted.
    expect(second.services.settings.get().vodBucket).toBe('rushes-2027')
    await second.close()
  })

  it('has keys but is not ready while no bucket is set', () => {
    const vod = service(fakeS3().transport)
    expect(vod.ready()).toBe(false)
    // It is the most confusing of the three states: the keys are there, the
    // console shows the panel, and nothing leaves. The message must say where to
    // go.
    expect(() => vod.parts(TRACK_1, 'inconnu', [1])).toThrow(IncompleteStorage)

    settings.update({ vodBucket: 'rushes' })
    expect(vod.ready()).toBe(true)
  })
})

describe('opening and resuming', () => {
  beforeEach(() => {
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
  })

  it('files under the file\'s date, not under the shipping date', async () => {
    const vod = service(fakeS3().transport, 30, () => '2026-11-05T09:00:00.000Z')
    // The rush is from 30 October; we ship it back on 5 November. Filing it under
    // the transfer date would make it unfindable for whoever looks for the day.
    expect(vod.objectKeyFor(TRACK_1, A_RUSH.file)).toBe(
      `cn26/2026-10-30/${TRACK_1}/2026-10-30_track1_1100_honeyswamp.mkv`,
    )
    // A name with no date — what OBS produces when the room has never
    // synchronized — falls back on the hub's time rather than on nothing.
    expect(vod.objectKeyFor(TRACK_1, 'rush-sans-date.mkv')).toBe(
      `cn26/2026-11-05/${TRACK_1}/rush-sans-date.mkv`,
    )
  })

  it('splits a rush into parts and a sidecar into a single send', async () => {
    const vod = service(fakeS3().transport)
    settings.update({ vodPolitique: { taillePartMo: 8 } })

    const plan = await vod.begin(A_RUSH)
    expect(plan.mode).toBe('multipart')
    if (plan.mode !== 'multipart') throw new Error('unexpected')
    expect(plan.taillePartOctets).toBe(8 * 1024 * 1024)
    expect(plan.parts).toBe(5)
    expect(plan.recues).toEqual([])

    // The sidecar weighs a few kilobytes: opening a multipart for it would cost
    // three requests where one is enough.
    const sidecar = await vod.begin({
      ...A_RUSH,
      file: '2026-10-30_track1_1100_honeyswamp.json',
      sizeBytes: 900,
      kind: 'sidecar',
    })
    expect(sidecar.mode).toBe('direct')
  })

  it('resumes where the room stopped, without reopening a multipart', async () => {
    const fake = fakeS3()
    const vod = service(fake.transport)

    const plan = await vod.begin(A_RUSH)
    if (plan.mode !== 'multipart') throw new Error('unexpected')
    vod.progress({ roomId: TRACK_1, uploadId: plan.uploadId, numero: 1, etag: '"a"', octets: 8_388_608, dureeMs: 2000 })
    vod.progress({ roomId: TRACK_1, uploadId: plan.uploadId, numero: 2, etag: '"b"', octets: 8_388_608, dureeMs: 2000 })

    const openings = fake.calls.filter((c) => c.method === 'POST' && c.url.includes('uploads=')).length

    // The machine restarts: it asks for its plan again.
    const resumed = await vod.begin(A_RUSH)
    if (resumed.mode !== 'multipart') throw new Error('unexpected')
    expect(resumed.uploadId).toBe(plan.uploadId)
    expect(resumed.recues).toEqual([1, 2])
    // And above all: no second multipart. Reopening one would abandon sixteen
    // megabytes already at the storage, and on a three-gigabyte rush a machine
    // that restarts twice would never finish.
    expect(fake.calls.filter((c) => c.method === 'POST' && c.url.includes('uploads=')).length).toBe(
      openings,
    )
  })

  it('starts over when the file has changed size under the same name', async () => {
    const vod = service(fakeS3().transport)
    const plan = await vod.begin(A_RUSH)
    if (plan.mode !== 'multipart') throw new Error('unexpected')
    vod.progress({ roomId: TRACK_1, uploadId: plan.uploadId, numero: 1, etag: '"a"', octets: 1000, dureeMs: 10 })

    // It is no longer the same rush: resuming would glue the end of one file onto
    // the start of another, and the result would open without the defect showing.
    const other = await vod.begin({ ...A_RUSH, sizeBytes: A_RUSH.sizeBytes + 4096 })
    if (other.mode !== 'multipart') throw new Error('unexpected')
    expect(other.recues).toEqual([])
  })

  it('does not count a replayed part twice', async () => {
    const vod = service(fakeS3().transport)
    const plan = await vod.begin(A_RUSH)
    if (plan.mode !== 'multipart') throw new Error('unexpected')

    const part = { roomId: TRACK_1, uploadId: plan.uploadId, numero: 1, octets: 8_388_608, dureeMs: 1000 }
    vod.progress({ ...part, etag: '"raté"' })
    vod.progress({ ...part, etag: '"bon"' })

    const [row] = vod.uploads(TRACK_1, () => 'Track #1')
    // Adding up would exceed the file size, and the console would show 112 %.
    expect(row?.bytesSent).toBe(8 * 1024 * 1024)
    // And it is the last ETag that counts: the storage would refuse the old one.
    await vod.complete(TRACK_1, plan.uploadId)
  })

  it('bounds a room to its own uploads', async () => {
    const vod = service(fakeS3().transport)
    const plan = await vod.begin(A_RUSH)
    // The `roomId` comes from the token: a room that guessed a neighbouring
    // upload's identifier must be able to do nothing with it.
    expect(() => vod.parts('autre-salle', plan.uploadId, [1])).toThrow(IncompleteStorage)
  })
})

describe('housekeeping', () => {
  beforeEach(() => {
    settings.update({ vodBucket: 'rushes' })
  })

  it('abandons what no longer progresses, and closes the multipart at the storage', async () => {
    const fake = fakeS3()
    const old = new Date(Date.now() - 90 * 60_000).toISOString()
    // Opened an hour and a half ago, then nothing: the room was switched off
    // mid-upload, and it will never say that it gives up.
    const vod = service(fake.transport, 30, () => old)
    await vod.begin(A_RUSH)

    const running = service(fake.transport, 30)
    expect(await running.housekeepingPass()).toBe(1)
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(true)

    const [row] = running.uploads(TRACK_1, () => null)
    // `abandonne` is a contract value.
    expect(row?.state).toBe('abandonne')
    expect(row?.lastError).toContain('30 min')
  })

  it('leaves alone what is still progressing', async () => {
    const fake = fakeS3()
    const vod = service(fake.transport, 30)
    await vod.begin(A_RUSH)
    expect(await vod.housekeepingPass()).toBe(0)
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('closes the multiparts orphaned by a recreated database, but not the recent ones', async () => {
    const old = new Date(Date.now() - 48 * 3600_000).toISOString()
    const recent = new Date(Date.now() - 3600_000).toISOString()
    const deleted: string[] = []
    const impl: S3Transport = async (url, options) => {
      if (options.method === 'DELETE') deleted.push(url)
      if (options.method === 'GET') {
        return {
          status: 200,
          body:
            '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>' +
            `<Upload><Key>a.mkv</Key><UploadId>orphelin</UploadId><Initiated>${old}</Initiated></Upload>` +
            `<Upload><Key>b.mkv</Key><UploadId>recent</UploadId><Initiated>${recent}</Initiated></Upload>` +
            '<Upload><Key>c.mkv</Key><UploadId>sans-date</UploadId></Upload>' +
            '</ListMultipartUploadsResult>',
        }
      }
      return { status: 200, body: '<Ok/>' }
    }
    const vod = service(impl)

    expect(await vod.sweepOrphans()).toBe(1)
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toContain('uploadId=orphelin')
    // `recent` may be being fed by a room; `sans-date` says nothing about its age.
    // In both cases, leaving it lying around costs less than cutting a rush that
    // is going up.
  })

  it('does not touch the multiparts the registry still knows about', async () => {
    const fake = fakeS3()
    const vod = service(fake.transport)
    const plan = await vod.begin(A_RUSH)
    if (plan.mode !== 'multipart') throw new Error('unexpected')

    const old = new Date(Date.now() - 48 * 3600_000).toISOString()
    const impl: S3Transport = async (_url, options) => {
      if (options.method === 'GET') {
        return {
          status: 200,
          body:
            '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>' +
            `<Upload><Key>a.mkv</Key><UploadId>u1</UploadId><Initiated>${old}</Initiated></Upload>` +
            '</ListMultipartUploadsResult>',
        }
      }
      return { status: 200, body: '<Ok/>' }
    }
    const cleanup = service(impl)
    // `u1` is the one the room is feeding: closing it from under it is exactly
    // what the inventory must never do.
    expect(await cleanup.sweepOrphans()).toBe(0)
  })

  it('does nothing while no bucket is set', async () => {
    settings.update({ vodBucket: null })
    const fake = fakeS3()
    const vod = service(fake.transport)
    expect(await vod.housekeepingPass()).toBe(0)
    expect(await vod.sweepOrphans()).toBe(0)
    expect(fake.calls).toHaveLength(0)
  })
})

/**
 * What the hub says when the storage does not answer.
 *
 * The case happened for real, and it cost a round trip: five rushes queued one
 * event evening, two different messages — "Internal Server Error" on one, "fetch
 * failed" on the other — for one and the same cause, a storage switched off.
 * Neither named the address that had been tried, and we went looking for the
 * failure in the hub.
 *
 * Nothing these procedures do is ever the hub's fault: they call a third-party
 * service. The message must say which one, and why it did not answer.
 */
describe('unreachable storage', () => {
  let CLOSED_PORT = 0

  beforeAll(async () => {
    const { createServer } = await import('node:net')
    const server = createServer()
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    CLOSED_PORT = (server.address() as { port: number }).port
    await new Promise<void>((ok) => server.close(() => ok()))
  })

  const config = () => ({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal' as const,
    // A closed port, deliberately: it is exactly "MinIO is not running". Chosen by
    // opening then closing a server, to be sure it refuses instead of accepting
    // silently — port 9 "discard" accepts, and the test then waited out its
    // timeout instead of observing a refusal.
    s3Endpoint: `http://127.0.0.1:${CLOSED_PORT}`,
    s3AccessKeyId: 'cle',
    s3SecretAccessKey: 'secret',
    s3Bucket: 'rushes',
  })

  it('returns a 502 that names the storage, and never a 500', async () => {
    const hub = await createHub(config())
    await hub.app.listen({ port: 0, host: '127.0.0.1' })
    const address = hub.app.server.address()
    const origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`

    await provisionOperator(hub.auth, {
      email: 'regie@cloudnord.fr',
      name: 'Régie',
      password: 'motdepasse-regie-2026',
    })
    const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
    hub.services.rooms.ensureFromTracks(snapshot.program.rooms)
    hub.services.devices.bind({ clientId: CLIENT_ID, roomId: TRACK_1, approvedByUserId: 'op' })
    const token = hub.services.devices.issueToken(CLIENT_ID)

    const response = await fetch(`${origin}/rpc/vod/begin`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-room-client-id': CLIENT_ID,
      },
      body: JSON.stringify({
        json: { file: 'gros.mkv', sizeBytes: 500 * 1024 * 1024, kind: 'rush', sessionId: null },
      }),
    })
    const body = (await response.json()) as { json?: { message?: string }; message?: string }
    await hub.close()

    // 502 and not 500: the hub is not down, its storage does not answer. The two
    // are not investigated in the same place.
    expect(response.status).toBe(502)
    const message = body.json?.message ?? body.message ?? ''
    expect(message).toContain('Stockage injoignable')
    // The address aimed at, without which one does not even know it is the right
    // one.
    expect(message).toContain(`127.0.0.1:${CLOSED_PORT}`)
    // And the errno pattern, which tells a service switched off from a name that
    // cannot be found.
    expect(message).toMatch(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/)
  })
})

/**
 * The "Test the connection" button.
 *
 * It exists because commissioning was done blind: four variables are set, fingers
 * are crossed, and the verdict falls hours later on five rushes that will not
 * leave. What this test protects is that a failure says **where** it stops: a
 * firewall, a key, a right on the bucket and a signature are not fixed in the
 * same place, and "it does not work" is precisely what we already knew.
 */
describe('testing the connection', () => {
  const step = (check: Awaited<ReturnType<VodService['check']>>, name: string) =>
    check.etapes.find((e) => e.nom === name)

  it('goes through the four steps and leaves nothing behind', async () => {
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
    const fake = fakeS3()
    const check = await service(fake.transport).check()

    expect(check.ok).toBe(true)
    expect(check.etapes.map((e) => e.nom)).toEqual([
      'joindre',
      'authentifier',
      'signer',
      'nettoyer',
    ])
    // The check's multipart is closed again: leaving one open per check would be
    // the height of irony for a feature half of which is housekeeping.
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(true)
    // And the check object is recognizable by name, in case an abort ever fails.
    expect(fake.calls.some((c) => c.url.includes('.controle-de-connexion'))).toBe(true)
  })

  it('stops at "joindre" when the storage does not answer, without blaming the keys', async () => {
    settings.update({ vodBucket: 'rushes' })
    const unreachable: S3Transport = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    }
    const check = await service(unreachable).check()

    expect(check.ok).toBe(false)
    expect(step(check, 'joindre')?.ok).toBe(false)
    expect(step(check, 'joindre')?.detail).toContain('ECONNREFUSED')
    // Above all: we do not pretend to know whether the keys are good. We could not
    // ask.
    expect(step(check, 'authentifier')).toBeUndefined()
  })

  it('names a certificate that cannot be verified', async () => {
    // The case of a forgotten internal CA: the failure is not a network one, and
    // looking for it in a firewall costs an hour.
    settings.update({ vodBucket: 'rushes' })
    const noCa: S3Transport = async () => {
      throw Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error('unable to get local issuer certificate'), {
          code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        }),
      })
    }
    const check = await service(noCa).check()
    expect(step(check, 'joindre')?.detail).toContain('UNABLE_TO_GET_ISSUER_CERT_LOCALLY')
  })

  it('tells a reachable storage from a refused key', async () => {
    settings.update({ vodBucket: 'rushes' })
    const refusing: S3Transport = async (_url, options) => {
      if (options.method === 'GET') return { status: 403, body: '' }
      return {
        status: 403,
        body: '<Error><Code>SignatureDoesNotMatch</Code><Message>nope</Message></Error>',
      }
    }
    const check = await service(refusing).check()

    // Reaching succeeded: step 1's bare refusal already proves the network gets
    // through, the name resolves and the certificate is accepted.
    expect(step(check, 'joindre')?.ok).toBe(true)
    expect(step(check, 'authentifier')?.ok).toBe(false)
    expect(step(check, 'authentifier')?.detail).toContain('SignatureDoesNotMatch')
  })

  it('tells a missing bucket from a bucket one cannot write to', async () => {
    settings.update({ vodBucket: 'rushes' })
    for (const [code, expected] of [
      ['NoSuchBucket', 'NoSuchBucket'],
      ['AccessDenied', 'AccessDenied'],
    ]) {
      const transport: S3Transport = async (_url, options) =>
        options.method === 'GET'
          ? { status: 403, body: '' }
          : { status: 403, body: `<Error><Code>${code}</Code><Message>x</Message></Error>` }
      const check = await service(transport).check()
      expect(step(check, 'authentifier')?.detail).toContain(expected)
    }
  })

  it('catches a refused signed address, and closes up anyway', async () => {
    // The trickiest step, and the one no read probe would cover: a key can be
    // valid and a part address's signature wrong. That one carries the whole
    // upload of a rush.
    settings.update({ vodBucket: 'rushes' })
    const aborts: string[] = []
    const transport: S3Transport = async (url, options) => {
      if (options.method === 'DELETE') aborts.push(url)
      if (options.method === 'PUT') return { status: 403, body: '' }
      if (options.method === 'POST' && url.includes('uploads=')) {
        return { status: 200, body: '<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>' }
      }
      return { status: 200, body: '<Ok/>' }
    }
    const check = await service(transport).check()

    expect(step(check, 'signer')?.ok).toBe(false)
    // The multipart opened by the failed check is closed again: otherwise every
    // click on the button would leave a billed multipart behind it.
    expect(aborts).toHaveLength(1)
    expect(step(check, 'nettoyer')?.ok).toBe(true)
  })

  it('names the missing S3 action on a rights refusal', async () => {
    /**
     * The case met for real, and it cost a round trip: a complete policy for
     * reading and writing, but with no `s3:AbortMultipartUpload`. The check said
     * "AccessDenied" and one reread the policy without knowing what to look for —
     * all the more so as `s3:PutObject` covers opening a multipart and sending the
     * parts, but **not** aborting them, which is not obvious at all.
     */
    settings.update({ vodBucket: 'rushes' })
    const policy: S3Transport = async (url, options) => {
      const refused = options.method === 'DELETE' && url.includes('uploadId=')
      if (refused) {
        return { status: 403, body: '<Error><Code>AccessDenied</Code><Message>refus</Message></Error>' }
      }
      if (options.method === 'POST' && url.includes('uploads=')) {
        return { status: 200, body: '<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>' }
      }
      return { status: 200, body: '<Ok/>' }
    }
    const check = await service(policy).check()

    // Everything passes up to the cleanup: it really is one more permission that
    // is missing, not wrong keys.
    expect(step(check, 'authentifier')?.ok).toBe(true)
    expect(step(check, 'signer')?.ok).toBe(true)
    const cleanup = step(check, 'nettoyer')
    expect(cleanup?.ok).toBe(false)
    // The storage's code, and the action to add: an investigation becomes a line
    // to write.
    expect(cleanup?.detail).toContain('AccessDenied')
    expect(cleanup?.detail).toContain('s3:AbortMultipartUpload')
  })

  it('refuses to start with no bucket, and says so where it can be fixed', async () => {
    settings.update({ vodBucket: null })
    const check = await service(fakeS3().transport).check()
    expect(check.ok).toBe(false)
    expect(step(check, 'joindre')?.detail).toContain('aucun bucket')
  })
})

/**
 * The reset, and what stops it from going off on its own.
 *
 * It is the system's only gesture there is no coming back from: a day of capture,
 * erased on both sides. What these tests protect is therefore not that it works —
 * it is that it **refuses** in the three cases where it would destroy more than it
 * was asked to.
 */
describe('reset', () => {
  it('refuses with no prefix, rather than emptying the whole bucket', async () => {
    // With no prefix, "empty the prefix" and "empty the bucket" are the same
    // gesture. A bucket also used for something else would go with it, and
    // refusing is the only one of the two behaviours that can be recovered from.
    settings.update({ vodBucket: 'rushes', vodPrefix: null })
    const fake = fakeS3()
    await expect(service(fake.transport).reset()).rejects.toThrow(IncompleteStorage)
    // And above all: nothing was attempted.
    expect(fake.calls).toHaveLength(0)
  })

  it('deletes under the prefix, and abandons the uploads in progress', async () => {
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
    const deleted: string[] = []
    const aborts: string[] = []
    const transport: S3Transport = async (url, options) => {
      if (options.method === 'DELETE' && url.includes('uploadId=')) aborts.push(url)
      else if (options.method === 'DELETE') deleted.push(url)
      if (options.method === 'GET' && url.includes('list-type=2')) {
        return {
          status: 200,
          body:
            '<ListBucketResult><IsTruncated>false</IsTruncated>' +
            '<Contents><Key>cn26/2026-10-30/track-1/a.mkv</Key></Contents>' +
            '<Contents><Key>cn26/2026-10-30/track-1/a.json</Key></Contents>' +
            '</ListBucketResult>',
        }
      }
      if (options.method === 'GET' && url.includes('uploads=')) {
        return {
          status: 200,
          body:
            '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>' +
            '<Upload><Key>cn26/b.mkv</Key><UploadId>u9</UploadId></Upload>' +
            '</ListMultipartUploadsResult>',
        }
      }
      return { status: 200, body: '<Ok/>' }
    }

    const outcome = await service(transport).reset()

    expect(outcome).toEqual({ objets: 2, multiparts: 1 })
    expect(deleted).toHaveLength(2)
    // Open multiparts appear in no object listing — they do not exist as objects
    // yet — and would therefore survive a reset that claims to erase everything.
    expect(aborts).toHaveLength(1)
    expect(aborts[0]).toContain('uploadId=u9')
  })

  it('only asks for what is under the prefix', async () => {
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
    const fake = fakeS3()
    await service(fake.transport).reset()

    // The trailing slash matters: "cn26" without it would also catch "cn2600".
    const listings = fake.calls.filter((c) => c.method === 'GET')
    expect(listings.length).toBeGreaterThan(0)
    for (const call of listings) expect(call.url).toContain('prefix=cn26%2F')
  })

  it('empties the registry: "finished" on a deleted object would be a lie', async () => {
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
    const fake = fakeS3()
    const vod = service(fake.transport)
    const plan = await vod.begin(A_RUSH)
    await vod.complete(TRACK_1, plan.uploadId)
    expect(vod.uploads(null, () => null)).toHaveLength(1)

    await vod.reset()
    // Otherwise the console would keep announcing that everything is shipped back,
    // on objects that no longer exist.
    expect(vod.uploads(null, () => null)).toEqual([])
  })
})

/**
 * The reset's locks, at the hub level.
 *
 * Three of them, and each covers what the others let through: the console does
 * not render the button in production, the hub refuses the procedure, and the
 * contract demands the copied word. The first only protects against
 * absent-mindedness; the other two protect against a direct call.
 */
describe('reset: the locks', () => {
  const base = {
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal' as const,
    s3Endpoint: 'http://127.0.0.1:9000',
    s3AccessKeyId: 'cle',
    s3SecretAccessKey: 'secret',
    s3Bucket: 'rushes',
  }

  async function call(mode: 'dev' | 'production', confirmation: string) {
    const hub = await createHub({ ...base, mode })
    await hub.app.listen({ port: 0, host: '127.0.0.1' })
    const address = hub.app.server.address()
    const origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`
    await provisionOperator(hub.auth, {
      email: 'regie@cloudnord.fr',
      name: 'Régie',
      password: 'motdepasse-regie-2026',
    })
    const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'regie@cloudnord.fr', password: 'motdepasse-regie-2026' }),
    })
    const { token } = (await signIn.json()) as { token: string }
    const response = await fetch(`${origin}/rpc/vod/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ json: { confirmation } }),
    })
    const body = (await response.json()) as { json?: { message?: string }; message?: string }
    await hub.close()
    return { status: response.status, message: body.json?.message ?? body.message ?? '' }
  }

  it('refuses in production, even with the right word', async () => {
    // The lock that counts: a console that does not render the button only
    // protects against absent-mindedness, not against a direct call. This one
    // destroys a day of capture. `RAZ` is the contract's confirmation word.
    const result = await call('production', 'RAZ')
    expect(result.status).toBe(403)
    expect(result.message).toContain('développement')
  })

  it('refuses without the copied word, even in development', async () => {
    // The confirmation is in the contract, so checked by the hub: a direct call
    // that bypasses the modal cannot happen through distraction.
    const result = await call('dev', 'oui')
    expect(result.status).toBe(400)
  })
})

/**
 * The check, against a real TLS server behind a homemade CA.
 *
 * The tests next door simulate the transport: they prove the steps' logic, and
 * **cannot see** that a call forgets to pass the CA — the fake transport does not
 * care. That is exactly the defect that got through: the reachability probe did
 * not pass `caCert`, and the check blamed a certificate that the configuration
 * already fixed.
 *
 * A diagnosis that blames what has just been repaired is worse than no diagnosis:
 * one undoes the good configuration to go looking for another.
 */
describe('check against a real TLS', () => {
  let directory: string
  let server: import('node:https').Server
  let port = 0
  let caPem = ''

  beforeAll(async () => {
    const { execSync } = await import('node:child_process')
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createServer } = await import('node:https')

    directory = mkdtempSync(join(tmpdir(), 'cloudnord-ca-'))
    const path = (name: string) => join(directory, name)
    const run = (command: string) => execSync(command, { stdio: 'ignore' })
    run(`openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes -keyout ${path('ca.key')} -out ${path('ca.pem')} -subj "/CN=CA interne de test" -addext "basicConstraints=critical,CA:TRUE"`)
    run(`openssl req -newkey rsa:2048 -nodes -keyout ${path('srv.key')} -out ${path('srv.csr')} -subj "/CN=localhost"`)
    writeFileSync(path('ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n')
    run(`openssl x509 -req -in ${path('srv.csr')} -CA ${path('ca.pem')} -CAkey ${path('ca.key')} -CAcreateserial -out ${path('srv.pem')} -days 1 -sha256 -extfile ${path('ext.cnf')}`)
    caPem = readFileSync(path('ca.pem'), 'utf8')

    // A minimal storage: it refuses everything, which is enough — the "joindre"
    // step makes do with a refusal, it already proves the connection is
    // established.
    server = createServer(
      { key: readFileSync(path('srv.key')), cert: readFileSync(path('srv.pem')) },
      (_request, response) => {
        response.writeHead(403)
        response.end('<Error><Code>AccessDenied</Code><Message>refus</Message></Error>')
      },
    )
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    await new Promise<void>((ok) => server.close(() => ok()))
    const { rmSync } = await import('node:fs')
    rmSync(directory, { recursive: true, force: true })
  })

  const tlsKeys = (caCert: string | null) => ({
    endpoint: `https://localhost:${port}`,
    region: 'us-east-1',
    accessKeyId: 'cle',
    secretAccessKey: 'secret',
    forcePathStyle: true,
    caCert,
  })

  it('gets past "joindre" when the CA is supplied', async () => {
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
    const vod = new VodService(db, settings, tlsKeys(caPem), 30, () => new Date().toISOString())
    const check = await vod.check()

    // This is the regression: without the CA passed to the probe, this step failed
    // even though the hub was correctly configured.
    const reach = check.etapes.find((e) => e.nom === 'joindre')
    expect(reach?.ok).toBe(true)
    // The server refuses everything: we therefore stop at the next step, which is
    // the right behaviour — and proves we did go and talk to it.
    expect(check.etapes.find((e) => e.nom === 'authentifier')?.ok).toBe(false)
  })

  it('with no CA, says the trust defect AND where to repair it', async () => {
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
    const vod = new VodService(db, settings, tlsKeys(null), 30, () => new Date().toISOString())
    const check = await vod.check()

    const reach = check.etapes.find((e) => e.nom === 'joindre')
    expect(reach?.ok).toBe(false)
    // The raw code is kept — it is the only word one can put in a search engine.
    // Which one exactly depends on the chain the server presents
    // (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
    // `SELF_SIGNED_CERT_IN_CHAIN`…): what matters is that it is there, and that it
    // does not travel alone.
    expect(reach?.detail).toMatch(/CERT|SIGNATURE/)
    // Because alone, it says neither that Node ignores the system store, nor where
    // to put the CA — and one then goes looking for a firewall.
    expect(reach?.detail).toContain('S3_CA_CERT')
  })

  it('tells "no CA" from "the CA does not cover this certificate"', async () => {
    // Two opposite leads: in one case one is missing, in the other the one
    // supplied is not the right one. Confusing them makes one undo a correct
    // configuration to go looking for another.
    settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
    const { execSync } = await import('node:child_process')
    const { mkdtempSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const other = mkdtempSync(join(tmpdir(), 'cloudnord-ca2-'))
    execSync(
      `openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes -keyout ${join(other, 'k')} -out ${join(other, 'c')} -subj "/CN=Une autre CA"`,
      { stdio: 'ignore' },
    )
    const vod = new VodService(
      db,
      settings,
      tlsKeys(readFileSync(join(other, 'c'), 'utf8')),
      30,
      () => new Date().toISOString(),
    )
    const check = await vod.check()

    expect(check.etapes.find((e) => e.nom === 'joindre')?.detail).toContain('ne couvre pas')
  })
})
