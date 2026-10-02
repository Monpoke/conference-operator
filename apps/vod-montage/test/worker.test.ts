import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORPCError } from '@orpc/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MontageClaim, VodHabillage } from '@conference-operator/contract'
import { loadConfig } from '../src/config.js'
import type { Hub } from '../src/hub.js'
import { uploadParts } from '../src/transfer.js'
import { completeFromSidecar, processJob } from '../src/worker.js'

describe('a lease lost to another worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stops the job without failing it — it is another worker’s now', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'bail-perdu-'))
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ videoFile: 'talk.mkv' })))
    const calls: { name: string; input: unknown }[] = []
    const hub = {
      montage: {
        heartbeat: async (input: unknown) => {
          calls.push({ name: 'heartbeat', input })
          return { ok: true, annule: false, bail: new Date().toISOString() }
        },
        fichiers: async (input: unknown) => {
          calls.push({ name: 'fichiers', input })
          throw new ORPCError('CONFLICT', { message: 'ce montage est tenu par un autre worker, ou son bail a expiré' })
        },
        fail: async (input: unknown) => {
          calls.push({ name: 'fail', input })
          return { ok: true }
        },
      },
    } as unknown as Hub
    const lines: string[] = []

    await processJob({
      hub,
      claim: { jobId: 'job-1', bailId: 'bail-1', sidecarUrl: 'https://stockage.example/sidecar.json' } as MontageClaim,
      config: loadConfig({ HUB_URL: 'https://hub.example', HUB_WORKER_TOKEN: 'wt_abc', WORK_DIR: workDir }),
      chrome: null as never,
      log: (_level, message) => lines.push(message),
    })

    expect(calls.find((call) => call.name === 'fichiers')?.input).toMatchObject({ jobId: 'job-1', bailId: 'bail-1' })
    expect(calls.some((call) => call.name === 'fail')).toBe(false)
    expect(lines).toContain('bail perdu : le montage a été repris par un autre worker')
    // Nothing of the take is kept once the job is dropped.
    expect(await readdir(workDir)).toEqual([])
    await rm(workDir, { recursive: true, force: true })
  })
})

describe('the configuration', () => {
  it('refuses a room token, and names the variable', () => {
    expect(() => loadConfig({ HUB_URL: 'https://hub.example', HUB_WORKER_TOKEN: 'rt_abc' })).toThrow(/HUB_WORKER_TOKEN/)
  })

  it('defaults what can be defaulted', () => {
    const config = loadConfig({ HUB_URL: 'https://hub.example', HUB_WORKER_TOKEN: 'wt_abc' })
    expect(config).toMatchObject({ chrome: 'chromium', pollSeconds: 30, uploadConcurrency: 4 })
    expect(config.jingle).toBeUndefined()
  })
})

describe('a talk the program does not know', () => {
  const empty: VodHabillage = {
    event: { name: 'Cloud Nord 2026', date: null, logoUrl: null },
    talk: { title: '', category: null, color: null },
    speakers: [],
    merci: 'Merci',
    sponsorPages: [],
    theme: null,
  }

  it('takes its title and speakers from the take', () => {
    const h = completeFromSidecar(empty, { title: 'Lightning talk', speakers: [{ name: 'Ada', company: 'X' }], category: 'Découverte' })
    expect(h.talk).toMatchObject({ title: 'Lightning talk', category: 'Découverte' })
    expect(h.speakers).toEqual([{ name: 'Ada', company: 'X', photoUrl: null }])
  })

  it('keeps the program’s when it has them', () => {
    const known = { ...empty, talk: { ...empty.talk, title: 'Du programme' }, speakers: [{ name: 'Bob', company: null, photoUrl: 'p.jpg' }] }
    expect(completeFromSidecar(known, { title: 'Du jour', speakers: [], category: null })).toEqual(known)
  })
})

describe('uploading the edited video', () => {
  let dir: string
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('sends each part once, retries a failed one on its own, and returns the ETags in order', async () => {
    dir = await mkdtemp(join(tmpdir(), 'vod-upload-'))
    const file = join(dir, 'v.mp4')
    await writeFile(file, Buffer.alloc(25, 7))

    const received = new Map<number, number>()
    let failedOnce = false
    const fetcher = (async (url: string, init: RequestInit) => {
      const n = Number(new URL(url).searchParams.get('n'))
      if (n === 2 && !failedOnce) {
        failedOnce = true
        return new Response(null, { status: 500 })
      }
      received.set(n, (init.body as Uint8Array).length)
      return new Response(null, { status: 200, headers: { etag: `"e${n}"` } })
    }) as typeof fetch

    const etags = await uploadParts(file, {
      partSize: 10,
      parts: 3,
      sign: async (numeros) => numeros.map((numero) => ({ numero, url: `https://s3.example/o?n=${numero}` })),
    }, { concurrency: 2, fetcher })

    expect(etags).toEqual([{ n: 1, etag: '"e1"' }, { n: 2, etag: '"e2"' }, { n: 3, etag: '"e3"' }])
    expect([...received.entries()].sort()).toEqual([[1, 10], [2, 10], [3, 5]])
  }, 10_000)
})
