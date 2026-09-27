// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WallCard } from '@conference-operator/contract'
import type { Data } from '../src/browser/scene.js'
import { wallsio } from '../src/browser/scenes/wallsio.js'

/**
 * The social wall's pages: which posts each one holds, and what it reports as
 * shown. The page is not laid out here (no heights), so every card fits: what
 * is tested is the order, not the geometry.
 */
const post = (id: string, extra: Partial<WallCard> = {}): WallCard => ({
  id,
  source: 'form',
  author: id,
  authorSubtitle: null,
  avatarUrl: null,
  text: `texte ${id}`,
  imageUrl: null,
  network: null,
  postedAt: '2026-10-30T09:00:00Z',
  featured: false,
  sponsor: null,
  ...extra,
})

const sponsored = (id: string) => post(id, { featured: true, sponsor: { name: id, logoUrl: null } })

const data = (posts: WallCard[], wall: { parPage?: number; sponsoriseTous?: number } = {}): Data =>
  ({
    state: { mode: 'boucle', serverTimeOffsetMs: 0 },
    socialWall: posts,
    boucle: {
      wallsio: { titre: 'Le mur', hashtag: '#test', parPage: wall.parPage ?? 5, sponsoriseTous: wall.sponsoriseTous ?? 0 },
      durees: {},
    },
  }) as unknown as Data

/** The posts of the page on screen, head first, then in the order laid. */
const shown = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.carte')].map((c) => c.dataset.post)
/** The featured post leading the page; `null` = none, its column then holds the line too. */
const head = (el: HTMLElement) =>
  el.querySelector('.mur')!.classList.contains('sans-avant')
    ? null
    : (el.querySelector<HTMLElement>('.mur-avant .carte')?.dataset.post ?? null)

let fetched: { counts: Record<string, number> }[]

beforeEach(() => {
  fetched = []
  vi.useFakeTimers()
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    fetched.push(JSON.parse(init.body))
    return { status: 204 }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the social wall', () => {
  it('opens every page with a partner, when none is slotted in', () => {
    const el = document.createElement('div')
    const scene = wallsio(el)
    scene.rendre(data([sponsored('ape'), post('a'), post('b')]))

    expect(head(el)).toBe('ape')
  })

  it('slots a sponsored post in every so many posts, the partners taking turns', () => {
    const el = document.createElement('div')
    const scene = wallsio(el)
    const posts = [sponsored('ape'), sponsored('zen'), ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => post(id))]
    scene.rendre(data(posts, { parPage: 6, sponsoriseTous: 2 }))

    // No head: the partners are in the line, at the size of any card.
    expect(head(el)).toBeNull()
    expect(shown(el)).toEqual(['a', 'b', 'ape', 'c', 'd', 'zen'])
    expect(el.querySelector('[data-post="ape"]')!.classList.contains('en-avant')).toBe(false)

    // The count runs on to the next page.
    scene.quitte!(data(posts, { parPage: 6, sponsoriseTous: 2 }))
    expect(shown(el)).toEqual(['e', 'f', 'ape', 'g', 'h', 'zen'])
  })

  it('keeps a partner at the head when there is nothing to slot it among', () => {
    const el = document.createElement('div')
    const scene = wallsio(el)
    scene.rendre(data([sponsored('ape')], { sponsoriseTous: 3 }))

    expect(head(el)).toBe('ape')
  })

  it('counts a page when it goes live, never when it is laid out off screen', async () => {
    const el = document.createElement('div')
    const scene = wallsio(el)
    const wall = data([post('a'), post('b')])
    scene.rendre(wall)
    scene.quitte!(wall)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetched).toEqual([])

    scene.entre!(wall)
    el.classList.add('is-live')
    // Held on screen by the operator, it is redrawn in place: seen again.
    scene.rendre(wall)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(fetched).toEqual([{ counts: { a: 2, b: 2 } }])
  })
})
