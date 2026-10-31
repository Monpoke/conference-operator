import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CoupeValidation from '../src/components/CoupeValidation.vue'
import { partAt } from '../src/stores/montage.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * Listening at the cut chosen.
 *
 * The excerpts are cut around the proposal, once and for all: a cut moved by
 * hand has to be heard from the take itself, at its own place in its own file.
 */
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

async function mountCut(prise: unknown[] = PRISE) {
  useSessionStore().client = {
    token: { read: () => 'jeton', write: () => {}, clear: () => {} },
    rpc: { montage: { analyse: async () => ({ analyse: ANALYSE, fichiers: [], prise }) } },
  } as never
  const wrapper = mount(CoupeValidation, {
    props: { job: { id: 'job-1', coupe: null } as never },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})

describe('écoute de la coupe', () => {
  it('finds the file holding a moment of the take', () => {
    expect(partAt(PRISE, 0)).toBe(0)
    expect(partAt(PRISE, 99_999)).toBe(0)
    expect(partAt(PRISE, 100_000)).toBe(1)
    expect(partAt([], 0)).toBe(-1)
  })

  it('plays around the cut moved by hand, in the file that holds it', async () => {
    const wrapper = await mountCut()
    const fin = wrapper.findAll('input')[1]!
    await fin.setValue('02:30,0')
    await fin.trigger('change')

    await wrapper.get('[data-listen="fin"]').trigger('click')
    const audio = wrapper.get('audio.hidden').element as HTMLAudioElement
    expect(audio.src).toBe('https://s3.test/b.mp4')
    audio.dispatchEvent(new Event('loadedmetadata'))

    // 02:30 less five seconds, counted from the second file's start at 01:40.
    expect(audio.currentTime).toBe(45)
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-listen="fin"]').text()).toBe('Arrêter')
  })

  it('stops five seconds after the cut, and when a mark moves', async () => {
    const wrapper = await mountCut()
    await wrapper.get('[data-listen="debut"]').trigger('click')
    const audio = wrapper.get('audio.hidden').element as HTMLAudioElement

    audio.currentTime = 65
    await wrapper.get('audio.hidden').trigger('timeupdate')
    expect(wrapper.get('[data-listen="debut"]').text()).toContain('Écouter')

    await wrapper.get('[data-listen="debut"]').trigger('click')
    expect(wrapper.get('[data-listen="debut"]').text()).toBe('Arrêter')
    const fin = wrapper.findAll('input')[1]!
    await fin.setValue('03:00,0')
    await fin.trigger('change')
    expect(wrapper.get('[data-listen="debut"]').text()).toContain('Écouter')
  })

  it('goes on in the next file of a split take', async () => {
    const wrapper = await mountCut()
    const debut = wrapper.findAll('input')[0]!
    await debut.setValue('01:38,0')
    await debut.trigger('change')
    await wrapper.get('[data-listen="debut"]').trigger('click')
    const audio = wrapper.get('audio.hidden').element as HTMLAudioElement
    expect(audio.src).toBe('https://s3.test/a.mp4')

    await wrapper.get('audio.hidden').trigger('ended')
    expect(audio.src).toBe('https://s3.test/b.mp4')
  })

  it('offers no button when the take cannot be read', async () => {
    const wrapper = await mountCut([])
    expect(wrapper.find('[data-listen]').exists()).toBe(false)
  })
})
