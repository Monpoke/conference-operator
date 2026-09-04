import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsView from '../src/views/SettingsView.vue'
import { orNull, useSettingsStore } from '../src/stores/settings.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * The settings.
 *
 * Six panels and one shared constraint: the view refreshes every ten seconds, and
 * no field must rewrite itself while somebody is typing in it. Nothing is more
 * disorienting, and it is invisible on reading — hence the test.
 *
 * Three other decisions are worth holding: "empty" is not "absent", "Réimporter"
 * starts from the saved URL and not from the one on screen, and the resync report
 * gives the number of rooms reached rather than a "sent" that would be accurate on
 * an empty hub.
 */

interface Call {
  path: string
  input: unknown
}

const SETTINGS = {
  eventName: null,
  eventShortName: null,
  openFeedbackProjectId: null,
  programSourceUrl: 'https://exemple/programme.json',
  autoEndEnabled: true,
  autoEndGraceMinutes: 5,
  socialLinks: [],
}

const STORAGE = {
  endpoint: 's3.exemple',
  bucket: 'rushes',
  prefix: 'cn26',
  configure: true,
  politique: {
    actif: true,
    debitMaxOctetsS: 2048,
    cpuMax: 0.8,
    margeConferenceMinutes: 5,
    taillePartMo: 16,
  },
}

function stub(options: {
  settings?: Record<string, unknown>
  storage?: Record<string, unknown> | null
  resyncRooms?: number
  snapshots?: unknown[]
}): { calls: Call[]; client: unknown; settings: Record<string, unknown> } {
  const calls: Call[] = []
  // Mutated by the tests that simulate a change from elsewhere — another operator,
  // an import — between two refresh rounds.
  const settings: Record<string, unknown> = { ...SETTINGS, ...(options.settings ?? {}) }
  const note =
    (path: string, result: unknown) =>
    async (input: unknown = undefined) => {
      calls.push({ path, input })
      return result
    }
  return {
    calls,
    settings,
    client: {
      token: { read: () => 'jeton', write: () => {}, clear: () => {} },
      rpc: {
        settings: {
          // A fresh object on every call, as a real RPC round trip would do.
          // Returning the same reference would bypass reactivity and make the test
          // pass on an artefact of the stub.
          get: async (input?: unknown) => {
            calls.push({ path: 'settings/get', input })
            return { ...settings }
          },
          update: async (input?: unknown) => {
            calls.push({ path: 'settings/update', input })
            return { ...settings }
          },
        },
        event: {
          identity: note('event/identity', {
            derived: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
          }),
        },
        program: {
          snapshots: note('program/snapshots', options.snapshots ?? []),
          activate: note('program/activate', { ok: true }),
          import: note('program/import', { program: { sessions: [1, 2, 3] } }),
        },
        rooms: {
          list: note('rooms/list', [{ id: 'track-1', name: 'Track #1' }]),
          resync: note('rooms/resync', { rooms: options.resyncRooms ?? 2 }),
        },
        vod: {
          status: note('vod/status', options.storage === null ? { configure: false, politique: STORAGE.politique } : { ...STORAGE, ...(options.storage ?? {}) }),
          check: note('vod/check', { ok: true, etapes: [{ nom: 'joindre', ok: true }] }),
        },
      },
    },
  }
}

async function mountView(options: Parameters<typeof stub>[0] = {}): Promise<{
  calls: Call[]
  wrapper: ReturnType<typeof mount>
  settings: Record<string, unknown>
}> {
  const fake = stub(options)
  useSessionStore().client = fake.client as never
  const wrapper = mount(SettingsView, { attachTo: document.body })
  await useSettingsStore().load()
  await flushPromises()
  return { calls: fake.calls, wrapper, settings: fake.settings }
}

beforeEach(() => {
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})

describe('vide contre absent', () => {
  it('hands an emptied field back to the deduction rather than pin it', () => {
    // Without that distinction the setting could never be released again: the name
    // would stop following program imports, permanently.
    expect(orNull('   ')).toBe(null)
    expect(orNull('')).toBe(null)
    expect(orNull(' Cloud Nord ')).toBe('Cloud Nord')
  })
})

describe('settings view', () => {
  it('names the automatic closure as the page did', async () => {
    /*
     * Repeated word for word, and held here because the hub's HTTP test can no
     * longer do it: these labels now live in the bundle.
     *
     * A migration has no business rewording what an operator reads. "Délai de
     * grâce" is the term used in the day's conversations; replacing it with a
     * synonym would force a mental translation every time.
     */
    const { wrapper } = await mountView()
    const text = wrapper.text()
    expect(text).toContain('Clôture automatique')
    expect(text).toContain('Clôturer les conférences dépassées')
    expect(text).toContain('Délai de grâce')
  })

  it('does not overwrite a field while somebody is typing in it', async () => {
    const { wrapper } = await mountView()

    const field = wrapper.get('#event-name')
    ;(field.element as HTMLInputElement).focus()
    await field.setValue('Cloud Nord 2027')

    // The ten-second refresh goes by: the hub still answers `null`, and the field
    // must stay on what the operator is writing.
    await useSettingsStore().load()
    await flushPromises()

    expect((wrapper.get('#event-name').element as HTMLInputElement).value).toBe('Cloud Nord 2027')
  })

  it('takes the hub\'s value back once the field is left', async () => {
    const { wrapper, settings } = await mountView()

    // Leaving the field is exactly the moment a change made elsewhere — another
    // operator, an import — should become visible.
    ;(wrapper.get('#event-name').element as HTMLInputElement).blur()
    settings['eventName'] = 'Renommé ailleurs'
    await useSettingsStore().load()
    await flushPromises()

    expect((wrapper.get('#event-name').element as HTMLInputElement).value).toBe('Renommé ailleurs')
  })

  it('shows as a placeholder what the hub would deduce, without pre-filling it', async () => {
    const { wrapper } = await mountView()

    const field = wrapper.get('#event-name').element as HTMLInputElement
    // Pre-filled, it would suggest the value is pinned — and the first save would
    // in fact have pinned it.
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('Cloud Nord 2026')
  })

  it('blocks "Réimporter" while the displayed URL differs from the saved one', async () => {
    const { wrapper } = await mountView()

    expect(wrapper.get('#btn-reimport').attributes('disabled')).toBeUndefined()

    await wrapper.get('#program-url').setValue('https://autre/programme.json')
    await flushPromises()

    // Failing which one types an address, clicks, and the hub reads the old one
    // again with nothing saying so.
    expect(wrapper.get('#btn-reimport').attributes('disabled')).toBeDefined()
  })

  it('re-imports from the saved URL', async () => {
    const { calls, wrapper } = await mountView()

    await wrapper.get('#btn-reimport').trigger('click')
    await flushPromises()

    expect(calls).toContainEqual({
      path: 'program/import',
      input: { sourceUrl: 'https://exemple/programme.json' },
    })
  })

  it('drops social rows left empty', async () => {
    const { calls, wrapper } = await mountView()

    await wrapper.get('#btn-social-add').trigger('click')
    await flushPromises()
    await wrapper.get('#btn-social-links').trigger('click')
    await flushPromises()

    // Adding a row then thinking better of it is a normal gesture, and the hub
    // would refuse an empty URL.
    const sent = calls.find((call) => call.path === 'settings/update')
    expect((sent?.input as { socialLinks: unknown[] }).socialLinks).toEqual([])
  })

  it('converts the rate shown in kB/s into bytes', async () => {
    const { calls, wrapper } = await mountView()

    await wrapper.get('#vod-rate').setValue('512')
    await wrapper.get('#btn-vod-save').trigger('click')
    await flushPromises()

    const sent = calls.find((call) => call.path === 'settings/update')
    expect((sent?.input as { vodPolitique: { debitMaxOctetsS: number } }).vodPolitique.debitMaxOctetsS)
      .toBe(512 * 1024)
  })

  it('does not offer to probe a storage the hub has no keys for', async () => {
    const { wrapper } = await mountView({ storage: null })

    // With no keys there is nothing to probe, and the panel already says so at the top.
    expect(wrapper.get('#btn-vod-probe').attributes('disabled')).toBeDefined()
    expect(wrapper.get('#vod-state').text()).toContain('Aucun stockage S3 configuré')
  })

  it('tells "keys set, bucket missing" from the other two cases', async () => {
    const { wrapper } = await mountView({ storage: { configure: false } })

    // The most confusing of the three: the page is open, the keys are there, and
    // nothing leaves because a bucket name is missing.
    expect(wrapper.get('#vod-state').text()).toContain('aucun bucket')
  })

  it('asks for confirmation before resyncing, and says what will go out', async () => {
    const { calls, wrapper } = await mountView()

    await wrapper.get('#btn-resync').trigger('click')
    await flushPromises()

    expect(document.querySelector('#resync-text')?.textContent).toContain('toutes les salles')
    expect(calls.filter((call) => call.path === 'rooms/resync')).toHaveLength(0)
  })

  it('says how many rooms the request reached, not that it was sent', async () => {
    const { calls, wrapper } = await mountView({ resyncRooms: 0 })

    await wrapper.get('#btn-resync').trigger('click')
    await flushPromises()
    ;(document.querySelector('#resync-text')!
      .closest('[role="alertdialog"]')!
      .querySelectorAll('button')[1] as HTMLButtonElement).click()
    await flushPromises()

    // A hub with no paired room at all accepts the request with nothing leaving:
    // "requested" would then be exact and misleading.
    expect(calls).toContainEqual({ path: 'rooms/resync', input: { roomId: null } })
  })
})
