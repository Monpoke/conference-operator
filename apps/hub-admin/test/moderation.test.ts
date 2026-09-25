import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ModerationView from '../src/views/ModerationView.vue'
import { useModerationStore } from '../src/stores/moderation.js'
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

function fakeClient(pending: unknown[], screen: unknown[] = []): { calls: Call[]; client: ReturnType<typeof build> } {
  const calls: Call[] = []
  const note = (path: string, result: unknown) => async (input: unknown = undefined) => {
    calls.push({ path, input })
    return result
  }
  function build() {
    return {
      token: { read: () => 'jeton', write: () => {}, clear: () => {} },
      rpc: {
        wall: {
          pending: note('wall/pending', pending),
          onScreen: note('wall/onScreen', { revision: 'r', posts: screen }),
          moderate: note('wall/moderate', { ok: true }),
          feature: note('wall/feature', { ok: true }),
          save: note('wall/save', {}),
        },
        boucle: {
          previews: note('boucle/previews', {}),
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
  createdAt: '2026-10-30T09:59:00Z',
}

function mountView(pending: unknown[], screen: unknown[] = []): { calls: Call[]; wrapper: ReturnType<typeof mount> } {
  const fake = fakeClient(pending, screen)
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
  it('says there is nothing to review rather than leave a blank', async () => {
    const { wrapper } = mountView([])
    await useModerationStore().load()
    await flushPromises()

    expect(wrapper.get('#moderation').text()).toContain('Rien à relire')
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
    expect(calls.filter((call) => call.path === 'wall/pending')).toHaveLength(2)
  })

  it('puts a post forward, and hides one from the screens', async () => {
    const post = {
      ...MESSAGE,
      source: 'wallsio',
      authorSubtitle: null,
      avatar: null,
      image: null,
      network: 'Instagram',
      permalink: null,
      featured: false,
      pinned: false,
      sponsor: null,
    }
    const { calls, wrapper } = mountView([], [post])
    await useModerationStore().load()
    await flushPromises()

    const card = wrapper.get(`[data-post="${MESSAGE.id}"]`)
    expect(card.text()).toContain('walls.io')
    await card.get('[data-role="feature"]').trigger('click')
    await flushPromises()
    expect(calls).toContainEqual({ path: 'wall/feature', input: { id: MESSAGE.id, featured: true } })

    await wrapper.get(`[data-post="${MESSAGE.id}"] [data-role="hide"]`).trigger('click')
    await flushPromises()
    expect(calls).toContainEqual({ path: 'wall/moderate', input: { id: MESSAGE.id, decision: 'reject' } })
  })

  it('does not offer to unfeature what walls.io pinned', async () => {
    const pinned = {
      ...MESSAGE, source: 'wallsio', authorSubtitle: null, avatar: null, image: null, network: null,
      permalink: null, featured: true, pinned: true, sponsor: null,
    }
    const { wrapper } = mountView([], [pinned])
    await useModerationStore().load()
    await flushPromises()

    const card = wrapper.get(`[data-post="${MESSAGE.id}"]`)
    expect(card.text()).toContain('épinglé sur walls.io')
    expect(card.find('[data-role="unfeature"]').exists()).toBe(false)
  })

  it('writes a partner post', async () => {
    const { calls, wrapper } = mountView([])
    await useModerationStore().load()
    await flushPromises()

    await wrapper.get('#hub-post-author').setValue('APE Factory')
    await wrapper.get('#hub-post-text').setValue('Le café est servi')
    await wrapper.get('#hub-post-sponsor').setValue('APE Factory')
    await wrapper.get('#btn-hub-post').trigger('click')
    await flushPromises()

    const sent = calls.find((call) => call.path === 'wall/save')?.input as Record<string, unknown>
    expect(sent).toMatchObject({
      author: 'APE Factory',
      text: 'Le café est servi',
      sponsor: { name: 'APE Factory', logo: null },
      featured: true,
    })
  })
})
