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

function fakeClient(pending: unknown[]): { calls: Call[]; client: ReturnType<typeof build> } {
  const calls: Call[] = []
  function build() {
    return {
      token: { read: () => 'jeton', write: () => {}, clear: () => {} },
      rpc: {
        wall: {
          pending: async (input: unknown) => {
            calls.push({ path: 'wall/pending', input })
            return pending
          },
          moderate: async (input: unknown) => {
            calls.push({ path: 'wall/moderate', input })
            return { ok: true }
          },
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

function mountView(pending: unknown[]): { calls: Call[]; wrapper: ReturnType<typeof mount> } {
  const fake = fakeClient(pending)
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

  it('affiche ce que le message dit, son auteur et sa provenance', async () => {
    const { wrapper } = mountView([MESSAGE])
    await useModerationStore().load()
    await flushPromises()

    const carte = wrapper.get(`[data-message="${MESSAGE.id}"]`)
    expect(carte.text()).toContain('Bravo pour ce talk !')
    expect(carte.text()).toContain('Camille')
    expect(carte.text()).toContain('mur')
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

  it('rejette par le second bouton, jamais par le premier', async () => {
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
    // soon as two operators moderate at once. A single source of truth, and
    // c'est le hub.
    expect(calls.filter((call) => call.path === 'wall/pending')).toHaveLength(2)
  })
})
