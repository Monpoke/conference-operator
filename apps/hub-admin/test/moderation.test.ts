import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ModerationView from '../src/views/ModerationView.vue'
import { joursResumes, useModerationStore } from '../src/stores/moderation.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * Wall moderation, mounted against the real store.
 *
 * What these tests protect is the chain a click travels: button → store →
 * procedure, and the list the operator ends up looking at. So the stub goes at
 * the **transport** and nowhere above it — replacing the store with a fake one
 * would remove exactly the coupling worth keeping.
 *
 * The assertions address elements by `id` on purpose. Those identifiers are a
 * three-headed contract — the tests, the preview scripts, and whoever is
 * debugging in a corridor during an event — and they were carried over
 * unchanged from the string template so that a migration does not silently
 * become a rename.
 */

interface Call {
  path: string
  input: unknown
}

type View = 'pending' | 'approved' | 'rejected'

const SPONSORS = [
  { key: 'nova-atelier.test', name: 'NOVA Atelier', website: 'https://nova-atelier.test', logoPreview: null, tiers: ['Gold'] },
]

/**
 * The hub, as far as this view reads it: `wall.list` answers from the posts
 * given, filtered by view and by the search, a page at a time.
 */
function fakeClient(posts: unknown[]): { calls: Call[]; client: ReturnType<typeof build> } {
  const calls: Call[] = []
  const note = (path: string, result: (input: any) => unknown) => async (input: unknown = undefined) => {
    calls.push({ path, input })
    return result(input)
  }
  const list = (input: { view: View; q: string; page: number; pageSize: number }) => {
    const matching = (posts as { status: View; text: string; author: string }[]).filter(
      (post) => input.q === '' || `${post.text} ${post.author}`.toLowerCase().includes(input.q.toLowerCase()),
    )
    const inView = matching.filter((post) => post.status === input.view)
    const count = (view: View) => matching.filter((post) => post.status === view).length
    return {
      items: inView.slice((input.page - 1) * input.pageSize, input.page * input.pageSize),
      total: inView.length,
      page: input.page,
      pageSize: input.pageSize,
      counts: { pending: count('pending'), approved: count('approved'), rejected: count('rejected') },
    }
  }
  function build() {
    return {
      token: { read: () => 'jeton', write: () => {}, clear: () => {} },
      rpc: {
        wall: {
          list: note('wall/list', list),
          sponsors: note('wall/sponsors', () => SPONSORS),
          moderate: note('wall/moderate', () => ({ ok: true })),
          feature: note('wall/feature', () => ({ ok: true })),
          forceOnScreen: note('wall/forceOnScreen', () => ({ ok: true })),
          save: note('wall/save', () => ({})),
          stats: note('wall/stats', () => STATS),
        },
        boucle: {
          previews: note('boucle/previews', () => ({})),
        },
      },
    }
  }
  return { calls, client: build() }
}

const MESSAGE = {
  id: '01JB2ZK5T7QW9V0YHRXM3N4P6C',
  text: 'Bravo pour ce talk !',
  author: 'Camille',
  source: 'mur',
  status: 'pending',
  createdAt: '2026-10-30T09:59:00Z',
  authorSubtitle: null,
  avatar: null,
  image: null,
  network: null,
  permalink: null,
  featured: false,
  pinned: false,
  sponsor: null,
  onScreen: false,
  impressions: 0,
  lastShownAt: null,
  onlineViews: 0,
  lastSeenOnlineAt: null,
  inactiveAtSource: false,
  forcedOnScreen: false,
}

const POST = {
  ...MESSAGE,
  id: '01JB2ZK5T7QW9V0YHRXM3N4P7D',
  source: 'wallsio',
  status: 'approved',
  network: 'Instagram',
  onScreen: true,
  impressions: 42,
  lastShownAt: '2026-10-30T10:30:00Z',
}

const STATS = {
  generatedAt: '2026-10-30T10:30:00Z',
  posts: {
    total: 3,
    byNetwork: [{ label: 'Instagram', count: 2 }, { label: 'form', count: 1 }],
    byDay: [{ day: '2026-10-30', count: 3 }],
    byMedia: { video: 1, photo: 1, text: 1 },
  },
  impressions: { total: 42, top: [{ id: 'p1', author: 'Bruno', network: 'Instagram', text: 'La salle est pleine', count: 42 }] },
  onlineViews: { total: 0, top: [] },
  wallsio: null,
  wallsioError: 'Aucun jeton walls.io : à régler dans Réglages.',
  adressePublique: 'https://mur.example/',
}

function mountView(posts: unknown[]): { calls: Call[]; wrapper: ReturnType<typeof mount> } {
  const fake = fakeClient(posts)
  const session = useSessionStore()
  // The store owns the client so that the expired-session branch lives in one
  // place; a test swaps it here, at the same seam.
  session.client = fake.client as unknown as typeof session.client
  const wrapper = mount(ModerationView, { attachTo: document.body })
  return { calls: fake.calls, wrapper }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  })
})

describe('moderation view', () => {
  it('opens the figures in place of the lists, walls.io’s failure said in words', async () => {
    const { wrapper, calls } = mountView([])
    await wrapper.get('#wall-tab-stats').trigger('click')
    await flushPromises()

    expect(calls.some((call) => call.path === 'wall/stats')).toBe(true)
    expect(wrapper.find('#wall-posts').exists()).toBe(false)
    expect(wrapper.get('[data-stat="impressions"]').text()).toContain('42')
    expect(wrapper.get('#wall-stats-mots').attributes('href')).toBe('https://mur.example/mots')
    expect(wrapper.get('[data-block="networks"]').text()).toContain('Public (formulaire)')
    expect(wrapper.get('[data-block="top-impressions"]').text()).toContain('La salle est pleine')
    expect(wrapper.get('[data-role="wallsio-error"]').text()).toContain('Aucun jeton')
    expect(wrapper.find('[data-role="interactions"]').exists()).toBe(true)

    await wrapper.get('#wall-tab-pending').trigger('click')
    await flushPromises()
    expect(wrapper.find('#wall-stats').exists()).toBe(false)
  })

  it('says there is nothing to review rather than leave a blank', async () => {
    const { wrapper } = mountView([])
    await useModerationStore().load()
    await flushPromises()

    expect(wrapper.get('#wall-posts').text()).toContain('Rien à relire')
  })

  it('shows what the message says, its author and where it came from', async () => {
    const { wrapper } = mountView([MESSAGE])
    await useModerationStore().load()
    await flushPromises()

    const card = wrapper.get(`[data-message="${MESSAGE.id}"]`)
    expect(card.text()).toContain('Bravo pour ce talk !')
    expect(card.text()).toContain('Camille')
    expect(card.text()).toContain('mur')
  })

  it('publishes the message the operator pointed at', async () => {
    const { calls, wrapper } = mountView([MESSAGE])
    await useModerationStore().load()
    await flushPromises()

    await wrapper.get(`[data-message="${MESSAGE.id}"]`).findAll('button')[0]!.trigger('click')
    await flushPromises()

    expect(calls).toContainEqual({
      path: 'wall/moderate',
      input: { id: MESSAGE.id, decision: 'approve' },
    })
  })

  it('rejects with the second button, never with the first', async () => {
    const { calls, wrapper } = mountView([MESSAGE])
    await useModerationStore().load()
    await flushPromises()

    await wrapper.get(`[data-message="${MESSAGE.id}"]`).findAll('button')[1]!.trigger('click')
    await flushPromises()

    expect(calls).toContainEqual({
      path: 'wall/moderate',
      input: { id: MESSAGE.id, decision: 'reject' },
    })
  })

  it('reads the list back after a decision, instead of patching it in place', async () => {
    const { calls, wrapper } = mountView([MESSAGE])
    await useModerationStore().load()
    await flushPromises()

    await wrapper.get(`[data-message="${MESSAGE.id}"]`).findAll('button')[0]!.trigger('click')
    await flushPromises()

    // Removing the card locally would be enough on screen and would diverge as
    // soon as two operators moderate at once. A single source of truth, and it is
    // the hub.
    expect(calls.filter((call) => call.path === 'wall/list')).toHaveLength(2)
  })

  it('counts each list in its tab, and opens the one asked for', async () => {
    const { calls, wrapper } = mountView([MESSAGE, POST])
    await useModerationStore().load()
    await flushPromises()

    expect(wrapper.get('[data-count="pending"]').text()).toBe('1')
    expect(wrapper.get('[data-count="approved"]').text()).toBe('1')
    expect(wrapper.find(`[data-post="${POST.id}"]`).exists()).toBe(false)

    await wrapper.get('#wall-tab-approved').trigger('click')
    await flushPromises()

    expect(calls.at(-1)).toMatchObject({ path: 'wall/list', input: { view: 'approved', page: 1 } })
    expect(wrapper.find(`[data-post="${POST.id}"]`).exists()).toBe(true)
    expect(wrapper.find(`[data-message="${MESSAGE.id}"]`).exists()).toBe(false)
  })

  it('searches once typing pauses, from the first page', async () => {
    vi.useFakeTimers()
    try {
      const many = Array.from({ length: 25 }, (_, i) => ({ ...MESSAGE, id: `m${i}` }))
      const { calls, wrapper } = mountView([...many, { ...MESSAGE, id: 'autre', text: 'Où est le café ?' }])
      await useModerationStore().load()
      await useModerationStore().goTo(2)
      await flushPromises()

      await wrapper.get('#wall-search').setValue('caf')
      await wrapper.get('#wall-search').setValue('café')
      const before = calls.filter((call) => call.path === 'wall/list').length
      await vi.advanceTimersByTimeAsync(300)
      await flushPromises()

      const searches = calls.filter((call) => call.path === 'wall/list').slice(before)
      // One request for the pause, not one per key.
      expect(searches).toHaveLength(1)
      expect(searches[0]!.input).toMatchObject({ q: 'café', page: 1 })
      expect(wrapper.find('[data-message="autre"]').exists()).toBe(true)
      expect(wrapper.find('[data-message="m0"]').exists()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pages through a long list', async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ ...MESSAGE, id: `m${i}`, text: `Message ${i}` }))
    const { calls, wrapper } = mountView(many)
    await useModerationStore().load()
    await flushPromises()

    expect(wrapper.findAll('[data-message]')).toHaveLength(20)
    expect(wrapper.get('#wall-pages').text()).toContain('Page 1 sur 3')
    expect(wrapper.get('[data-role="previous"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-role="next"]').trigger('click')
    await flushPromises()

    expect(calls.at(-1)).toMatchObject({ path: 'wall/list', input: { page: 2 } })
    expect(wrapper.get('#wall-pages').text()).toContain('Page 2 sur 3')
    expect(wrapper.get('[data-message]').attributes('data-message')).toBe('m20')
  })

  it('says how many times a post was put on air', async () => {
    const { wrapper } = mountView([
      POST,
      { ...POST, id: 'neuf', impressions: 0, lastShownAt: null },
      { ...POST, id: 'en-ligne', impressions: 0, lastShownAt: null, onlineViews: 7, lastSeenOnlineAt: '2026-10-30T10:40:00Z' },
    ])
    await useModerationStore().show('approved')
    await flushPromises()

    expect(wrapper.get(`[data-post="${POST.id}"] [data-role="impressions"]`).text()).toContain('42 affichages')
    expect(wrapper.get('[data-post="neuf"] [data-role="impressions"]').text()).toBe('jamais affiché')
    // Seen on the public page only: its views, apart from the rooms'.
    const online = wrapper.get('[data-post="en-ligne"] [data-role="impressions"]').text()
    expect(online).toContain('7 vues')
    expect(online).not.toContain('affichage')
  })

  it('shows a post walls.io deactivated, and gives it back', async () => {
    const masque = { ...POST, id: 'masque', onScreen: false, inactiveAtSource: true }
    const force = { ...POST, id: 'force', inactiveAtSource: true, forcedOnScreen: true }
    const { calls, wrapper } = mountView([POST, masque, force])
    await useModerationStore().show('approved')
    await flushPromises()

    // An ordinary post offers neither: walls.io has it on.
    expect(wrapper.find(`[data-post="${POST.id}"] [data-role="force"]`).exists()).toBe(false)
    expect(wrapper.find('[data-post="masque"] [data-role="inactive-at-source"]').exists()).toBe(true)
    expect(wrapper.find('[data-post="force"] [data-role="forced"]').exists()).toBe(true)

    await wrapper.get('[data-post="masque"] [data-role="force"]').trigger('click')
    await flushPromises()
    expect(calls).toContainEqual({ path: 'wall/forceOnScreen', input: { id: 'masque', forced: true } })

    await wrapper.get('[data-post="force"] [data-role="unforce"]').trigger('click')
    await flushPromises()
    expect(calls).toContainEqual({ path: 'wall/forceOnScreen', input: { id: 'force', forced: false } })
  })

  it('puts a post forward, and hides one from the screens', async () => {
    const { calls, wrapper } = mountView([POST])
    await useModerationStore().show('approved')
    await flushPromises()

    const card = wrapper.get(`[data-post="${POST.id}"]`)
    expect(card.text()).toContain('walls.io')
    await card.get('[data-role="feature"]').trigger('click')
    await flushPromises()
    expect(calls).toContainEqual({ path: 'wall/feature', input: { id: POST.id, featured: true } })

    await wrapper.get(`[data-post="${POST.id}"] [data-role="hide"]`).trigger('click')
    await flushPromises()
    expect(calls).toContainEqual({ path: 'wall/moderate', input: { id: POST.id, decision: 'reject' } })
  })

  it('does not offer to unfeature what walls.io pinned', async () => {
    const pinned = { ...POST, featured: true, pinned: true }
    const { wrapper } = mountView([pinned])
    await useModerationStore().show('approved')
    await flushPromises()

    const card = wrapper.get(`[data-post="${POST.id}"]`)
    expect(card.text()).toContain('épinglé sur walls.io')
    expect(card.find('[data-role="unfeature"]').exists()).toBe(false)
  })

  it('links a post to where it was written, never to a script', async () => {
    const { wrapper } = mountView([
      { ...POST, permalink: 'https://www.instagram.com/p/abc/' },
      { ...POST, id: 'bsky', source: 'bluesky', network: null, permalink: 'https://bsky.app/profile/a/post/1' },
      { ...POST, id: 'piege', permalink: 'javascript:alert(1)' },
      { ...POST, id: 'sans', permalink: null },
    ])
    await useModerationStore().show('approved')
    await flushPromises()

    const link = wrapper.get(`[data-post="${POST.id}"] [data-role="permalink"]`)
    expect(link.attributes('href')).toBe('https://www.instagram.com/p/abc/')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
    expect(link.text()).toContain('voir sur Instagram')
    expect(wrapper.get('[data-post="bsky"] [data-role="permalink"]').text()).toContain('voir sur bluesky')
    expect(wrapper.find('[data-post="piege"] [data-role="permalink"]').exists()).toBe(false)
    expect(wrapper.find('[data-post="sans"] [data-role="permalink"]').exists()).toBe(false)
  })

  it('brings back a post rejected by mistake', async () => {
    const { calls, wrapper } = mountView([{ ...POST, status: 'rejected' }])
    await useModerationStore().show('rejected')
    await flushPromises()

    await wrapper.get(`[data-post="${POST.id}"] [data-role="restore"]`).trigger('click')
    await flushPromises()
    expect(calls).toContainEqual({ path: 'wall/moderate', input: { id: POST.id, decision: 'approve' } })
  })

  it('keeps the writing form folded until asked for', async () => {
    const { wrapper } = mountView([])
    await useModerationStore().load()
    await flushPromises()

    expect(wrapper.find('#hub-post').exists()).toBe(false)
    await wrapper.get('#btn-compose').trigger('click')
    await flushPromises()
    expect(wrapper.find('#hub-post').exists()).toBe(true)

    await wrapper.get('#btn-hub-post-cancel').trigger('click')
    await flushPromises()
    expect(wrapper.find('#hub-post').exists()).toBe(false)
  })

  it('writes a sponsored post attached to a partner of the program', async () => {
    const { calls, wrapper } = mountView([])
    await useModerationStore().load()
    await flushPromises()

    await wrapper.get('#btn-compose').trigger('click')
    await flushPromises()
    await wrapper.get('#hub-post-sponsor').setValue('nova-atelier.test')
    // The partner's name comes as the author when none was typed.
    expect((wrapper.get('#hub-post-author').element as HTMLInputElement).value).toBe('NOVA Atelier')
    await wrapper.get('#hub-post-text').setValue('Le café est servi')
    await wrapper.get('#btn-hub-post').trigger('click')
    await flushPromises()

    const sent = calls.find((call) => call.path === 'wall/save')?.input as Record<string, unknown>
    expect(sent).toMatchObject({
      author: 'NOVA Atelier',
      text: 'Le café est servi',
      sponsor: { key: 'nova-atelier.test', name: 'NOVA Atelier', logo: null },
      featured: true,
    })
    expect(wrapper.find('#hub-post').exists()).toBe(false)
  })

  it('writes a post of the event with no partner', async () => {
    const { calls, wrapper } = mountView([])
    await useModerationStore().load()
    await flushPromises()

    await wrapper.get('#btn-compose').trigger('click')
    await flushPromises()
    await wrapper.get('#hub-post-author').setValue('Cloud Nord')
    await wrapper.get('#hub-post-text').setValue('La keynote commence dans 5 minutes')
    await wrapper.get('#btn-hub-post').trigger('click')
    await flushPromises()

    const sent = calls.find((call) => call.path === 'wall/save')?.input as Record<string, unknown>
    expect(sent).toMatchObject({ author: 'Cloud Nord', sponsor: null })
  })
})

describe('the wall figures by day', () => {
  const day = (n: number, count: number) => ({ day: `2026-10-${String(n).padStart(2, '0')}`, count })

  it('leaves a short list alone', () => {
    expect(joursResumes([day(1, 1), day(2, 2)])).toEqual({ detail: [day(1, 1), day(2, 2)], autres: null })
  })

  it('keeps the busiest days in calendar order, and the rest on one line', () => {
    const days = Array.from({ length: 10 }, (_, i) => day(i + 1, i === 0 ? 50 : i))
    const { detail, autres } = joursResumes(days)
    expect(detail.map((entry) => entry.day)).toEqual(['2026-10-01', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'])
    expect(autres).toEqual({ jours: 3, count: 1 + 2 + 3 })
  })
})
