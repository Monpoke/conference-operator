import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MessagesView from '../src/views/MessagesView.vue'
import { useMessagesStore } from '../src/stores/messages.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * What the hub addresses to the rooms.
 *
 * Two things are worth holding here, and neither is rendering: the minutes →
 * seconds conversion, written nowhere else, and the warning that says a message is
 * going **in front of the audience**. The second is the only guard between a note
 * to the operator and a note projected in a full room, and it has to be right on
 * the first render — not only after the first interaction, which was the case when
 * it depended on an `onchange`.
 */

interface Call {
  path: string
  input: unknown
}

const ROOMS = [{ id: 'track-1', name: 'Track #1' }]

function stub(): { calls: Call[]; client: unknown } {
  const calls: Call[] = []
  const note =
    (path: string, result: unknown) =>
    async (input: unknown = undefined) => {
      calls.push({ path, input })
      return result
    }
  return {
    calls,
    client: {
      token: { read: () => 'jeton', write: () => {}, clear: () => {} },
      rpc: {
        rooms: { list: note('rooms/list', ROOMS) },
        messages: {
          fromRooms: note('messages/fromRooms', []),
          send: note('messages/send', { ok: true }),
        },
        overlay: {
          history: note('overlay/history', []),
          show: note('overlay/show', { ok: true }),
          hide: note('overlay/hide', { ok: true }),
        },
      },
    },
  }
}

async function mountView(): Promise<{ calls: Call[]; wrapper: ReturnType<typeof mount> }> {
  const fake = stub()
  const session = useSessionStore()
  session.client = fake.client as never
  const wrapper = mount(MessagesView, { attachTo: document.body })
  await useMessagesStore().load()
  await flushPromises()
  return { calls: fake.calls, wrapper }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})

describe('vue des messages', () => {
  it('warns from the first render when the message will go before the audience', async () => {
    const { wrapper } = await mountView()

    // At rest the target is the operator: the warning must already say so.
    expect(wrapper.get('#msg-warning').text()).toContain('bandeau de la régie')

    await wrapper.get('#msg-audience').setValue('audience')
    expect(wrapper.get('#msg-warning').text()).toContain('projeté devant le public')
  })

  it('convertit les minutes saisies en secondes', async () => {
    const { calls, wrapper } = await mountView()

    await wrapper.get('#msg-text').setValue('On reprend dans 5 minutes')
    await wrapper.get('#msg-minutes').setValue('10')
    await wrapper.get('#btn-send-message').trigger('click')
    await flushPromises()

    expect(calls).toContainEqual({
      path: 'messages/send',
      input: {
        roomId: null,
        text: 'On reprend dans 5 minutes',
        level: 'info',
        target: 'operator',
        ttlSeconds: 600,
      },
    })
  })

  it('leaves the message on screen when no duration is given', async () => {
    const { calls, wrapper } = await mountView()

    await wrapper.get('#msg-text').setValue('Sans durée')
    await wrapper.get('#btn-send-message').trigger('click')
    await flushPromises()

    // Empty does not mean zero: it means "until replaced".
    const sent = calls.find((call) => call.path === 'messages/send')
    expect((sent?.input as { ttlSeconds: unknown }).ttlSeconds).toBe(null)
  })

  it('refuse d’envoyer un message vide sans rien appeler', async () => {
    const { calls, wrapper } = await mountView()

    await wrapper.get('#btn-send-message').trigger('click')
    await flushPromises()

    expect(calls.filter((call) => call.path === 'messages/send')).toHaveLength(0)
  })

  it('vise la salle choisie, et elle seule', async () => {
    const { calls, wrapper } = await mountView()

    await wrapper.get('#msg-room').setValue('track-1')
    await flushPromises()
    await wrapper.get('#msg-text').setValue('Pour Track #1')
    await wrapper.get('#btn-send-message').trigger('click')
    await flushPromises()

    const sent = calls.find((call) => call.path === 'messages/send')
    expect((sent?.input as { roomId: unknown }).roomId).toBe('track-1')
  })

  it('fills the field with a template, without putting anything on air', async () => {
    const { calls, wrapper } = await mountView()

    await wrapper.get('#banner-templates').findAll('button')[0]!.trigger('click')
    await flushPromises()

    // A template is a starting point, not a rail: the date, the duration and the
    // room's name change every time.
    expect((wrapper.get('#banner-text').element as HTMLInputElement).value.length).toBeGreaterThan(0)
    expect(calls.filter((call) => call.path === 'overlay/show')).toHaveLength(0)
  })

  it('reads the history back after showing a banner', async () => {
    const { calls, wrapper } = await mountView()

    await wrapper.get('#banner-text').setValue('Le son revient')
    await wrapper.get('#btn-banner-show').trigger('click')
    await flushPromises()

    expect(calls).toContainEqual({
      path: 'overlay/show',
      input: { roomId: null, message: { text: 'Le son revient', level: 'info' }, ttlSeconds: null },
    })
    expect(calls.filter((call) => call.path === 'overlay/history').length).toBeGreaterThan(1)
  })
})
