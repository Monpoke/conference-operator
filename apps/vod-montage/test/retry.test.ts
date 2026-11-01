import { describe, expect, it, vi } from 'vitest'
import { inlineImages } from '../src/images.js'
import { RETRY_ATTEMPTS } from '../src/retry.js'
import { themeForCapture } from '../src/theme.js'

const REF = { sha: 'a'.repeat(64), url: 'https://hub.test/boucle/theme/a.zip' }
const noWait = async () => {}
const BASE = {
  event: { name: 'E', date: null, logoUrl: null },
  talk: { title: 'T', category: null, color: null },
  merci: '',
  sponsorPages: [],
  theme: null,
}
const png = () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })

describe('a hub away while the worker reads it', () => {
  it('tries the theme again, then fails rather than use the default one', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 503 }))
    await expect(themeForCapture(REF, '/tmp/x', () => {}, fetcher as never, noWait)).rejects.toThrow('thème illisible')
    expect(fetcher).toHaveBeenCalledTimes(RETRY_ATTEMPTS)
  })

  it('goes on with a hub image once the hub is back', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockImplementation(async () => png())
    const out = await inlineImages({ ...BASE, speakers: [{ name: 'A', company: null, photoUrl: 'https://hub.test/assets/a.png' }] } as never, () => {}, fetcher as never, noWait)
    expect(out.speakers[0]!.photoUrl).toMatch(/^data:image\/png/)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('fails on a hub image that stays away', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 503 }))
    await expect(inlineImages({ ...BASE, speakers: [{ name: 'A', company: null, photoUrl: 'https://hub.test/assets/a.png' }] } as never, () => {}, fetcher as never, noWait)).rejects.toThrow('503')
  })

  it('keeps the name for an image refused, or from elsewhere, at once', async () => {
    const refused = vi.fn(async () => new Response('', { status: 404 }))
    const gone = await inlineImages({ ...BASE, speakers: [{ name: 'A', company: null, photoUrl: 'https://hub.test/assets/a.png' }] } as never, () => {}, refused as never, noWait)
    expect(gone.speakers[0]!.photoUrl).toBeNull()
    expect(refused).toHaveBeenCalledOnce()

    const elsewhere = vi.fn(async () => new Response('', { status: 503 }))
    const out = await inlineImages({ ...BASE, speakers: [{ name: 'A', company: null, photoUrl: 'https://media.test/a.png' }] } as never, () => {}, elsewhere as never, noWait)
    expect(out.speakers[0]!.photoUrl).toBeNull()
    expect(elsewhere).toHaveBeenCalledOnce()
  })
})
