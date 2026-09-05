import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VOD_POLICY, type SignedPart, type UploadPlan } from '@conference-operator/contract'
import { LocalStore } from '../src/core/store.js'
import {
  Uploads,
  type VodCandidate,
  type HubVod,
  type UploadDeps,
} from '../src/core/upload.js'

/**
 * Bringing footage home must **finish**.
 *
 * That is the whole question. A three-gigabyte file on an event's network will be
 * cut — not maybe, certainly: somebody unplugs a switch, the Wi-Fi saturates at
 * the break, the machine reboots for a Windows update launched at the wrong
 * moment. An uploader that starts over on every cut never finishes, and nobody
 * notices before going looking for the VOD.
 *
 * Hence what these tests hold: the resume starts at the next part, only one file
 * goes up at a time, the slices are byte-exact, and the sidecar never leaves
 * ahead of its footage.
 */

const PART = 8 * 1024 * 1024
const SIZE = PART * 3 + 1234

/** A hub that accepts everything, and notes what it was asked for. */
function fakeHub(options: { recues?: number[] } = {}) {
  const log = {
    begin: [] as { file: string; kind: string }[],
    parts: [] as number[],
    progress: [] as { numero: number; etag: string }[],
    complete: [] as string[],
    abort: [] as string[],
  }
  const hub: HubVod = {
    async begin(entry): Promise<UploadPlan> {
      log.begin.push({ file: entry.file, kind: entry.kind })
      if (entry.kind === 'sidecar') {
        return {
          mode: 'direct',
          uploadId: `up-${entry.file}`,
          url: `https://s3.test/${entry.file}`,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }
      }
      return {
        mode: 'multipart',
        uploadId: `up-${entry.file}`,
        taillePartOctets: PART,
        parts: Math.ceil(entry.sizeBytes / PART),
        recues: options.recues ?? [],
      }
    },
    async parts(_uploadId, numbers): Promise<SignedPart[]> {
      log.parts.push(...numbers)
      return numbers.map((numero) => ({
        numero,
        url: `https://s3.test/part/${numero}`,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }))
    },
    async progress(entry) {
      log.progress.push({ numero: entry.numero, etag: entry.etag })
    },
    async complete(uploadId) {
      log.complete.push(uploadId)
    },
    async abort(uploadId) {
      log.abort.push(uploadId)
    },
  }
  return { hub, log }
}

/**
 * Requests, then waits for the pass the request launched.
 *
 * In real life `request()` returns straight away: a click on "Téléverser" must
 * not block the control app for three gigabytes. `pass()` joins the work already
 * in flight, which gives us the wait we need here.
 */
async function requestAndWait(m: Rig, file: string | null): Promise<void> {
  await m.uploads.request(file)
  await m.uploads.pass()
}

const ONE_TAKE: VodCandidate = {
  file: '2026-10-30_track1_1100_honeyswamp.mkv',
  sizeBytes: SIZE,
  beingWritten: false,
  sessionId: 'sess-1',
  sidecar: { file: '2026-10-30_track1_1100_honeyswamp.json', sizeBytes: 900 },
}

interface Rig {
  uploads: Uploads
  slices: { file: string; from: number; to: number }[]
  sends: { url: string; bytes: number }[]
  waits: number[]
}

function rig(
  hub: HubVod | null,
  patch: Partial<UploadDeps> = {},
  candidates: VodCandidate[] = [ONE_TAKE],
): Rig {
  const slices: { file: string; from: number; to: number }[] = []
  const sends: { url: string; bytes: number }[] = []
  const waits: number[] = []
  const uploads = new Uploads({
    store: new LocalStore(':memory:'),
    candidates: async () => candidates,
    hub: () => hub,
    policy: () => ({ ...DEFAULT_VOD_POLICY, actif: true }),
    load: () => ({ cpu: 0.1, cores: 8, windowMs: 2000, memory: null }),
    recording: () => false,
    talkRunning: () => false,
    msBeforeNext: () => null,
    pathOf: (file) => `/tmp/${file}`,
    readRange: async (file, from, to) => {
      slices.push({ file, from, to })
      return Buffer.alloc(to - from)
    },
    sendPart: async (url, body) => {
      sends.push({ url, bytes: body.byteLength })
      return `"etag-${sends.length}"`
    },
    wait: async (ms) => {
      waits.push(ms)
    },
    ...patch,
  })
  return { uploads, slices, sends, waits }
}

describe('uploading footage', () => {
  it('slices the file into exact parts, the last one included', async () => {
    const { hub, log } = fakeHub()
    const m = rig(hub)
    await requestAndWait(m, ONE_TAKE.file)

    expect(log.parts).toEqual([1, 2, 3, 4])
    // Three full parts and a remainder. Being one byte out on the last one
    // produces a file the storage accepts and nobody reads back before target:
    // that is the bound to hold.
    expect(m.slices.filter((t) => t.file === ONE_TAKE.file)).toEqual([
      { file: ONE_TAKE.file, from: 0, to: PART },
      { file: ONE_TAKE.file, from: PART, to: PART * 2 },
      { file: ONE_TAKE.file, from: PART * 2, to: PART * 3 },
      { file: ONE_TAKE.file, from: PART * 3, to: SIZE },
    ])
    // The footage's last send carries the remainder, not a full part.
    expect(m.sends.filter((e) => e.url.includes('/part/')).at(-1)?.bytes).toBe(1234)
  })

  it('acknowledges each part with its ETag, without which nothing recomposes', async () => {
    const { hub, log } = fakeHub()
    const m = rig(hub)
    await requestAndWait(m, ONE_TAKE.file)

    expect(log.progress.map((p) => p.numero)).toEqual([1, 2, 3, 4])
    expect(log.progress.every((p) => p.etag.startsWith('"etag-'))).toBe(true)
    expect(log.complete).toContain(`up-${ONE_TAKE.file}`)
  })

  it('resumes at the next part after a restart', async () => {
    // The heart of the matter: the machine restarted while two parts were already
    // at the storage. Replaying them would cost sixteen megabytes and, on
    // three-gigabyte footage, a room that restarts twice would never finish.
    const { hub, log } = fakeHub({ recues: [1, 2] })
    const m = rig(hub)
    await requestAndWait(m, ONE_TAKE.file)

    expect(log.parts).toEqual([3, 4])
    expect(m.slices.filter((t) => t.file === ONE_TAKE.file).map((t) => t.from)).toEqual([
      PART * 2,
      PART * 3,
    ])
  })

  it('sends the sidecar after the footage, never ahead of it', async () => {
    const { hub, log } = fakeHub()
    const m = rig(hub)
    await requestAndWait(m, ONE_TAKE.file)

    // A sidecar arriving alone would describe a talk whose video is not there:
    // target would believe the footage lost.
    expect(log.begin.map((b) => b.kind)).toEqual(['rush', 'sidecar'])
    expect(log.begin.at(-1)?.file).toBe(ONE_TAKE.sidecar?.file)
    expect(m.sends.at(-1)?.url).toContain('.json')
  })

  it('does not upload the sidecar when the footage failed', async () => {
    const { hub, log } = fakeHub()
    const m = rig(hub, {
      sendPart: async () => {
        throw new Error('the storage refused the part (HTTP 503)')
      },
    })
    await requestAndWait(m, ONE_TAKE.file)

    expect(log.begin.map((b) => b.kind)).toEqual(['rush'])
    expect(m.uploads.view().entries[0]?.error).toContain('503')
  })

  it('sets aside a take still being written', async () => {
    const { hub, log } = fakeHub()
    const m = rig(hub, {}, [{ ...ONE_TAKE, beingWritten: true }])
    await requestAndWait(m, null)

    // Uploading a file OBS is still writing would produce, at the storage,
    // truncated footage that looks complete — the worse of the two outcomes.
    expect(log.begin).toHaveLength(0)
  })

  it('does not re-upload what is already at the storage', async () => {
    const { hub, log } = fakeHub()
    const m = rig(hub)
    await requestAndWait(m, ONE_TAKE.file)
    const firstCount = log.begin.length

    await requestAndWait(m, null)
    expect(log.begin).toHaveLength(firstCount)
  })
})

describe('the throughput ceiling', () => {
  it('waits between two parts to hold the requested average', async () => {
    const { hub } = fakeHub()
    let clock = 0
    const m = rig(hub, {
      policy: () => ({ ...DEFAULT_VOD_POLICY, actif: true, debitMaxOctetsS: PART / 2 }),
      // Each send takes a second; the ceiling allows two per part.
      now: () => (clock += 500),
    })
    await requestAndWait(m, ONE_TAKE.file)

    // An 8 MB part under a 4 MB/s ceiling must take two seconds: sent in one, we
    // wait out the difference. Coarse-grained, but the part size sets that, and it
    // is visible in the console.
    expect(m.waits.length).toBeGreaterThan(0)
    expect(m.waits.every((ms) => ms > 0)).toBe(true)
  })

  it('does not wait when no ceiling is set', async () => {
    const { hub } = fakeHub()
    const m = rig(hub)
    await requestAndWait(m, ONE_TAKE.file)
    expect(m.waits).toEqual([])
  })
})

describe('what prevents an upload', () => {
  it('defers without sending anything during a recording, and says why', async () => {
    const { hub, log } = fakeHub()
    const m = rig(hub, { recording: () => true })
    await requestAndWait(m, ONE_TAKE.file)

    expect(log.begin).toHaveLength(0)
    const view = m.uploads.view()
    expect(view.verdict.allowed).toBe(false)
    // The reason is carried all the way to the screen: a silent wait reads as a
    // dead button, and the operator clicks again.
    expect(view.verdict.text).toContain('enregistrement')
  })

  it('sends nothing while the hub is unreachable', async () => {
    const m = rig(null)
    await requestAndWait(m, ONE_TAKE.file)
    expect(m.sends).toHaveLength(0)
    expect(m.uploads.view().entries[0]?.state).toBe('attente')
  })

  it('does not leave on its own when automatic mode is off', async () => {
    const { hub, log } = fakeHub()
    const m = rig(hub, { policy: () => DEFAULT_VOD_POLICY })
    await m.uploads.pass()
    expect(log.begin).toHaveLength(0)
  })

  it('leaves on its own when the hub has enabled it', async () => {
    const { hub, log } = fakeHub()
    const m = rig(hub)
    await m.uploads.pass()
    expect(log.begin.map((b) => b.kind)).toEqual(['rush', 'sidecar'])
  })
})

describe('cancelling', () => {
  it('stops between two parts and asks the hub to abort', async () => {
    const { hub, log } = fakeHub()
    let m: Rig
    const target = rig(hub, {
      sendPart: async (url, body) => {
        // Cancelled mid-upload, like a click in the control app.
        void m.uploads.cancel(ONE_TAKE.file)
        return `"etag-${body.byteLength}"`
      },
    })
    m = target
    await requestAndWait(target, ONE_TAKE.file)

    // One more part, not the whole footage: that is what makes the cancellation
    // effective in seconds rather than at the end of a three-gigabyte file.
    expect(target.sends.length).toBeLessThan(4)
    expect(log.complete).toHaveLength(0)
    expect(log.abort).toContain(`up-${ONE_TAKE.file}`)
    expect(target.uploads.view().entries[0]?.state).toBe('abandonne')
  })
})

describe('the control app view', () => {
  it('gives a usable percentage, and the error when there is one', async () => {
    const { hub } = fakeHub()
    const m = rig(hub)
    await requestAndWait(m, ONE_TAKE.file)

    const [entry] = m.uploads.view().entries
    expect(entry?.state).toBe('termine')
    expect(entry?.percent).toBe(100)
    expect(entry?.error).toBeNull()
  })

  it('forgets the files the disk no longer has', async () => {
    const { hub } = fakeHub()
    let present: VodCandidate[] = [ONE_TAKE]
    const m = rig(hub, { candidates: async () => present })
    await requestAndWait(m, ONE_TAKE.file)
    expect(m.uploads.view().entries.length).toBeGreaterThan(0)

    // The footage was deleted after being brought home: "terminé" on a missing
    // file would clutter the modal all day long.
    present = []
    await m.uploads.forgetMissing()
    expect(m.uploads.view().entries).toEqual([])
  })
})

describe('when the storage does not answer', () => {
  /** A port just closed again: it refuses, it does not keep you waiting. */
  async function closedPort(): Promise<number> {
    const { createServer } = await import('node:net')
    const server = createServer()
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const port = (server.address() as { port: number }).port
    await new Promise<void>((ok) => server.close(() => ok()))
    return port
  }

  it('names the host and the errno reason, not "fetch failed"', async () => {
    // The message Node puts on its transport failures says neither what was being
    // aimed at nor why it did not answer. In the control room, on an event
    // evening, "fetch failed" on five takes sends people looking for the fault
    // everywhere but where it is.
    const port = await closedPort()
    const { hub } = fakeHub()
    // The real network path, with no `sendPart`: it is the one we want to see
    // fail, and it is the one that builds the message.
    const m = rig(hub, { sendPart: undefined })
    const localUrl = (numero: number) => `http://127.0.0.1:${port}/part/${numero}`
    hub.parts = async (_id, numbers) =>
      numbers.map((numero) => ({
        numero,
        url: localUrl(numero),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }))

    await requestAndWait(m, ONE_TAKE.file)

    const error = m.uploads.view().entries[0]?.error ?? ''
    expect(error).toContain('Stockage injoignable')
    // The host aimed at, without the signature or the address's credentials: a
    // room's log gets read by more than one person.
    expect(error).toContain(`127.0.0.1:${port}`)
    expect(error).not.toContain('X-Amz-Signature')
    // And an errno reason, which tells a service that is off from a name that
    // cannot be found or a firewall that leaves you hanging — three failures that
    // are not fixed in the same place. Which one exactly depends on the system:
    // what matters is that there be one, where "fetch failed" confused them all.
    expect(error).toMatch(/E[A-Z]{4,}/)
  })
})
