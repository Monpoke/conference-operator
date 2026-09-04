import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import VodView from '../src/views/VodView.vue'
import { progress, useVodStore } from '../src/stores/vod.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * Téléversements des captations.
 *
 * Cette vue se regarde à un moment précis : juste avant de démonter une salle,
 * quand son disque est encore branché. Ce qui compte donc, c'est qu'elle dise
 * la vérité sur ce qui reste à rapatrier — et qu'elle refuse clairement une
 * demande qu'elle ne saurait pas adresser.
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

async function monter(uploads: unknown[] = []): Promise<{
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
  it('ne dépasse pas cent pour cent quand le fichier grossit en route', () => {
    // Une captation en cours grandit pendant qu'elle part : sans borne,
    // l'avancement affichait 137 %.
    expect(progress({ ...EN_COURS, sizeBytes: 100, bytesSent: 137 })).toBe(100)
  })

  it('ne divise pas par une taille inconnue', () => {
    expect(progress({ ...EN_COURS, sizeBytes: 0, bytesSent: 0 })).toBe(0)
  })
})

describe('vue VOD', () => {
  it('dit qu’il n’y a rien plutôt que de laisser un tableau vide', async () => {
    const { wrapper } = await monter([])
    expect(wrapper.get('#vod-lignes').text()).toContain('Aucun téléversement')
  })

  it('montre l’avancement et le débit, qui disent si ça avance', async () => {
    const { wrapper } = await monter([EN_COURS])
    const ligne = wrapper.get('[data-upload="rush-01.mkv"]')

    expect(ligne.text()).toContain('25 %')
    expect(ligne.text()).toContain('2 Ko/s')
  })

  it('reprend l’erreur du stockage telle quelle', async () => {
    const { wrapper } = await monter([{ ...EN_COURS, state: 'echoue', lastError: 'AccessDenied' }])

    // « AccessDenied » est le seul mot qu'on puisse porter à qui tient le
    // bucket : le traduire ferait perdre la seule prise sur le problème.
    expect(wrapper.get('[data-upload="rush-01.mkv"]').text()).toContain('AccessDenied')
  })

  it('ne propose pas de relancer ce qui est déjà arrivé', async () => {
    const { wrapper } = await monter([{ ...EN_COURS, state: 'termine' }])
    expect(wrapper.find('[data-upload="rush-01.mkv"] button').exists()).toBe(false)
  })

  it('relance un fichier précis', async () => {
    const { calls, wrapper } = await monter([EN_COURS])

    await wrapper.get('[data-upload="rush-01.mkv"] button').trigger('click')
    await flushPromises()

    expect(calls).toContainEqual({
      path: 'vod/request',
      input: { roomId: 'track-1', file: 'rush-01.mkv' },
    })
  })

  it('refuse « tout relancer » sans salle, au lieu de ne rien faire', async () => {
    const { calls, wrapper } = await monter([EN_COURS])

    await wrapper.get('#btn-vod-relancer').trigger('click')
    await flushPromises()

    // La demande vise une machine : sans salle, il n'y a personne à qui parler.
    expect(calls.filter((appel) => appel.path === 'vod/request')).toHaveLength(0)
  })

  it('rapatrie toute une salle une fois celle-ci choisie', async () => {
    const { calls, wrapper } = await monter([EN_COURS])

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
