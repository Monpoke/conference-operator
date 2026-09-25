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
  // Two screens withdrawn to start with: what the panel shows is a state that
  // already exists, not a blank form.
  screensDisabled: ['sponsors'],
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
  images?: { held: number; failed: { url: string; reason: string; at: string }[] }
  streams?: { roomId: string; name: string; rtmpUrl: string; hasKey: boolean }[]
  wallsIoToken?: boolean
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
          images: note('program/images', options.images ?? { held: 0, failed: [] }),
          activate: note('program/activate', { ok: true }),
          import: note('program/import', { program: { sessions: [1, 2, 3] } }),
        },
        rooms: {
          list: note('rooms/list', [{ id: 'track-1', name: 'Track #1' }]),
          resync: note('rooms/resync', { rooms: options.resyncRooms ?? 2 }),
          streams: note(
            'rooms/streams',
            options.streams ?? [
              { roomId: 'track-1', name: 'Track #1', rtmpUrl: '', hasKey: false },
            ],
          ),
          // Answers like the hub: what was asked for, laid back down. The key
          // never comes back — only whether there is now one.
          setStream: async (input: unknown) => {
            calls.push({ path: 'rooms/setStream', input })
            const patch = input as { roomId: string; rtmpUrl: string; streamKey?: string | null }
            const before = (options.streams ?? []).find((item) => item.roomId === patch.roomId)
            return {
              roomId: patch.roomId,
              name: before?.name ?? 'Track #1',
              rtmpUrl: patch.rtmpUrl,
              hasKey:
                patch.streamKey === undefined
                  ? (before?.hasKey ?? false)
                  : patch.streamKey != null && patch.streamKey !== '',
            }
          },
        },
        wallsio: {
          status: note('wallsio/status', {
            hasToken: options.wallsIoToken ?? false,
            tokenHint: options.wallsIoToken ? 'abcd' : null,
            lastPollAt: null,
            lastError: null,
            imported: 0,
          }),
          // Answers like the hub: whether there is a token, never the token.
          setToken: async (input: unknown) => {
            calls.push({ path: 'wallsio/setToken', input })
            const { token } = input as { token: string | null }
            return { hasToken: token != null, tokenHint: token?.slice(-4) ?? null, lastPollAt: null, lastError: null, imported: 3 }
          },
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

  it('sends back the screens left on, inverted', async () => {
    const { calls, wrapper } = await mountView()

    // The box is ticked when the screen is **on**: a checkbox one ticks to switch
    // a screen off reads backwards. Ticking the sponsors puts them back.
    await wrapper.get('[data-screen="sponsors"] input').setValue(true)
    await wrapper.get('[data-screen="countdown"] input').setValue(false)
    await wrapper.get('#btn-screens').trigger('click')
    await flushPromises()

    const sent = calls.find((call) => call.path === 'settings/update')
    expect((sent?.input as { screensDisabled: string[] }).screensDisabled).toEqual(['countdown'])
  })

  it('offers the loop scenes like the other screens', async () => {
    const { calls, wrapper } = await mountView()

    // Labelled as the organisers name them, and withdrawn the same way.
    expect(wrapper.get('[data-screen="announcements"]').text()).toContain('Annonces “offert par”')
    expect(wrapper.get('[data-screen="event-feedback"]').text()).toContain("QR feedbacks de l'événement")
    for (const screen of ['welcome', 'sponsors-thanks', 'slogans', 'wallsio', 'code-of-conduct']) {
      expect(wrapper.find(`[data-screen="${screen}"]`).exists(), screen).toBe(true)
    }
    // The hand-fed posts joined the social wall: no screen of their own left.
    expect(wrapper.find('[data-screen="posts"]').exists()).toBe(false)

    await wrapper.get('[data-screen="wallsio"] input').setValue(false)
    await wrapper.get('#btn-screens').trigger('click')
    await flushPromises()

    const sent = calls.find((call) => call.path === 'settings/update')
    expect((sent?.input as { screensDisabled: string[] }).screensDisabled).toEqual(['sponsors', 'wallsio'])
  })

  it('sends the walls.io token, then forgets it', async () => {
    const { calls, wrapper } = await mountView()

    await wrapper.get('#walls-io-token').setValue('  jeton-walls-io-1234  ')
    await wrapper.get('#btn-walls-io-token').trigger('click')
    await flushPromises()

    expect(calls).toContainEqual({ path: 'wallsio/setToken', input: { token: 'jeton-walls-io-1234' } })
    // The field is emptied: the token is on the hub, not left on the page.
    expect((wrapper.get('#walls-io-token').element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('#walls-io-token').attributes('placeholder')).toContain('…1234')
    expect(wrapper.html()).not.toContain('jeton-walls-io-1234')
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

describe('panneau Diffusion', () => {
  const SET = { roomId: 'track-1', name: 'Track #1', rtmpUrl: 'rtmp://live/app', hasKey: true }
  const UNSET = { roomId: 'track-1', name: 'Track #1', rtmpUrl: '', hasKey: false }

  const lastSetStream = (calls: Call[]) =>
    calls.filter((call) => call.path === 'rooms/setStream').at(-1)?.input as
      | { roomId: string; rtmpUrl: string; streamKey?: string | null }
      | undefined

  /** The dialog is teleported to the body, like the resync one above. */
  const confirmDialog = (anchorId: string): void => {
    const dialog = document.querySelector(`#${anchorId}`)!.closest('[role="alertdialog"]')!
    ;(dialog.querySelectorAll('button')[1] as HTMLButtonElement).click()
  }

  it('says which rooms can actually stream, and which only look set up', async () => {
    // The incomplete case is the one worth naming: there is text in the field, so
    // the line reads as configured, and the room silently offers no « Diffuser ».
    const { wrapper } = await mountView({
      streams: [
        SET,
        { roomId: 'track-2', name: 'Track #2', rtmpUrl: 'rtmp://live/deux', hasKey: false },
        { roomId: 'track-3', name: 'Track #3', rtmpUrl: '', hasKey: false },
      ],
    })

    const text = wrapper.text()
    expect(text).toContain('Diffusion prête')
    expect(text).toContain('aucune clé')
    expect(text).toContain('Aucune diffusion')
  })

  it('leaves the key out of the call when nothing was typed', async () => {
    /*
     * The heart of the panel. The console never receives the key, so it cannot
     * send it back to preserve it: the field left empty must mean "unchanged" all
     * the way down to the column. Sending an empty string instead would wipe the
     * key every time somebody corrected a typo in the address — and nothing on
     * the page would say so.
     */
    const { wrapper, calls } = await mountView({ streams: [SET] })

    await wrapper.get('#stream-url-track-1').setValue('rtmp://nouveau/app')
    await wrapper.get('#btn-stream-save-track-1').trigger('click')
    await flushPromises()

    expect(lastSetStream(calls)).toEqual({ roomId: 'track-1', rtmpUrl: 'rtmp://nouveau/app' })
  })

  it('sends the key when one has been typed', async () => {
    const { wrapper, calls } = await mountView({ streams: [UNSET] })

    await wrapper.get('#stream-url-track-1').setValue('rtmp://live/app')
    await wrapper.get('#stream-key-track-1').setValue('cle-de-track-1')
    await wrapper.get('#btn-stream-save-track-1').trigger('click')
    await flushPromises()

    expect(lastSetStream(calls)).toEqual({
      roomId: 'track-1',
      rtmpUrl: 'rtmp://live/app',
      streamKey: 'cle-de-track-1',
    })
  })

  it('does not rewrite a line while somebody is typing in it', async () => {
    // The same rule as the fields above, applied per room: the page reloads every
    // ten seconds, and the old address arriving mid-sentence is the defect.
    const { wrapper } = await mountView({ streams: [SET] })

    await wrapper.get('#stream-url-track-1').setValue('rtmp://en-cours-de-frappe/app')
    await useSettingsStore().load()
    await flushPromises()

    expect((wrapper.get('#stream-url-track-1').element as HTMLInputElement).value).toBe(
      'rtmp://en-cours-de-frappe/app',
    )
  })

  it('never shows the key back, not even as a placeholder', async () => {
    const { wrapper } = await mountView({ streams: [SET] })

    const key = wrapper.get('#stream-key-track-1').element as HTMLInputElement
    expect(key.value).toBe('')
    expect(key.type).toBe('password')
    // It says there is one — that is the whole of what the console may know.
    expect(key.placeholder).toContain('conserver')
  })

  it('asks before erasing, and says the key is gone for good', async () => {
    // It cannot be undone from here: the console has never held the key, so the
    // repair is going and fetching it from wherever it was issued.
    const { wrapper, calls } = await mountView({ streams: [SET] })

    await wrapper.get('#btn-stream-clear-track-1').trigger('click')
    await flushPromises()
    expect(document.querySelector('#clear-stream-text')?.textContent).toContain('Track #1')
    expect(lastSetStream(calls)).toBeUndefined()

    confirmDialog('clear-stream-text')
    await flushPromises()

    expect(lastSetStream(calls)).toEqual({ roomId: 'track-1', rtmpUrl: '', streamKey: null })
  })
})
