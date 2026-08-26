import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MessagesView from '../src/views/MessagesView.vue'
import { useMessagesStore } from '../src/stores/messages.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * Ce que le hub adresse aux salles.
 *
 * Deux choses valent d'être tenues ici, et aucune n'est du rendu : la
 * conversion minutes → secondes, qui n'est écrite nulle part ailleurs, et
 * l'avertissement qui dit qu'un message part **devant le public**. Le second
 * est le seul garde-fou entre une note à l'opérateur et une note projetée dans
 * une salle pleine, et il doit être juste au premier rendu — pas seulement
 * après la première interaction, ce qui était le cas quand il dépendait d'un
 * `onchange`.
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

async function monter(): Promise<{ calls: Call[]; wrapper: ReturnType<typeof mount> }> {
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
  it('avertit dès le premier rendu quand le message ira devant le public', async () => {
    const { wrapper } = await monter()

    // Au repos la cible est l'opérateur : l'avertissement doit déjà le dire.
    expect(wrapper.get('#msg-avertissement').text()).toContain('bandeau de la régie')

    await wrapper.get('#msg-cible').setValue('audience')
    expect(wrapper.get('#msg-avertissement').text()).toContain('projeté devant le public')
  })

  it('convertit les minutes saisies en secondes', async () => {
    const { calls, wrapper } = await monter()

    await wrapper.get('#msg-texte').setValue('On reprend dans 5 minutes')
    await wrapper.get('#msg-duree').setValue('10')
    await wrapper.get('#btn-envoyer-message').trigger('click')
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

  it("laisse le message à l'écran quand aucune durée n'est donnée", async () => {
    const { calls, wrapper } = await monter()

    await wrapper.get('#msg-texte').setValue('Sans durée')
    await wrapper.get('#btn-envoyer-message').trigger('click')
    await flushPromises()

    // Vide ne veut pas dire zéro : ça veut dire « jusqu'à remplacement ».
    const envoi = calls.find((appel) => appel.path === 'messages/send')
    expect((envoi?.input as { ttlSeconds: unknown }).ttlSeconds).toBe(null)
  })

  it('refuse d’envoyer un message vide sans rien appeler', async () => {
    const { calls, wrapper } = await monter()

    await wrapper.get('#btn-envoyer-message').trigger('click')
    await flushPromises()

    expect(calls.filter((appel) => appel.path === 'messages/send')).toHaveLength(0)
  })

  it('vise la salle choisie, et elle seule', async () => {
    const { calls, wrapper } = await monter()

    await wrapper.get('#msg-salle').setValue('track-1')
    await flushPromises()
    await wrapper.get('#msg-texte').setValue('Pour Track #1')
    await wrapper.get('#btn-envoyer-message').trigger('click')
    await flushPromises()

    const envoi = calls.find((appel) => appel.path === 'messages/send')
    expect((envoi?.input as { roomId: unknown }).roomId).toBe('track-1')
  })

  it('remplit le champ avec un modèle, sans rien mettre à l’antenne', async () => {
    const { calls, wrapper } = await monter()

    await wrapper.get('#bandeau-modeles').findAll('button')[0]!.trigger('click')
    await flushPromises()

    // Un modèle est un point de départ, pas un rail : la date, la durée et le
    // nom de la salle changent à chaque fois.
    expect((wrapper.get('#bandeau-texte').element as HTMLInputElement).value.length).toBeGreaterThan(0)
    expect(calls.filter((appel) => appel.path === 'overlay/show')).toHaveLength(0)
  })

  it('relit l’historique après avoir affiché un bandeau', async () => {
    const { calls, wrapper } = await monter()

    await wrapper.get('#bandeau-texte').setValue('Le son revient')
    await wrapper.get('#btn-bandeau-afficher').trigger('click')
    await flushPromises()

    expect(calls).toContainEqual({
      path: 'overlay/show',
      input: { roomId: null, message: { text: 'Le son revient', level: 'info' }, ttlSeconds: null },
    })
    expect(calls.filter((appel) => appel.path === 'overlay/history').length).toBeGreaterThan(1)
  })
})
