import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { deliveryStatus, useIntegrationsStore, type Integration } from '../src/stores/integrations.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * Integrations, console side.
 *
 * Two things worth holding: every gesture lays down again what the hub answered
 * — the address comes back masked, and the store never keeps what was typed —,
 * and the status shown is whichever came last, success or failure.
 */

const INTEGRATION = (patch: Partial<Integration> = {}): Integration => ({
  id: 'i1',
  kind: 'slack',
  name: '#regie',
  enabled: true,
  url: 'https://hooks.slack.com/…WXYZ',
  hasSecret: false,
  levels: { technique: 'tout', exploitation: 'essentiel' },
  createdAt: '2026-09-13T08:00:00.000Z',
  lastSentAt: null,
  lastErrorAt: null,
  lastError: null,
  ...patch,
})

describe('integrations store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('reloads what the hub holds after every gesture', async () => {
    const calls: string[] = []
    let held = [INTEGRATION()]
    const note =
      (path: string, result: () => unknown = () => ({ ok: true })) =>
      async (input?: unknown) => {
        calls.push(input === undefined ? path : `${path} ${JSON.stringify(input)}`)
        return result()
      }
    useSessionStore().client = {
      token: { read: () => 'jeton', write: () => {}, clear: () => {} },
      rpc: {
        integrations: {
          list: note('list', () => held),
          create: note('create'),
          update: note('update'),
          remove: note('remove', () => {
            held = []
            return { ok: true }
          }),
          test: note('test', () => ({ ok: false, status: 404, error: 'Réponse 404 : no_service' })),
        },
      },
    } as never

    const store = useIntegrationsStore()
    await store.load()
    expect(store.integrations).toHaveLength(1)

    await store.update({ id: 'i1', enabled: false })
    expect(await store.test('i1')).toEqual({ ok: false, status: 404, error: 'Réponse 404 : no_service' })
    await store.remove('i1')

    expect(calls).toEqual([
      'list',
      'update {"id":"i1","enabled":false}',
      'list',
      'test {"id":"i1"}',
      'list',
      'remove {"id":"i1"}',
      'list',
    ])
    expect(store.integrations).toEqual([])
  })
})

describe('delivery status', () => {
  it('says nothing before the first delivery', () => {
    expect(deliveryStatus(INTEGRATION())).toBeNull()
  })

  it('shows a failure that came after the last success', () => {
    const status = deliveryStatus(
      INTEGRATION({
        lastSentAt: '2026-09-13T09:00:00.000Z',
        lastErrorAt: '2026-09-13T10:00:00.000Z',
        lastError: 'Pas de réponse en 8 s',
      }),
    )
    expect(status?.ok).toBe(false)
    expect(status?.text).toContain('Pas de réponse en 8 s')
  })

  it('forgets a failure that successes have overtaken', () => {
    const status = deliveryStatus(
      INTEGRATION({
        lastSentAt: '2026-09-13T11:00:00.000Z',
        lastErrorAt: '2026-09-13T10:00:00.000Z',
        lastError: 'Réponse 500',
      }),
    )
    expect(status?.ok).toBe(true)
    expect(status?.text).toMatch(/^Dernier envoi le /)
  })
})
