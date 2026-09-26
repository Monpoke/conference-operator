import { beforeEach, describe, expect, it } from 'vitest'
import type { VodHabillage } from '@conference-operator/contract'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { RoomService } from '../src/services/rooms.js'
import { SettingsService } from '../src/services/sessions.js'
import { VodService } from '../src/services/vod.js'
import { LEASE_MS, MAX_ATTEMPTS, MontageError, MontageService } from '../src/services/montage.js'
import type { S3Transport } from '../src/services/s3.js'
import { testSecrets } from './helpers/secrets.js'

/**
 * The montage queue.
 *
 * What we hold here: that a take is edited once its rushes are all in the
 * storage — and waits for them otherwise; that a worker which dies gives its
 * job back instead of holding it forever; that a worker only ever reads the
 * files of the take it holds; and that a revoked token opens nothing.
 */

const TRACK_1 = 'track-1-teilhard-de-chardin'
const KEYS = { endpoint: 'http://localhost:9000', region: 'us-east-1', accessKeyId: 'cle', secretAccessKey: 'secret', forcePathStyle: true }

const HABILLAGE: VodHabillage = {
  event: { name: 'Cloud Nord 2026', date: '30 octobre 2026', logoUrl: null },
  talk: { title: 'HoneySwamp', category: null, color: null },
  speakers: [],
  merci: 'Merci à nos sponsors',
  sponsorPages: [],
}

let db: HubDatabase
let vod: VodService
let clock: Date
let montage: MontageService
let calls: { url: string; method: string; body?: string }[]

const fakeS3: S3Transport = async (url, options) => {
  calls.push({ url, method: options.method, body: options.body })
  if (url.includes('uploads=') && options.method === 'POST') {
    return { status: 200, body: '<InitiateMultipartUploadResult><UploadId>m1</UploadId></InitiateMultipartUploadResult>' }
  }
  return { status: 200, body: '<Ok/>' }
}

beforeEach(() => {
  db = openHubDatabase(':memory:').orm
  const settings = new SettingsService(db)
  new RoomService(db, testSecrets).upsert({
    id: TRACK_1,
    name: 'Track #1',
    trackId: TRACK_1,
    obs: { A: { url: 'ws://127.0.0.1:4455', password: null }, B: { url: 'ws://127.0.0.1:4456', password: null } },
    sceneRoles: { A: {}, B: {} },
    displayPort: 7788,
    recordingRoot: null,
  })
  settings.update({ vodBucket: 'rushes', vodPrefix: 'cn26' })
  calls = []
  clock = new Date('2026-10-30T18:00:00.000Z')
  vod = new VodService(db, settings, KEYS, 30, () => clock.toISOString(), () => {}, fakeS3)
  montage = new MontageService(db, () => vod, () => HABILLAGE, () => clock)
})

/** A file the room has finished uploading. */
async function uploaded(file: string, kind: 'rush' | 'sidecar', sessionId = 'sess-1') {
  const plan = await vod.begin({ roomId: TRACK_1, file, sizeBytes: kind === 'rush' ? 1_000 : 900, kind, sessionId })
  await vod.complete(TRACK_1, plan.uploadId)
  return plan.uploadId
}

const SIDECAR = '2026-10-30/track1/2026-10-30_1100_honeyswamp.json'
const RUSH = '2026-10-30/track1/2026-10-30_1100_honeyswamp.mkv'

describe('workers', () => {
  it('shows the token once and keeps only its hash', () => {
    const created = montage.createWorker('Mac mini', 'admin@cloudnord.fr')
    expect(created.token).toMatch(/^wt_/)
    expect(montage.fromToken(created.token)).toEqual({ id: created.id, nom: 'Mac mini' })
    expect(JSON.stringify(montage.workers())).not.toContain(created.token)
  })

  it('opens nothing once revoked, and gives back what the worker held', async () => {
    const created = montage.createWorker('Mac mini', null)
    const worker = montage.fromToken(created.token)!
    montage.enqueue({ sessionId: 'sess-1', roomId: TRACK_1, sidecarUploadId: await uploaded(SIDECAR, 'sidecar') })
    expect(montage.claim(worker)).not.toBeNull()

    expect(montage.revokeWorker(created.id)).toBe(true)
    expect(montage.fromToken(created.token)).toBeNull()
    expect(montage.list(null)[0]!.state).toBe('attente')
  })

  it('refuses a room token as a worker token', () => {
    expect(montage.fromToken('rt_abc')).toBeNull()
  })
})

describe('the queue', () => {
  it('hands a job to one worker only', async () => {
    const a = montage.fromToken(montage.createWorker('a', null).token)!
    const b = montage.fromToken(montage.createWorker('b', null).token)!
    montage.enqueue({ sessionId: 'sess-1', roomId: TRACK_1, sidecarUploadId: await uploaded(SIDECAR, 'sidecar') })

    const claim = montage.claim(a)
    expect(claim).toMatchObject({ sessionId: 'sess-1', roomId: TRACK_1, habillage: HABILLAGE })
    expect(claim!.sidecarUrl).toContain('/rushes/cn26/2026-10-30/')
    expect(claim!.sidecarUrl).toContain('X-Amz-Signature=')
    expect(montage.claim(b)).toBeNull()
    expect(() => montage.heartbeat(b, claim!.jobId, 'intro', 10)).toThrow(MontageError)
  })

  it('keeps one waiting job per talk: a later take replaces it', async () => {
    montage.enqueue({ sessionId: 'sess-1', roomId: TRACK_1, sidecarUploadId: await uploaded(SIDECAR, 'sidecar') })
    const later = await uploaded('2026-10-30/track1/2026-10-30_1120_honeyswamp.json', 'sidecar')
    montage.enqueue({ sessionId: 'sess-1', roomId: TRACK_1, sidecarUploadId: later })
    expect(montage.list('sess-1')).toHaveLength(1)
  })

  it('reads the files the sidecar names, beside it — and waits for those still on their way', async () => {
    const worker = montage.fromToken(montage.createWorker('w', null).token)!
    montage.enqueue({ sessionId: 'sess-1', roomId: TRACK_1, sidecarUploadId: await uploaded(SIDECAR, 'sidecar') })
    const claim = montage.claim(worker)!

    const early = montage.files(worker, claim.jobId, ['2026-10-30_1100_honeyswamp.mkv'])
    expect(early).toEqual({ urls: [], manquants: ['2026-10-30_1100_honeyswamp.mkv'] })

    // The rush still on its way: given back, and the attempt does not count.
    await montage.fail(worker, claim.jobId, 'rush pas encore arrivé', true)
    const waiting = montage.list('sess-1')[0]!
    expect(waiting).toMatchObject({ state: 'attente', tentatives: 0 })
    expect(montage.claim(worker)).toBeNull()

    await uploaded(RUSH, 'rush')
    clock = new Date(clock.getTime() + 11 * 60_000)
    const again = montage.claim(worker)!
    const ready = montage.files(worker, again.jobId, ['2026-10-30_1100_honeyswamp.mkv'])
    expect(ready.manquants).toEqual([])
    expect(ready.urls[0]!.url).toContain('2026-10-30_1100_honeyswamp.mkv')
  })

  it('refuses a path that climbs out of the take', async () => {
    const worker = montage.fromToken(montage.createWorker('w', null).token)!
    montage.enqueue({ sessionId: 'sess-1', roomId: TRACK_1, sidecarUploadId: await uploaded(SIDECAR, 'sidecar') })
    const claim = montage.claim(worker)!
    expect(() => montage.files(worker, claim.jobId, ['../autre/rush.mkv'])).toThrow(MontageError)
  })
})

describe('a worker that dies', () => {
  it('gives its job back when the lease lapses — and fails it after too many', async () => {
    const worker = montage.fromToken(montage.createWorker('w', null).token)!
    montage.enqueue({ sessionId: 'sess-1', roomId: TRACK_1, sidecarUploadId: await uploaded(SIDECAR, 'sidecar') })

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(montage.claim(worker)).not.toBeNull()
      clock = new Date(clock.getTime() + LEASE_MS + 1_000)
    }
    expect(montage.claim(worker)).toBeNull()
    expect(montage.list('sess-1')[0]).toMatchObject({ state: 'echoue' })
  })

  it('keeps its job while it beats', async () => {
    const worker = montage.fromToken(montage.createWorker('w', null).token)!
    montage.enqueue({ sessionId: 'sess-1', roomId: TRACK_1, sidecarUploadId: await uploaded(SIDECAR, 'sidecar') })
    const claim = montage.claim(worker)!
    clock = new Date(clock.getTime() + LEASE_MS - 1_000)
    montage.heartbeat(worker, claim.jobId, 'assemblage', 40)
    clock = new Date(clock.getTime() + LEASE_MS - 1_000)
    expect(montage.list('sess-1')[0]).toMatchObject({ state: 'en-cours', etape: 'assemblage', pourcent: 40 })
  })
})

describe('the edited video', () => {
  it('goes beside the rushes under montages/, and is downloadable once done', async () => {
    const worker = montage.fromToken(montage.createWorker('w', null).token)!
    montage.enqueue({ sessionId: 'sess-1', roomId: TRACK_1, sidecarUploadId: await uploaded(SIDECAR, 'sidecar') })
    const claim = montage.claim(worker)!

    const plan = await montage.openUpload(worker, claim.jobId, 3 * 1024 ** 3)
    expect(plan.parts).toBeLessThanOrEqual(9_000)
    expect(montage.signParts(worker, claim.jobId, [1, 2])).toHaveLength(2)

    const key = await montage.complete(worker, {
      jobId: claim.jobId,
      parts: [{ n: 2, etag: '"b"' }, { n: 1, etag: '"a"' }],
      durationMs: 3_000_000,
      marquesManquantes: ['debut'],
    })
    expect(key).toBe(`cn26/montages/2026-10-30/${TRACK_1}/2026-10-30_1100_honeyswamp.mp4`)
    // In part order, whatever the order the worker acknowledged them in.
    expect(calls.at(-1)!.body).toContain('<Part><PartNumber>1</PartNumber><ETag>"a"</ETag></Part><Part><PartNumber>2</PartNumber>')

    const done = montage.list('sess-1')[0]!
    expect(done).toMatchObject({ state: 'termine', marquesManquantes: ['debut'], durationMs: 3_000_000, outputKey: key })
    expect(montage.downloadUrl(done.id)).toContain('response-content-disposition=')
  })

  it('can be edited again from the talk’s latest take', async () => {
    await uploaded(SIDECAR, 'sidecar')
    const job = await montage.relaunch('sess-1')
    expect(job.state).toBe('attente')
    await expect(montage.relaunch('sess-inconnue')).rejects.toThrow(MontageError)
  })

  it('stops a job the console cancelled', async () => {
    const worker = montage.fromToken(montage.createWorker('w', null).token)!
    montage.enqueue({ sessionId: 'sess-1', roomId: TRACK_1, sidecarUploadId: await uploaded(SIDECAR, 'sidecar') })
    const claim = montage.claim(worker)!
    expect(await montage.cancel(claim.jobId)).toBe(true)
    expect(montage.heartbeat(worker, claim.jobId, 'intro', 5)).toMatchObject({ ok: false, annule: true })
  })
})
