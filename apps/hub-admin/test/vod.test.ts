import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import VodView from '../src/views/VodView.vue'
import { progress, useVodStore } from '../src/stores/vod.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * Uploads of the takes.
 *
 * This view is looked at at a precise moment: just before dismantling a room,
 * while its disk is still plugged in. What counts is therefore that it tells the
 * truth about what is left to bring home — and that it clearly refuses a request
 * it would not know where to address.
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
        vod: { uploads: note('vod/uploads', uploads), request: note('vod/request', { ok: true }) },
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

const EN_COURS = {
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
    // Une captation en cours grandit pendant qu'elle part : sans borne,
    // l'avancement affichait 137 %.
    expect(progress({ ...EN_COURS, sizeBytes: 100, bytesSent: 137 })).toBe(100)
  })

  it('ne divise pas par une taille inconnue', () => {
    expect(progress({ ...EN_COURS, sizeBytes: 0, bytesSent: 0 })).toBe(0)
  })
})

describe('vue VOD', () => {
  it('says there is nothing rather than leave an empty table', async () => {
    const { wrapper } = await mountView([])
    expect(wrapper.get('#vod-lignes').text()).toContain('Aucun téléversement')
  })

  it('shows the progress and the rate, which say whether it is moving', async () => {
    const { wrapper } = await mountView([EN_COURS])
    const row = wrapper.get('[data-upload="rush-01.mkv"]')

    expect(row.text()).toContain('25 %')
    expect(row.text()).toContain('2 Ko/s')
  })

  it('reprend l’erreur du stockage telle quelle', async () => {
    const { wrapper } = await mountView([{ ...EN_COURS, state: 'echoue', lastError: 'AccessDenied' }])

    // "AccessDenied" is the only word one can carry to whoever holds the bucket:
    // translating it would lose the only handle on the problem.
    expect(wrapper.get('[data-upload="rush-01.mkv"]').text()).toContain('AccessDenied')
  })

  it('does not offer to retry what has already arrived', async () => {
    const { wrapper } = await mountView([{ ...EN_COURS, state: 'termine' }])
    expect(wrapper.find('[data-upload="rush-01.mkv"] button').exists()).toBe(false)
  })

  it('retries one specific file', async () => {
    const { calls, wrapper } = await mountView([EN_COURS])

    await wrapper.get('[data-upload="rush-01.mkv"] button').trigger('click')
    await flushPromises()

    expect(calls).toContainEqual({
      path: 'vod/request',
      input: { roomId: 'track-1', file: 'rush-01.mkv' },
    })
  })

  it('refuse « tout relancer » sans salle, au lieu de ne rien faire', async () => {
    const { calls, wrapper } = await mountView([EN_COURS])

    await wrapper.get('#btn-vod-relancer').trigger('click')
    await flushPromises()

    // The request targets one machine: with no room there is nobody to talk to.
    expect(calls.filter((call) => call.path === 'vod/request')).toHaveLength(0)
  })

  it('rapatrie toute une salle une fois celle-ci choisie', async () => {
    const { calls, wrapper } = await mountView([EN_COURS])

    await wrapper.get('#vod-room').setValue('track-1')
    await flushPromises()
    await wrapper.get('#btn-vod-relancer').trigger('click')
    await flushPromises()

    expect(calls).toContainEqual({
      path: 'vod/request',
      input: { roomId: 'track-1', file: null },
    })
  })
})
