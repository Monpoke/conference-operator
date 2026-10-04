import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import VodView from '../src/views/VodView.vue'
import { progress, useVodStore } from '../src/stores/vod.js'
import { useMontageStore } from '../src/stores/montage.js'
import { useConferencesStore } from '../src/stores/conferences.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * Uploads of the takes.
 *
 * This view is looked at at a precise moment: just before dismantling a room,
 * while its disk is still plugged in. What counts is therefore that it tells the
 * truth about what is left to bring home — and that a request for every room
 * reaches every room, one machine at a time.
 */

interface Call {
  path: string
  input: unknown
}

const ROOMS = [
  { id: 'track-1', name: 'Track #1' },
  { id: 'track-2', name: 'Track #2' },
]

function stub(uploads: unknown[]): { calls: Call[]; client: unknown } {
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
        vod: { uploads: note('vod/uploads', uploads), request: note('vod/request', { ok: true }), conference: note('vod/conference', null) },
      },
    },
  }
}

async function mountView(uploads: unknown[] = []): Promise<{
  calls: Call[]
  wrapper: ReturnType<typeof mount>
}> {
  const fake = stub(uploads)
  useSessionStore().client = fake.client as never
  const wrapper = mount(VodView, { attachTo: document.body })
  await useVodStore().load()
  await flushPromises()
  return { calls: fake.calls, wrapper }
}

const IN_PROGRESS = {
  roomId: 'track-1',
  roomName: 'Track #1',
  file: 'rush-01.mkv',
  state: 'en-cours',
  sizeBytes: 1_000,
  bytesSent: 250,
  debitOctetsS: 2_048,
  lastError: null,
}

beforeEach(() => {
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})

describe('avancement', () => {
  it('does not exceed a hundred per cent when the file grows in transit', () => {
    // A running take grows while it is being sent: with no cap, the progress read
    // 137 %.
    expect(progress({ ...IN_PROGRESS, sizeBytes: 100, bytesSent: 137 })).toBe(100)
  })

  it('does not divide by an unknown size', () => {
    expect(progress({ ...IN_PROGRESS, sizeBytes: 0, bytesSent: 0 })).toBe(0)
  })
})

describe('vue VOD', () => {
  it('says there is nothing rather than leave an empty table', async () => {
    const { wrapper } = await mountView([])
    expect(wrapper.get('#vod-rows').text()).toContain('Aucun téléversement')
  })

  it('shows the progress and the rate, which say whether it is moving', async () => {
    const { wrapper } = await mountView([IN_PROGRESS])
    const row = wrapper.get('[data-upload="rush-01.mkv"]')

    expect(row.text()).toContain('25 %')
    expect(row.text()).toContain('2 Ko/s')
  })

  it('reprend l’erreur du stockage telle quelle', async () => {
    const { wrapper } = await mountView([{ ...IN_PROGRESS, state: 'echoue', lastError: 'AccessDenied' }])

    // "AccessDenied" is the only word one can carry to whoever holds the bucket:
    // translating it would lose the only handle on the problem.
    expect(wrapper.get('[data-upload="rush-01.mkv"]').text()).toContain('AccessDenied')
  })

  it('does not offer to retry what has already arrived', async () => {
    const { wrapper } = await mountView([{ ...IN_PROGRESS, state: 'termine' }])
    expect(wrapper.find('[data-upload="rush-01.mkv"] button').exists()).toBe(false)
  })

  it('retries one specific file', async () => {
    const { calls, wrapper } = await mountView([IN_PROGRESS])

    await wrapper.get('[data-upload="rush-01.mkv"] button').trigger('click')
    await flushPromises()

    expect(calls).toContainEqual({
      path: 'vod/request',
      input: { roomId: 'track-1', file: 'rush-01.mkv' },
    })
  })

  it('asks every room when "toutes les salles" is chosen', async () => {
    const { calls, wrapper } = await mountView([IN_PROGRESS])

    await wrapper.get('#btn-vod-retry').trigger('click')
    await flushPromises()

    // The hub only asks one machine at a time: one request per room.
    expect(calls.filter((call) => call.path === 'vod/request').map((call) => call.input)).toEqual([
      { roomId: 'track-1', file: null },
      { roomId: 'track-2', file: null },
    ])
  })

  it('still asks the other rooms when one refuses', async () => {
    const { calls, wrapper } = await mountView([IN_PROGRESS])
    const client = useSessionStore().client as unknown as {
      rpc: { vod: { request: (input: { roomId: string }) => Promise<unknown> } }
    }
    const request = client.rpc.vod.request
    client.rpc.vod.request = async (input) => {
      if (input.roomId === 'track-1') throw new Error('Salle injoignable')
      return request(input)
    }

    await wrapper.get('#btn-vod-retry').trigger('click')
    await flushPromises()

    expect(calls.filter((call) => call.path === 'vod/request').map((call) => call.input)).toEqual([
      { roomId: 'track-2', file: null },
    ])
  })

  it('brings back a whole room once one has been chosen', async () => {
    const { calls, wrapper } = await mountView([IN_PROGRESS])

    await wrapper.get('#vod-room').setValue('track-1')
    await flushPromises()
    await wrapper.get('#btn-vod-retry').trigger('click')
    await flushPromises()

    expect(calls).toContainEqual({
      path: 'vod/request',
      input: { roomId: 'track-1', file: null },
    })
  })
})

describe('a cut to validate, from a phone', () => {
  it('opens the talk\'s VOD folder straight from the montage', async () => {
    await mountView()
    const job = {
      id: 'job-1', sessionId: 'talk-1', title: 'Le talk', state: 'a-valider', tentatives: 1,
      erreur: null, worker: null, marquesManquantes: [], progression: null,
    }
    useMontageStore().jobs = [job, { ...job, id: 'job-2', sessionId: 'talk-2', state: 'termine' }] as never
    useConferencesStore().planning = {
      timezone: 'Europe/Paris',
      sessions: [{ id: 'talk-1', title: 'Le talk', roomId: 'track-1', startsAt: '2026-10-30T09:00:00Z', endsAt: '2026-10-30T09:40:00Z', speakers: [] }],
    } as never
    await flushPromises()

    // Only the cut waiting for its validation offers the gesture.
    const buttons = document.querySelectorAll('[data-valider]')
    expect([...buttons].map((button) => button.getAttribute('data-valider'))).toEqual(['talk-1'])

    ;(buttons[0] as HTMLElement).click()
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Le talk')
  })
})
