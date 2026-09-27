import type { AuditEntry } from '@conference-operator/contract'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import JournalView from '../src/views/JournalView.vue'
import { actionLabel, resultOf, toCsv, useAuditStore } from '../src/stores/audit.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * The audit log, as the console shows it.
 *
 * Stubbed at the transport, like the other views: what matters is what the
 * operator reads — the words for an action, and the room's answer next to it.
 */

const TRACK_1 = 'track-1'
const AT = '2026-10-30T09:00:00.000Z'

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 1,
    at: AT,
    actor: 'regie@cloudnord.fr',
    action: 'regie.command',
    roomId: TRACK_1,
    detail: JSON.stringify({ roomId: TRACK_1, action: { type: 'scene.set', role: 'LIVE' } }),
    ok: true,
    error: null,
    commandSeq: 7,
    outcome: null,
    ...overrides,
  }
}

function mountView(rows: AuditEntry[]) {
  const calls: { path: string; input: unknown }[] = []
  const session = useSessionStore()
  session.client = {
    token: { read: () => 'jeton', write: () => {}, clear: () => {} },
    rpc: {
      audit: {
        list: async (input: unknown) => {
          calls.push({ path: 'audit/list', input })
          return rows
        },
        // The hub's paging, as far as the view reads it.
        page: async (input: { page: number; pageSize: number }) => {
          calls.push({ path: 'audit/page', input })
          const last = Math.max(1, Math.ceil(rows.length / input.pageSize))
          const page = Math.min(input.page, last)
          return {
            items: rows.slice((page - 1) * input.pageSize, page * input.pageSize),
            total: rows.length,
            page,
            pageSize: input.pageSize,
          }
        },
      },
      rooms: { list: async () => [{ id: TRACK_1, name: 'Track #1' }] },
    },
  } as unknown as typeof session.client
  const wrapper = mount(JournalView, { attachTo: document.body })
  return { calls, wrapper }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})

describe('the journal view', () => {
  it('says who did what, where, and what the room answered', async () => {
    const { wrapper } = mountView([
      entry({ outcome: { ok: false, message: "OBS-A n'est pas connecté", at: AT } }),
    ])
    await useAuditStore().load()
    await flushPromises()

    const row = wrapper.get('[data-entry="1"]').text()
    expect(row).toContain('regie@cloudnord.fr')
    expect(row).toContain('Scène LIVE (régie mobile)')
    expect(row).toContain('Track #1')
    expect(row).toContain("Refusé en salle : OBS-A n'est pas connecté")
  })

  it('asks the hub again when a filter changes', async () => {
    const { calls, wrapper } = mountView([entry()])
    await useAuditStore().load()
    await flushPromises()

    await wrapper.get('#journal-room').setValue(TRACK_1)
    await flushPromises()

    expect(calls.at(-1)?.input).toMatchObject({ roomId: TRACK_1, actor: null })
  })

  it('searches once typing pauses, from the first page, in the console\'s words too', async () => {
    vi.useFakeTimers()
    try {
      const { calls, wrapper } = mountView(Array.from({ length: 120 }, (_, i) => entry({ id: i + 1 })))
      await useAuditStore().load()
      await useAuditStore().goTo(2)
      await flushPromises()

      await wrapper.get('#journal-search').setValue('Reglages')
      await wrapper.get('#journal-search').setValue('Réglages modif')
      const before = calls.length
      await vi.advanceTimersByTimeAsync(300)
      await flushPromises()

      // One request for the pause, not one per key.
      expect(calls.slice(before)).toHaveLength(1)
      expect(calls.at(-1)).toMatchObject({
        path: 'audit/page',
        // What the hub stores for what the operator reads.
        input: { q: 'Réglages modif', page: 1, actions: ['settings.update'], rooms: [] },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('finds a room by its name', async () => {
    vi.useFakeTimers()
    try {
      const { calls, wrapper } = mountView([entry()])
      await useAuditStore().load()
      await flushPromises()

      await wrapper.get('#journal-search').setValue('track #1')
      await vi.advanceTimersByTimeAsync(300)
      await flushPromises()

      expect(calls.at(-1)?.input).toMatchObject({ rooms: [TRACK_1] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('pages through the log, newest first', async () => {
    const { calls, wrapper } = mountView(Array.from({ length: 120 }, (_, i) => entry({ id: 120 - i })))
    await useAuditStore().load()
    await flushPromises()

    expect(wrapper.findAll('[data-entry]')).toHaveLength(50)
    expect(wrapper.get('#journal-pages').text()).toContain('Page 1 sur 3')
    expect(wrapper.get('#journal-pages [data-role="previous"]').attributes('disabled')).toBeDefined()

    await wrapper.get('#journal-pages [data-role="next"]').trigger('click')
    await flushPromises()

    expect(calls.at(-1)).toMatchObject({ path: 'audit/page', input: { page: 2, pageSize: 50 } })
    expect(wrapper.get('#journal-pages').text()).toContain('Page 2 sur 3')
    expect(wrapper.get('[data-entry]').attributes('data-entry')).toBe('70')
  })

  it('exports what the search found, not the whole log', async () => {
    const { calls, wrapper } = mountView([entry()])
    await useAuditStore().load()
    await useAuditStore().search('regie')
    await flushPromises()

    await useAuditStore().everything()
    expect(calls.at(-1)).toMatchObject({ path: 'audit/list', input: { q: 'regie', limit: 1000 } })
    wrapper.unmount()
  })
})

describe('the words', () => {
  it('names a gesture from its request', () => {
    expect(actionLabel(entry())).toBe('Scène LIVE (régie mobile)')
    expect(
      actionLabel(entry({ detail: JSON.stringify({ action: { type: 'display.set', mode: 'sponsors' } }) })),
    ).toBe('Écran : sponsors (régie mobile)')
    expect(actionLabel(entry({ action: 'settings.update', detail: null }))).toBe('Réglages modifiés')
    expect(actionLabel(entry({ action: 'sessions.swap', detail: null }))).toBe('Créneaux échangés')
    expect(actionLabel(entry({ action: 'sessions.pin', detail: null }))).toBe('Conférence forcée en salle')
    // What has no words yet keeps its procedure: readable, if not pretty.
    expect(actionLabel(entry({ action: 'nouveau.truc', detail: null }))).toBe('nouveau.truc')
  })

  it("tells a room's silence from a command still on its way", () => {
    const sent = Date.parse(AT)
    expect(resultOf(entry(), sent + 5_000).label).toBe('Envoyé à la salle…')
    expect(resultOf(entry(), sent + 60_000).label).toBe('Pas de réponse de la salle')
    expect(resultOf(entry({ outcome: { ok: true, message: null, at: AT } }), sent).label).toBe('Fait en salle')
    expect(resultOf(entry({ ok: false, error: 'Salle tenue par nuit@cloudnord.fr' }), sent).label).toBe(
      'Refusé : Salle tenue par nuit@cloudnord.fr',
    )
    expect(resultOf(entry({ commandSeq: null, action: 'settings.update' }), sent).label).toBe('Fait')
  })
})

describe('the export', () => {
  it('writes a CSV a French spreadsheet opens as columns', () => {
    const csv = toCsv(
      [entry({ detail: '{"note":"dit \\"bonjour\\""}' })],
      () => 'Track #1',
      Date.parse(AT) + 60_000,
    )
    expect(csv.startsWith('﻿"Date";"Qui";"Action";"Salle";"Résultat";"Détail"\r\n')).toBe(true)
    expect(csv).toContain('"Track #1";"Pas de réponse de la salle"')
    // The quotes of the request are doubled, not left to break the line.
    expect(csv).toContain('"{""note"":""dit \\""bonjour\\""""}"')
  })
})
