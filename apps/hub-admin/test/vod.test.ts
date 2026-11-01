import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import VodView from '../src/views/VodView.vue'
import VodFolderDialog from '../src/components/VodFolderDialog.vue'
import { conferenceRows, countByEtat, progress, useVodStore, type Upload } from '../src/stores/vod.js'
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

function stub(uploads: unknown[], sessions: unknown[] = []): { calls: Call[]; client: unknown } {
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
        program: { planning: note('program/planning', { sessions, rooms: ROOMS, timezone: 'Europe/Paris', serverTime: '2026-10-30T12:00:00Z' }) },
        vod: { uploads: note('vod/uploads', uploads), request: note('vod/request', { ok: true }), conference: note('vod/conference', null) },
      },
    },
  }
}

async function mountView(uploads: unknown[] = [], sessions: unknown[] = []): Promise<{
  calls: Call[]
  wrapper: ReturnType<typeof mount>
}> {
  const fake = stub(uploads, sessions)
  useSessionStore().client = fake.client as never
  const wrapper = mount(VodView, { attachTo: document.body })
  await useVodStore().load()
  await flushPromises()
  return { calls: fake.calls, wrapper }
}

/** The view folds a talk's files: the file-level gestures are one click away. */
async function unfold(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.get('[data-role="toggle-files"]').trigger('click')
}

const TALK = {
  id: 'talk-1',
  roomId: 'track-1',
  title: 'Le talk',
  kind: 'talk',
  speakers: [],
  startsAt: '2026-10-30T09:00:00Z',
  endsAt: '2026-10-30T09:40:00Z',
}

const IN_PROGRESS: Upload = {
  roomId: 'track-1',
  roomName: 'Track #1',
  file: 'rush-01.mkv',
  kind: 'rush',
  sessionId: 'talk-1',
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

describe('une ligne par conférence', () => {
  const SIDECAR: Upload = { ...IN_PROGRESS, file: 'rush-01.json', kind: 'sidecar', state: 'termine' }
  const rows = (uploads: Upload[], filter = '') =>
    conferenceRows(uploads, [TALK, { ...TALK, id: 'talk-2', title: 'Sans rien', roomId: 'track-2' }], ROOMS, filter, '2026-10-30T12:00:00Z')

  it('says a talk is complete once its rush and its sidecar have arrived', () => {
    const row = rows([{ ...IN_PROGRESS, state: 'termine' }, SIDECAR]).find((line) => line.key === 'talk-1')
    expect(row).toMatchObject({ title: 'Le talk', etat: 'complet', detail: '1 rush · side-car' })
    expect(row!.files).toHaveLength(2)
  })

  it('does not raise an alert for a sidecar waiting behind its rush', () => {
    // The room sends the sidecar once the rush has arrived, even after the slot.
    expect(rows([IN_PROGRESS]).find((line) => line.key === 'talk-1')).toMatchObject({ etat: 'en-cours', detail: 'rush en cours · 25 % · side-car à suivre' })
  })

  it('asks to resume a talk over with its sidecar or its rush missing', () => {
    expect(rows([{ ...IN_PROGRESS, state: 'termine' }])[0]).toMatchObject({ etat: 'a-reprendre', detail: '1 rush · side-car manquant' })
    expect(rows([SIDECAR])[0]).toMatchObject({ etat: 'a-reprendre', detail: 'rush manquant · side-car' })
  })

  it('keeps a talk over with nothing uploaded, at the top: it is the line to see', () => {
    const [first] = rows([{ ...IN_PROGRESS, state: 'termine' }, SIDECAR])
    expect(first).toMatchObject({ title: 'Sans rien', etat: 'a-reprendre', detail: 'aucun fichier reçu', roomName: 'Track #2' })
  })

  it('says "à venir" of a slot not yet over', () => {
    const [row] = conferenceRows([], [TALK], ROOMS, '', '2026-10-30T08:00:00Z')
    expect(row).toMatchObject({ etat: 'a-venir', detail: '' })
  })

  it('lets a failure outrank a file that arrived', () => {
    const [row] = rows([IN_PROGRESS, { ...IN_PROGRESS, file: 'rush-02.mkv', state: 'echoue' }, { ...IN_PROGRESS, file: 'rush-03.mkv', state: 'termine' }])
    expect(row!.etat).toBe('a-reprendre')
  })

  it('counts a file once when the hub lists several attempts', () => {
    const [row] = rows([{ ...IN_PROGRESS, state: 'termine' }, { ...IN_PROGRESS, state: 'echoue' }])
    expect(row!.files).toHaveLength(1)
    expect(row!.etat).toBe('a-reprendre') // sidecar missing, not the old failed attempt
    expect(row!.detail).toBe('1 rush · side-car manquant')
  })

  it('sorts what asks for a gesture first and counts each state', () => {
    const list = conferenceRows(
      [{ ...IN_PROGRESS, state: 'termine' }, SIDECAR, { ...IN_PROGRESS, file: 'b.mkv', sessionId: 'talk-3' }],
      [TALK, { ...TALK, id: 'talk-2', title: 'Sans rien', startsAt: '2026-10-30T10:00:00Z' }, { ...TALK, id: 'talk-3', title: 'En route', startsAt: '2026-10-30T11:00:00Z' }],
      ROOMS, '', '2026-10-30T12:00:00Z',
    )
    expect(list.map((row) => row.title)).toEqual(['Sans rien', 'En route', 'Le talk'])
    expect(countByEtat(list)).toEqual({ 'a-reprendre': 1, 'en-cours': 1, 'a-venir': 0, complet: 1, 'sans-captation': 0 })
  })

  it('expects nothing from a room nobody records, and keeps a file that arrives anyway', () => {
    const talk = { ...TALK, sansCaptation: true }
    expect(conferenceRows([], [talk], ROOMS, '', '2026-10-30T12:00:00Z')[0]).toMatchObject({ etat: 'sans-captation', detail: '' })
    expect(conferenceRows([{ ...IN_PROGRESS, state: 'termine' }], [talk], ROOMS, '', '2026-10-30T12:00:00Z')[0]).toMatchObject({ etat: 'complet', detail: '1 rush' })
  })

  it('leaves a room nobody records out of what is to handle, and says so', async () => {
    const { wrapper } = await mountView([], [{ ...TALK, sansCaptation: true }])
    expect(wrapper.find('[data-conference="talk-1"]').exists()).toBe(false)
    expect(wrapper.get('#vod-summary').text()).toContain('1 sans captation')
    await wrapper.get('#vod-room').setValue('track-1')
    await flushPromises()
    expect(wrapper.get('#vod-verdict').text()).toBe('Track #1 : pas de captation prévue')
  })

  it('expects no sidecar from a file no talk claims', () => {
    const [row] = rows([{ ...IN_PROGRESS, sessionId: null, state: 'termine' }], 'track-1').slice(-1)
    expect(row).toMatchObject({ title: 'Sans conférence', etat: 'complet' })
  })

  it('never loses an upload the programme does not name', () => {
    const titles = rows([{ ...IN_PROGRESS, sessionId: null }, { ...IN_PROGRESS, file: 'b.mkv', sessionId: 'retire' }]).map((row) => row.title)
    expect(titles).toContain('Sans conférence')
    expect(titles).toContain('Hors programme (retire)')
  })

  it('follows the room filter, without hiding a file arrived from another room', () => {
    expect(rows([], 'track-2').map((row) => row.title)).toEqual(['Sans rien'])
    expect(rows([{ ...IN_PROGRESS, roomId: 'track-2' }], 'track-2').map((row) => row.title).sort()).toEqual(['Le talk', 'Sans rien'])
  })

  it('sums a talk up in the table and folds its files', async () => {
    const { wrapper } = await mountView([IN_PROGRESS, SIDECAR], [TALK])
    const row = wrapper.get('[data-conference="talk-1"]')

    expect(row.text()).toContain('Le talk')
    expect(row.get('[data-role="etat"]').text()).toBe('En cours')
    expect(row.get('[data-role="files"]').text()).toContain('2')
    expect(row.get('[data-role="detail"]').text()).toContain('rush en cours')
    expect(wrapper.find('[data-upload="rush-01.mkv"]').exists()).toBe(false)
  })

  it('hides what needs nothing by default, and says so when nothing is left', async () => {
    const { wrapper } = await mountView([{ ...IN_PROGRESS, state: 'termine' }, SIDECAR], [TALK])

    expect(wrapper.find('[data-conference="talk-1"]').exists()).toBe(false)
    expect(wrapper.get('#vod-rows').text()).toContain('Rien à traiter')
    expect(wrapper.get('#vod-summary').text()).toContain('1 complète')

    await wrapper.get('#vod-only-to-handle').setValue(false)
    expect(wrapper.find('[data-conference="talk-1"]').exists()).toBe(true)
  })

  it('answers for the room chosen, before dismantling it', async () => {
    const { wrapper } = await mountView([{ ...IN_PROGRESS, state: 'termine' }, SIDECAR], [TALK])
    await wrapper.get('#vod-room').setValue('track-1')
    await flushPromises()
    expect(wrapper.get('#vod-verdict').text()).toBe('Track #1 : tout est rentré')
  })

  it('keeps the list usable when the programme cannot be read', async () => {
    const fake = stub([IN_PROGRESS])
    ;(fake.client as { rpc: { program: { planning: () => Promise<unknown> } } }).rpc.program.planning = async () => {
      throw new Error('FORBIDDEN')
    }
    useSessionStore().client = fake.client as never
    const store = useVodStore()
    await store.load()

    expect(store.conferences.map((row) => row.title)).toEqual(['Hors programme (talk-1)'])
  })
})

describe('vue VOD', () => {
  it('says there is nothing rather than leave an empty table', async () => {
    const { wrapper } = await mountView([])
    expect(wrapper.get('#vod-rows').text()).toContain('Aucun téléversement')
  })

  it('shows the progress and the rate, which say whether it is moving', async () => {
    const { wrapper } = await mountView([IN_PROGRESS])
    await unfold(wrapper)
    const row = wrapper.get('[data-upload="rush-01.mkv"]')

    expect(row.text()).toContain('25 %')
    expect(row.text()).toContain('2 Ko/s')
  })

  it('reprend l’erreur du stockage telle quelle', async () => {
    const { wrapper } = await mountView([{ ...IN_PROGRESS, state: 'echoue', lastError: 'AccessDenied' }])
    await unfold(wrapper)

    // "AccessDenied" is the only word one can carry to whoever holds the bucket:
    // translating it would lose the only handle on the problem.
    expect(wrapper.get('[data-upload="rush-01.mkv"]').text()).toContain('AccessDenied')
  })

  it('does not offer to retry what has already arrived', async () => {
    const { wrapper } = await mountView([{ ...IN_PROGRESS, state: 'termine' }])
    await wrapper.get('#vod-only-to-handle').setValue(false)
    await unfold(wrapper)
    expect(wrapper.find('[data-upload="rush-01.mkv"] button').exists()).toBe(false)
  })

  it('asks the room for a talk nothing arrived from', async () => {
    const { calls, wrapper } = await mountView([], [TALK])
    await wrapper.get('[data-role="request-room"]').trigger('click')
    await flushPromises()
    expect(calls).toContainEqual({ path: 'vod/request', input: { roomId: 'track-1', file: null } })
  })

  it('retries one specific file', async () => {
    const { calls, wrapper } = await mountView([IN_PROGRESS])
    await unfold(wrapper)

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

describe('dossier d’une salle sans captation', () => {
  it('says nothing is expected instead of reporting a missing take', async () => {
    const fake = stub([])
    ;(fake.client as { rpc: { vod: { conference: unknown }; montage?: unknown } }).rpc.vod.conference = async () => ({
      roomId: 'hands-on', captations: [], televersements: [], stockageConfigure: true, consentementYoutube: null,
    })
    ;(fake.client as { rpc: { montage?: unknown } }).rpc.montage = { list: async () => [] }
    useSessionStore().client = fake.client as never
    mount(VodFolderDialog, {
      props: { open: true, session: { ...TALK, sansCaptation: true } as never, timezone: 'Europe/Paris' },
      attachTo: document.body,
    })
    await flushPromises()

    expect(document.querySelector('[data-role="vod-sans-captation"]')?.textContent).toContain('Pas de captation prévue')
    expect(document.querySelector('[data-role="vod-consent"]')).toBeNull()
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

  it('relaunches the take of its own line, and tells two takes apart', async () => {
    await mountView()
    const job = {
      id: 'job-1', sessionId: 'talk-1', title: 'Le talk', state: 'a-valider', tentatives: 1,
      erreur: null, worker: null, marquesManquantes: [], progression: null, coupe: { debutMs: 0, finMs: 480000 },
    }
    const store = useMontageStore()
    store.jobs = [job, { ...job, id: 'job-2', coupe: { debutMs: 0, finMs: 2760000 } }] as never
    const relaunch = vi.spyOn(store, 'relaunch').mockResolvedValue(job as never)
    await flushPromises()

    const line = document.querySelector('[data-montage="job-1"]')!
    expect(line.querySelector('[data-role="montage-duree"]')?.textContent).toContain('8 min')
    expect(document.querySelector('[data-montage="job-2"] [data-role="montage-duree"]')?.textContent).toContain('46 min')
    ;([...line.querySelectorAll('button')].find((button) => button.textContent?.includes('Relancer')) as HTMLElement).click()
    expect(relaunch).toHaveBeenCalledWith('talk-1', 'job-1')
  })
})
