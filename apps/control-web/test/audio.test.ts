import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import LevelMeters from '../src/components/LevelMeters.vue'
import { PEAK_HOLD_MS, useAudioStore } from '../src/stores/audio.js'

/**
 * The VU meter, which says what no picture will.
 *
 * A room whose microphone cuts out keeps the same projection, the same stopwatch
 * and the same red button. The only place it shows is here.
 */

const INPUT = { name: 'Micro HF', channels: [{ magnitude: -30, peak: -28 }] }

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('peak hold', () => {
  it('holds a clip long enough to be seen', () => {
    const audio = useAudioStore()

    audio.apply([{ name: 'Micro HF', channels: [{ magnitude: -30, peak: -3 }] }], 0)
    audio.apply([INPUT], 500)

    // A tenth-of-a-second clip slips between two renders: with no hold, nobody
    // ever sees it.
    expect(audio.peaks['Micro HF']?.db).toBe(-3)
  })

  it('releases the peak once the hold has elapsed', () => {
    const audio = useAudioStore()

    audio.apply([{ name: 'Micro HF', channels: [{ magnitude: -30, peak: -3 }] }], 0)
    audio.apply([INPUT], PEAK_HOLD_MS + 1)

    expect(audio.peaks['Micro HF']?.db).toBe(-28)
  })

  it('rises at once on a higher peak', () => {
    const audio = useAudioStore()

    audio.apply([INPUT], 0)
    audio.apply([{ name: 'Micro HF', channels: [{ magnitude: -10, peak: -6 }] }], 100)

    expect(audio.peaks['Micro HF']?.db).toBe(-6)
  })

  it('forgets an input that disappears from OBS', () => {
    const audio = useAudioStore()

    audio.apply([INPUT], 0)
    audio.apply([], 100)

    // A peak kept for an unplugged input would show up on the next one to take
    // over its name.
    expect(audio.peaks['Micro HF']).toBeUndefined()
  })
})

describe('levels panel', () => {
  it('tells "waiting" apart from "no input"', async () => {
    const audio = useAudioStore()
    const wrapper = mount(LevelMeters)

    // The first is an OBS we have not heard yet, the second an OBS that answers
    // and has nothing to let us listen to. Confusing them would send people looking
    // for the fault in the wrong place.
    expect(wrapper.text()).toContain("En attente d'OBS")

    audio.apply([], 0)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Aucune entrée audio')
  })

  it('draws one gauge per channel, because mono and stereo coexist', async () => {
    const audio = useAudioStore()
    audio.apply(
      [{ name: 'Salle', channels: [{ magnitude: -30, peak: -30 }, { magnitude: -12, peak: -12 }] }],
      0,
    )
    const wrapper = mount(LevelMeters)
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('[data-role="levels"] .rounded-full')).toHaveLength(4)
  })

  it('alerts on the peak, without waiting for the bar to still be there', async () => {
    const audio = useAudioStore()
    audio.apply([{ name: 'Salle', channels: [{ magnitude: -40, peak: -3 }] }], 0)
    const wrapper = mount(LevelMeters)
    await wrapper.vm.$nextTick()

    expect(wrapper.html()).toContain('text-alert')
    expect(wrapper.text()).toContain('-3 dB')
  })

  it('says "—" rather than "−60 dB" on a silent input', async () => {
    const audio = useAudioStore()
    audio.apply([{ name: 'Salle', channels: [{ magnitude: -60, peak: -60 }] }], 0)
    const wrapper = mount(LevelMeters)
    await wrapper.vm.$nextTick()

    // The floor is not a measurement: it is the admission that there is nothing to
    // measure, and a figure there would read as a weak signal.
    expect(wrapper.text()).toContain('—')
  })
})
