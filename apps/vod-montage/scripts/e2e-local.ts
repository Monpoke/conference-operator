/**
 * The whole chain, on this machine, with no storage and no room to set up:
 *
 *   pnpm --filter @conference-operator/vod-montage e2e [--jingle jingle.wav]
 *
 * A real hub (in memory), a stand-in S3 (in memory, signatures not checked), a
 * room that uploads a take split in two by OBS — a test pattern with a tone,
 * 440 Hz then 660 Hz — its sidecar marked at 10 s and 50 s, and the real
 * worker: claim, download, render, assemble, upload. The edited video is
 * written next to the script's output, and checked with ffprobe.
 *
 * Needs ffmpeg and Chrome (`CHROME=`) — the same as the worker.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import type { contract, Sidecar } from '@conference-operator/contract'
import { createHub } from '@conference-operator/hub-server/server'
import { launchChrome } from '../src/chrome.js'
import { configSchema } from '../src/config.js'
import { FFMPEG, run } from '../src/ffmpeg.js'
import { connectHub } from '../src/hub.js'
import { probe } from '../src/montage.js'
import { processJob } from '../src/worker.js'

const { values } = parseArgs({ options: { jingle: { type: 'string' }, sortie: { type: 'string' } } })
const say = (text: string) => console.log(`· ${text}`)

const TRACK_1 = 'track-1-teilhard-de-chardin'
const CLIENT_ID = '01JB2ZK5T7QW9V0YHRXM3N4P6C'
const SESSION = 'cmq3nx20102h901ppuyjkennd'
const rawProgram = await readFile(fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)), 'utf8')

/* ---------- A stand-in S3: path-style, in memory, signatures taken on trust ---------- */
const objects = new Map<string, Buffer>()
const multiparts = new Map<string, Map<number, Buffer>>()
const body = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}
const s3 = createServer(async (request, response) => {
  const url = new URL(request.url!, 'http://s3')
  const key = decodeURIComponent(url.pathname.slice(1))
  const q = url.searchParams
  const data = await body(request)
  const etag = `"${createHash('md5').update(data).digest('hex')}"`
  if (request.method === 'POST' && q.has('uploads')) {
    const id = `mp${multiparts.size + 1}`
    multiparts.set(id, new Map())
    return response.end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`)
  }
  if (request.method === 'PUT' && q.has('partNumber')) {
    multiparts.get(q.get('uploadId')!)!.set(Number(q.get('partNumber')), data)
    response.setHeader('etag', etag)
    // Browsers and fetch only see the ETag when the storage exposes it.
    response.setHeader('access-control-expose-headers', 'ETag')
    return response.end()
  }
  if (request.method === 'POST' && q.has('uploadId')) {
    const parts = multiparts.get(q.get('uploadId')!)!
    const order = [...data.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]))
    objects.set(key, Buffer.concat(order.map((n) => parts.get(n)!)))
    multiparts.delete(q.get('uploadId')!)
    return response.end('<CompleteMultipartUploadResult/>')
  }
  if (request.method === 'DELETE') {
    multiparts.delete(q.get('uploadId') ?? '')
    objects.delete(key)
    response.statusCode = 204
    return response.end()
  }
  if (request.method === 'PUT') {
    objects.set(key, data)
    response.setHeader('etag', etag)
    return response.end()
  }
  if (request.method === 'GET' && q.has('uploads')) {
    return response.end('<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>')
  }
  if (request.method === 'GET' && objects.has(key)) return response.end(objects.get(key))
  response.statusCode = 404
  response.end('<Error><Code>NoSuchKey</Code></Error>')
})
await new Promise<void>((ok) => s3.listen(0, '127.0.0.1', ok))
const s3Port = (s3.address() as { port: number }).port

/* ---------- The hub ---------- */
const hub = await createHub({
  port: 0,
  host: '127.0.0.1',
  databasePath: ':memory:',
  publicUrl: 'http://127.0.0.1',
  authSecret: 'e2e-secret-'.padEnd(48, 'x'),
  logLevel: 'warn',
  s3Endpoint: `http://127.0.0.1:${s3Port}`,
  s3AccessKeyId: 'cle',
  s3SecretAccessKey: 'secret',
  s3Bucket: 'rushes',
  s3Prefix: 'cn26',
})
await hub.app.listen({ port: 0, host: '127.0.0.1' })
const hubUrl = `http://127.0.0.1:${(hub.app.server.address() as { port: number }).port}`
const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
hub.services.rooms.ensureFromTracks(snapshot.program.rooms)
hub.services.devices.bind({ clientId: CLIENT_ID, roomId: TRACK_1, approvedByUserId: 'e2e' })
const roomToken = hub.services.devices.issueToken(CLIENT_ID)!
say(`hub ${hubUrl}, S3 factice :${s3Port}`)

const work = await mkdtemp(join(tmpdir(), 'vod-e2e-'))
const out = resolve(values.sortie ?? join(work, 'sortie'))
await mkdir(out, { recursive: true })

try {
  /* ---------- A room uploads a take ---------- */
  const room: ContractRouterClient<typeof contract> = createORPCClient(new RPCLink({
    origin: hubUrl,
    url: '/rpc',
    headers: () => ({ authorization: `Bearer ${roomToken}`, 'x-room-client-id': CLIENT_ID }),
  }))
  const takeDir = join(work, 'prise')
  await mkdir(takeDir)
  const pattern = (seconds: number, hz: number, file: string) => run(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}:sample_rate=48000`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-ac', '2', join(takeDir, file),
  ])
  await pattern(35, 440, 'talk.mkv')
  await pattern(25, 660, 'talk (2).mkv')
  const sidecar: Sidecar = {
    sessionId: SESSION,
    title: 'Industrialiser l’IA en équipe',
    speakers: [{ name: 'Guillaume Leroy', company: null }],
    roomId: TRACK_1,
    trackTitle: null,
    category: null,
    startedAt: '2026-10-30T09:00:00+01:00',
    endedAt: '2026-10-30T09:01:00+01:00',
    durationMs: 60_000,
    markers: [
      { label: 'Début', offsetMs: 10_000, at: '2026-10-30T09:00:10+01:00', role: 'debut' },
      { label: 'Fin', offsetMs: 50_000, at: '2026-10-30T09:00:50+01:00', role: 'fin' },
    ],
    videoFile: 'talk.mkv',
    segments: [
      { file: 'talk.mkv', offsetMs: 0, durationMs: 35_000 },
      { file: 'talk (2).mkv', offsetMs: 35_000, durationMs: 25_000 },
    ],
  }
  await writeFile(join(takeDir, 'talk.json'), JSON.stringify(sidecar))

  // The sidecar first, as a room often does: the worker then finds the rushes missing.
  for (const [name, kind] of [['talk.json', 'sidecar'], ['talk.mkv', 'rush'], ['talk (2).mkv', 'rush']] as const) {
    const bytes = await readFile(join(takeDir, name))
    const plan = await room.vod.begin({ file: `2026-10-30/track1/${name}`, sizeBytes: bytes.length, kind, sessionId: SESSION })
    if (plan.mode === 'direct') {
      const put = await fetch(plan.url, { method: 'PUT', body: bytes })
      if (!put.ok) throw new Error(`PUT ${name} : ${put.status}`)
    } else {
      const numeros = Array.from({ length: plan.parts }, (_, i) => i + 1)
      for (const part of await room.vod.parts({ uploadId: plan.uploadId, numeros })) {
        const chunk = bytes.subarray((part.numero - 1) * plan.taillePartOctets, part.numero * plan.taillePartOctets)
        const put = await fetch(part.url, { method: 'PUT', body: chunk })
        await room.vod.progress({ uploadId: plan.uploadId, numero: part.numero, etag: put.headers.get('etag')!, octets: chunk.length, dureeMs: 1 })
      }
    }
    await room.vod.complete({ uploadId: plan.uploadId })
    say(`salle : ${name} téléversé`)

    if (kind === 'sidecar') {
      // The worker comes by now: the rushes are not there yet.
      const precoce = connectHub(hubUrl, hub.services.montage.createWorker('précoce', null).token)
      const early = await precoce.montage.claim()
      if (early == null) throw new Error('aucun job créé à l’arrivée du sidecar')
      const refused = await connectHub(hubUrl, roomToken).montage.fichiers({ jobId: early.jobId, files: ['talk.mkv'] }).catch((e: Error) => e)
      if (!(refused instanceof Error)) throw new Error('un jeton de salle a ouvert le montage')
      const { manquants } = await precoce.montage.fichiers({ jobId: early.jobId, files: ['talk.mkv', 'talk (2).mkv'] })
      if (manquants.length !== 2) throw new Error('des rushes absents ont été signés')
      await precoce.montage.fail({ jobId: early.jobId, raison: 'rushes en route', reessayer: true })
      say('job créé à l’arrivée du sidecar ; jeton de salle refusé ; rushes manquants → rendu à la file')
    }
  }
  const job = await hub.services.montage.relaunch(SESSION)
  say(`job ${job.id} en file`)

  /* ---------- The worker ---------- */
  const token = hub.services.montage.createWorker('e2e', 'e2e').token
  const config = configSchema.parse({
    hubUrl,
    workerToken: token,
    chrome: process.env.CHROME ?? 'google-chrome',
    jingle: values.jingle,
    workDir: join(work, 'worker'),
  })
  const workerHub = connectHub(hubUrl, token)
  const claim = await workerHub.montage.claim()
  if (claim == null) throw new Error('le worker n’a rien reçu')
  say(`worker : « ${claim.habillage.talk.title} », ${claim.habillage.speakers.length} orateur(s)`)

  const chrome = await launchChrome(config.chrome, await mkdtemp(join(work, 'chrome-')))
  const started = Date.now()
  try {
    await processJob({ hub: workerHub, claim, config, chrome, log: (level, text, context) => say(`${level} ${text} ${context ? JSON.stringify(context) : ''}`) })
  } finally {
    await chrome.stop()
  }

  /* ---------- What came out ---------- */
  const [done] = hub.services.montage.list(SESSION)
  if (done?.state !== 'termine' || done.outputKey == null) throw new Error(`job ${done?.state} : ${done?.erreur}`)
  const video = objects.get(`rushes/${done.outputKey}`)
  if (video == null) throw new Error(`rien sous ${done.outputKey}`)
  const file = join(out, 'montage.mp4')
  await writeFile(file, video)
  const probed = await probe(file)
  const expected = 6_000 + 40_000 + 8_000 - 1_000
  say(`montage : ${done.outputKey} — ${(probed.durationMs / 1000).toFixed(2)} s (attendu ≈ ${expected / 1000} s), ${probed.format.width}×${probed.format.height} à ${probed.format.fps} i/s`)
  say(`en ${((Date.now() - started) / 1000).toFixed(0)} s → ${file}`)
  if (Math.abs(probed.durationMs - expected) > 1_000) throw new Error('durée inattendue')
  say('OK')
} finally {
  await hub.close()
  s3.close()
  if (values.sortie == null) say(`(dossier de travail : ${work})`)
  else await rm(work, { recursive: true, force: true })
}
