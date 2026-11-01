import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MontageView from '../src/views/MontageView.vue'
import { useConferencesStore } from '../src/stores/conferences.js'
import { partAt, useMontageStore } from '../src/stores/montage.js'
import { useSessionStore } from '../src/stores/session.js'
import { centredOn, levelScale, levelsFor, listeningGainDb, tickStep, zoomAround } from '../src/stores/timeline.js'

/** The montage's page: the whole take to hear, and a cut placed on it. */
const SIDE = { source: 'parole', calee: false, deplacementMs: 0 }
const ANALYSE = {
  proposition: { debutMs: 60_000, finMs: 200_000, debut: SIDE, fin: SIDE },
  confiance: 'basse',
  raisons: [],
  audio: null,
  takeMs: 300_000,
  artefacts: [],
}
const PRISE = [
  { url: 'https://s3.test/a.mp4', offsetMs: 0 },
  { url: 'https://s3.test/b.mp4', offsetMs: 100_000 },
]
const JOB = { id: 'job-1', sessionId: 'talk-1', sidecarUploadId: 'side-1', state: 'a-valider', phase: 'montage', coupe: null, habillagePrise: null, marquesManquantes: [], tentatives: 1 }

async function mountPage(options: { prise?: unknown[]; niveaux?: unknown; jobs?: unknown[] } = {}) {
  const valider = vi.fn(async () => JOB)
  const list = vi.fn(async () => options.jobs ?? [JOB])
  useSessionStore().client = {
    token: { read: () => 'jeton', write: () => {}, clear: () => {} },
    rpc: {
      vod: { dossier: async () => ({}) },
      sessions: { dossier: async () => ({}) },
      montage: {
        analyse: async () => ({ analyse: ANALYSE, fichiers: [], prise: options.prise ?? PRISE, niveaux: options.niveaux ?? null }),
        list,
        workers: { list: async () => [] },
        valider,
      },
    },
  } as never
  useConferencesStore().planning = { timezone: 'Europe/Paris', sessions: [{ id: 'talk-1', title: 'Le talk', speakers: [] }] } as never
  vi.spyOn(useConferencesStore(), 'vodFolder').mockResolvedValue({})
  const wrapper = mount(MontageView, { props: { sessionId: 'talk-1' }, attachTo: document.body })
  await flushPromises()
  await flushPromises()
  return { wrapper, valider }
}

beforeEach(() => {
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})

describe('la lecture de la prise', () => {
  it('finds the file holding a moment of the take', () => {
    expect(partAt(PRISE, 0)).toBe(0)
    expect(partAt(PRISE, 99_999)).toBe(0)
    expect(partAt(PRISE, 100_000)).toBe(1)
    expect(partAt([], 0)).toBe(-1)
  })

  it('plays around a cut moved by hand, in the file that holds it', async () => {
    const { wrapper } = await mountPage()
    const fin = wrapper.get('[data-cut="fin"] input')
    await fin.setValue('02:30,0')
    await fin.trigger('change')

    await wrapper.get('[data-listen="fin"]').trigger('click')
    const video = wrapper.get('video').element as HTMLVideoElement
    expect(new URL(video.src).pathname).toBe('/montage/prise/job-1/1')
    video.dispatchEvent(new Event('loadedmetadata'))
    // 02:30 less five seconds, counted from the second file's start at 01:40.
    expect(video.currentTime).toBe(45)
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
  })

  it('goes on to the end of the take, across its files', async () => {
    const { wrapper } = await mountPage()
    await wrapper.get('[data-role="lecture"]').trigger('click')
    const video = wrapper.get('video')
    await video.trigger('ended')
    expect(new URL((video.element as HTMLVideoElement).src).pathname).toBe('/montage/prise/job-1/1')
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
  })

  it('still lets a cut be placed when the take cannot be read', async () => {
    const { wrapper } = await mountPage({ prise: [] })
    expect(wrapper.get('[data-listen="debut"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-role="timeline"]').exists()).toBe(true)
  })
})

describe('la coupe', () => {
  it('places an end at the playhead with its key, and validates what is shown', async () => {
    const { wrapper, valider } = await mountPage()
    await wrapper.get('[data-cut="debut"] input').setValue('00:10,0')
    await wrapper.get('[data-cut="debut"] input').trigger('change')
    await wrapper.get('[data-listen="debut"]').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o' }))
    await flushPromises()
    expect((wrapper.get('[data-cut="fin"] input').element as HTMLInputElement).value).toBe('00:11,0')

    await wrapper.get('[data-role="valider"]').trigger('click')
    await flushPromises()
    expect(valider).toHaveBeenCalledWith({ jobId: 'job-1', debutMs: 10_000, finMs: 11_000 })
    wrapper.unmount()
  })

  it('says when a take only has the old waveform', async () => {
    const without = await mountPage()
    expect(without.wrapper.find('[data-role="timeline-sans-niveaux"]').exists()).toBe(true)
    without.wrapper.unmount()
    const withLevels = await mountPage({ niveaux: { frameMs: 50, db: [-60, -30] } })
    expect(withLevels.wrapper.find('[data-role="timeline-sans-niveaux"]').exists()).toBe(false)
  })
})

describe('le gain d’écoute', () => {
  it('starts at what the video will sound like, within what the page offers', () => {
    expect(listeningGainDb(-39.5)).toBe(24)
    expect(listeningGainDb(-60)).toBe(30)
    expect(listeningGainDb(-10)).toBe(0)
    expect(listeningGainDb(null)).toBe(0)
  })
})

describe('le zoom', () => {
  it('keeps what is under the pointer in place', () => {
    const next = zoomAround({ fromMs: 0, toMs: 100_000 }, 25_000, 0.5, 100_000)
    expect(next).toEqual({ fromMs: 12_500, toMs: 62_500 })
  })

  it('stays inside the take, and stops close enough', () => {
    expect(centredOn(1_000, 30_000, 100_000)).toEqual({ fromMs: 0, toMs: 30_000 })
    const close = zoomAround({ fromMs: 0, toMs: 3_000 }, 1_000, 0.01, 100_000)
    expect(close.toMs - close.fromMs).toBe(2_000)
  })

  it('shows the loudest frame of a pixel, so that a short word stays visible', () => {
    const db = [-60, -60, -20, -60, -60, -60, -60, -60]
    const levels = levelsFor({ frameMs: 50, db }, { fromMs: 0, toMs: 400 }, 2, { floor: -60, top: -20 })
    expect([...levels]).toEqual([1, 0])
  })

  it('draws a quiet take against its own levels', () => {
    const scale = levelScale(Array.from({ length: 100 }, (_, i) => -70 + i * 0.3))
    expect(scale.floor).toBeLessThan(-65)
    expect(scale.top).toBeLessThan(-40)
    expect(tickStep(10_000, 900)).toBe(1_000)
  })
})
