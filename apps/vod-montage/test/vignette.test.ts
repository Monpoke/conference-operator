import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vignettePage } from '../src/vignette.js'

const HABILLAGE = {
  event: { name: 'Mon Événement', date: '30 octobre 2026', logoUrl: null },
  talk: { title: 'Mon <talk>', category: null, color: null },
  speakers: [{ name: 'Alice', company: null, photoUrl: 'https://photos.test/refusee.jpg' }],
  merci: '',
  sponsorPages: [],
  theme: null,
}

describe('the page of a thumbnail', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vignette-'))
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }))
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  it('names the talk, its date and its speakers, and does without a photo it cannot get', async () => {
    const { html, size } = await vignettePage({ cle: 'job', habillage: HABILLAGE, lieu: null }, dir)
    expect(html).toContain('Mon &lt;talk&gt;')
    expect(html).toContain('30 octobre 2026')
    expect(html).toContain('Alice')
    expect(html).not.toContain('photos.test')
    expect(size.width * size.scale).toBe(1280)
  })

  it('gives the playlist the square YouTube asks, with when and where', async () => {
    const { html, size } = await vignettePage({ cle: 'playlist', habillage: HABILLAGE, lieu: 'Université' }, dir)
    expect(size.width).toBe(size.height)
    expect(html).toContain('Université')
    expect(html).toContain('30 octobre 2026')
  })
})
