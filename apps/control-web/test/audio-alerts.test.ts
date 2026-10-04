import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AudioAlerts from '../src/components/AudioAlerts.vue'

/**
 * The capture watchdog's strip: held across the top while the room hears the
 * problem, gone when it is fixed.
 */
const NOW = Date.parse('2026-10-30T10:20:00Z')

describe('the capture alerts', () => {
  it('say which microphone, what is wrong, and since when', () => {
    const wrapper = mount(AudioAlerts, {
      props: {
        nowMs: NOW,
        alerts: [
          { kind: 'silence', input: 'Micro HF', since: '2026-10-30T10:17:30Z' },
          { kind: 'muet', input: 'Micro pupitre', since: '2026-10-30T10:19:50Z' },
        ],
      },
    })
    const lines = wrapper.findAll('[data-audio-alert]').map((line) => line.text())
    expect(lines[0]).toContain('Micro « Micro HF » silencieux')
    expect(lines[0]).toContain('depuis 2 min')
    expect(lines[1]).toContain('Micro « Micro pupitre » coupé dans OBS-B')
    expect(lines[1]).toContain('à l’instant')
  })

  it('show nothing when all is well', () => {
    const wrapper = mount(AudioAlerts, { props: { nowMs: NOW, alerts: [] } })
    expect(wrapper.find('[data-role="audio-alerts"]').exists()).toBe(false)
  })
})
