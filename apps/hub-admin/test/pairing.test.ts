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
 * The path that matters is not the list, it is the code: Better Auth sends the
 * machine to `/admin/devices?user_code=…`, and everything that follows is decided
 * there. These tests hold the three things that make that path fragile — the code
 * that must survive the load, the decision that must stay possible on the spot,
 * and the error that must appear where the gesture was made.
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
   * The real router, not a simulated `$route`.
   *
   * `useRoute()` reads an injection: a mock on `$route` does not reach it. And
   * since a router is needed, it may as well be the application's — the address
   * `/admin/devices` is then really traversed, alias included, which is precisely
   * the path Better Auth makes the machines follow.
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
 * A modal's content lives outside the component.
 *
 * Reka renders it in a portal, on `document.body`: that is what lets it escape any
 * stack of contexts and stay on top. So we query it where it is, which checks
 * along the way that the portal works.
 */
function modal(selector: string): HTMLElement | null {
  return document.querySelector(selector)
}

beforeEach(() => {
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})

describe('adresse d’appairage', () => {
  it('is served on the same footing as the view it opens', () => {
    /*
     * `/admin/devices` n'est pas une vue : c'est une seconde porte sur
     * `appairage`. Oublier de l'enregistrer enverrait toutes les machines que
     * Better Auth redirige sur un 404 — et seulement les machines : un
     * an operator clicking the tab would never see it.
     */
    expect(consolePaths(false)).toContain(PAIRING_ALIAS)
    expect(consolePaths(false)).toContain(viewPath('appairage'))
  })
})

describe('vue d’appairage', () => {
  it('preselects the room the machine says it serves', async () => {
    const { wrapper } = await monter({
      pending: [
        { clientId: 'machine-a', requestedAt: '2026-10-30T09:00:00Z', scope: 'room:track-2' },
      ],
    })

    const select = wrapper.get('[data-demande="machine-a"] select')
      .element as HTMLSelectElement
    // Preselected but editable: the room's operator knows where they are,
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

  it('qualifies the URL\'s code without deciding for the operator', async () => {
    const { calls, wrapper } = await monter({
      userCode: 'WXYZ-9876',
      lookup: { status: 'pending', clientId: 'machine-b', roomId: 'track-1' },
    })

    expect(calls).toContainEqual({ path: 'devices/lookup', input: { userCode: 'WXYZ-9876' } })
    expect(modal('#verdict-text')?.textContent).toContain('machine-b')
    // Consulter n'approuve pas : les deux boutons existent, rien n'est parti.
    expect(calls.filter((appel) => appel.path === 'devices/approve')).toHaveLength(0)
    expect(modal('#verdict-approuver')).not.toBe(null)
  })

  it('does not offer to decide a code opened by another operator', async () => {
    // Sans `clientId`, Better Auth ne nous a pas reconnus comme le consultant
    // of the code: approving would fail, so better not to offer it.
    const { wrapper } = await monter({
      userCode: 'WXYZ-9876',
      lookup: { status: 'pending', clientId: null },
    })

    expect(modal('#verdict-text')?.textContent).toContain('autre opérateur')
    expect(modal('#verdict-approuver')).toBe(null)
  })

  it('explains an expired code instead of showing its status', async () => {
    const { wrapper } = await monter({
      userCode: 'WXYZ-9876',
      lookup: { status: 'invalid', reason: 'expire' },
    })

    expect(modal('#verdict-text')?.textContent).toContain('durée de vie')
    expect(modal('#verdict-approuver')).toBe(null)
  })

  it('shows the failure in the modal, not in the floating toast', async () => {
    const { wrapper } = await monter({
      userCode: 'WXYZ-9876',
      lookup: { status: 'pending', clientId: 'machine-b', roomId: 'track-1' },
      approveError: 'Ce code appartient à un autre opérateur',
    })

    modal('#verdict-approuver')!.click()
    await flushPromises()

    // L'erreur porte sur le geste qu'on vient de faire, et se lit en entier.
    expect(modal('#verdict-erreur')?.textContent).toContain('autre opérateur')
  })

  it('revokes a paired machine, and not one already revoked', async () => {
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
