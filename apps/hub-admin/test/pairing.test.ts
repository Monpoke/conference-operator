import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PAIRING_ALIAS, consolePaths, viewPath } from '@cloudnord/contract'
import { createConsoleRouter } from '../src/router.js'
import PairingView from '../src/views/PairingView.vue'
import { usePairingStore } from '../src/stores/pairing.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * Appairage des machines de salle.
 *
 * Le chemin qui compte n'est pas la liste, c'est le code : Better Auth envoie
 * la machine sur `/admin/devices?user_code=…`, et tout ce qui suit se décide
 * là. Ces tests tiennent les trois choses qui rendent ce chemin fragile — le
 * code qui doit survivre au chargement, la décision qui doit rester possible
 * sur place, et l'erreur qui doit s'afficher là où le geste a été fait.
 */

interface Call {
  path: string
  input: unknown
}

const ROOMS = [
  { id: 'track-1', name: 'Track #1' },
  { id: 'track-2', name: 'Track #2' },
]

function stub(options: {
  pending?: unknown[]
  devices?: unknown[]
  lookup?: unknown
  approveError?: string
}): { calls: Call[]; client: unknown } {
  const calls: Call[] = []
  const note =
    (path: string, result: unknown, error?: string) =>
    async (input: unknown = undefined) => {
      calls.push({ path, input })
      if (error != null) throw new Error(error)
      return result
    }
  return {
    calls,
    client: {
      token: { read: () => 'jeton', write: () => {}, clear: () => {} },
      rpc: {
        rooms: { list: note('rooms/list', ROOMS) },
        devices: {
          pending: note('devices/pending', options.pending ?? []),
          list: note('devices/list', options.devices ?? []),
          lookup: note('devices/lookup', options.lookup ?? { status: 'inconnu' }),
          approve: note('devices/approve', { ok: true }, options.approveError),
          deny: note('devices/deny', { ok: true }),
          revoke: note('devices/revoke', { ok: true }),
        },
      },
    },
  }
}

async function monter(
  options: Parameters<typeof stub>[0] & { userCode?: string } = {},
): Promise<{ calls: Call[]; wrapper: ReturnType<typeof mount> }> {
  const fake = stub(options)
  const session = useSessionStore()
  session.client = fake.client as never
  /*
   * Le vrai routeur, pas un `$route` simulé.
   *
   * `useRoute()` lit une injection : un mock sur `$route` ne l'atteint pas. Et
   * puisqu'il faut un routeur, autant que ce soit celui de l'application —
   * l'adresse `/admin/devices` est alors traversée pour de bon, alias compris,
   * ce qui est précisément le chemin que Better Auth fait suivre aux machines.
   */
  const router = createConsoleRouter()
  await router.push(
    options.userCode == null
      ? viewPath('appairage')
      : `${PAIRING_ALIAS}?user_code=${options.userCode}`,
  )
  await router.isReady()
  const wrapper = mount(PairingView, {
    attachTo: document.body,
    global: { plugins: [router] },
  })
  await usePairingStore().load()
  await flushPromises()
  return { calls: fake.calls, wrapper }
}

/**
 * Le contenu d'une modale vit hors du composant.
 *
 * Reka la rend dans un portail, sur `document.body` : c'est ce qui lui permet
 * de sortir de toute pile de contextes et de rester au-dessus. On l'interroge
 * donc là où elle est, ce qui vérifie au passage que le portail fonctionne.
 */
function modale(selecteur: string): HTMLElement | null {
  return document.querySelector(selecteur)
}

beforeEach(() => {
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})

describe('adresse d’appairage', () => {
  it('est servie au même titre que la vue qu’elle ouvre', () => {
    /*
     * `/admin/devices` n'est pas une vue : c'est une seconde porte sur
     * `appairage`. Oublier de l'enregistrer enverrait toutes les machines que
     * Better Auth redirige sur un 404 — et seulement les machines : un
     * opérateur qui clique l'onglet ne le verrait jamais.
     */
    expect(consolePaths(false)).toContain(PAIRING_ALIAS)
    expect(consolePaths(false)).toContain(viewPath('appairage'))
  })
})

describe('vue d’appairage', () => {
  it('présélectionne la salle que la machine dit desservir', async () => {
    const { wrapper } = await monter({
      pending: [
        { clientId: 'machine-a', requestedAt: '2026-10-30T09:00:00Z', scope: 'room:track-2' },
      ],
    })

    const select = wrapper.get('[data-demande="machine-a"] select')
      .element as HTMLSelectElement
    // Présélectionnée mais modifiable : l'opérateur de la salle sait où il est,
    // celui devant la console tranche.
    expect(select.value).toBe('track-2')
  })

  it('approuve avec le code saisi et la salle retenue', async () => {
    const { calls, wrapper } = await monter({
      pending: [{ clientId: 'machine-a', requestedAt: '2026-10-30T09:00:00Z', scope: null }],
    })

    await wrapper.get('[data-demande="machine-a"] input').setValue('ABCD-1234')
    await wrapper.get('[data-demande="machine-a"] select').setValue('track-2')
    await wrapper.findAll('[data-demande="machine-a"] button')[0]!.trigger('click')
    await flushPromises()

    expect(calls).toContainEqual({
      path: 'devices/approve',
      input: { userCode: 'ABCD-1234', clientId: 'machine-a', roomId: 'track-2' },
    })
  })

  it('qualifie le code de l’URL sans rien décider à la place de l’opérateur', async () => {
    const { calls, wrapper } = await monter({
      userCode: 'WXYZ-9876',
      lookup: { status: 'pending', clientId: 'machine-b', roomId: 'track-1' },
    })

    expect(calls).toContainEqual({ path: 'devices/lookup', input: { userCode: 'WXYZ-9876' } })
    expect(modale('#verdict-text')?.textContent).toContain('machine-b')
    // Consulter n'approuve pas : les deux boutons existent, rien n'est parti.
    expect(calls.filter((appel) => appel.path === 'devices/approve')).toHaveLength(0)
    expect(modale('#verdict-approuver')).not.toBe(null)
  })

  it('ne propose pas de décider un code ouvert par un autre opérateur', async () => {
    // Sans `clientId`, Better Auth ne nous a pas reconnus comme le consultant
    // du code : approuver échouerait, autant ne pas le proposer.
    const { wrapper } = await monter({
      userCode: 'WXYZ-9876',
      lookup: { status: 'pending', clientId: null },
    })

    expect(modale('#verdict-text')?.textContent).toContain('autre opérateur')
    expect(modale('#verdict-approuver')).toBe(null)
  })

  it('explique un code expiré au lieu d’afficher son statut', async () => {
    const { wrapper } = await monter({
      userCode: 'WXYZ-9876',
      lookup: { status: 'invalid', reason: 'expire' },
    })

    expect(modale('#verdict-text')?.textContent).toContain('durée de vie')
    expect(modale('#verdict-approuver')).toBe(null)
  })

  it('affiche l’échec dans la modale, pas dans l’avis flottant', async () => {
    const { wrapper } = await monter({
      userCode: 'WXYZ-9876',
      lookup: { status: 'pending', clientId: 'machine-b', roomId: 'track-1' },
      approveError: 'Ce code appartient à un autre opérateur',
    })

    modale('#verdict-approuver')!.click()
    await flushPromises()

    // L'erreur porte sur le geste qu'on vient de faire, et se lit en entier.
    expect(modale('#verdict-erreur')?.textContent).toContain('autre opérateur')
  })

  it('révoque une machine appairée, et pas une déjà révoquée', async () => {
    const { calls, wrapper } = await monter({
      devices: [
        { clientId: 'machine-a', roomId: 'track-1', label: null, revokedAt: null },
        { clientId: 'machine-b', roomId: 'track-2', label: null, revokedAt: '2026-10-29T10:00:00Z' },
      ],
    })

    expect(wrapper.get('[data-machine="machine-b"]').text()).toContain('révoquée')
    expect(wrapper.find('[data-machine="machine-b"] button').exists()).toBe(false)

    await wrapper.get('[data-machine="machine-a"] button').trigger('click')
    await flushPromises()

    expect(calls).toContainEqual({ path: 'devices/revoke', input: { clientId: 'machine-a' } })
  })
})
