import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { VodHabillage } from '@conference-operator/contract'
import { loadConfig } from '../src/config.js'
import { uploadParts } from '../src/transfer.js'
import { completeFromSidecar } from '../src/worker.js'

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
