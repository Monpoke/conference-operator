import type { HostLoad } from '@conference-operator/contract'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import CpuIndicator from '../src/components/CpuIndicator.vue'
import HubIndicator from '../src/components/HubIndicator.vue'
import ModeBadge from '../src/components/ModeBadge.vue'
import ControlHeader from '../src/components/ControlHeader.vue'
import RoomClock from '../src/components/RoomClock.vue'
import { clockDrift } from '../src/lib/clock-drift.js'
import { payload } from './fixtures.js'

/**
 * The header: what one reads without looking for it.
 *
 * It drives nothing, and that is precisely why it counts — it carries the three
 * failures a room cannot see any other way: the hub lost, the machine saturated,
 * the page frozen.
 */

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('link with the hub', () => {
  it('says what still works, rather than what is broken', () => {
    const wrapper = mount(HubIndicator, {
      props: { connectivity: 'OFFLINE', queueDepth: 0, offsetMs: 0, simulatedClock: false },
    })

    // The operator's only question when the dot changes mid-day, and the answer is
    // counter-intuitive: the room carries on by itself.
    expect(wrapper.text()).toContain('Projection et captation, elles, n’en dépendent pas')
  })

  it('treats an unknown connectivity as an outage', () => {
    const wrapper = mount(HubIndicator, {
      props: { connectivity: null, queueDepth: 0, offsetMs: 0, simulatedClock: false },
    })

    // Staying silent about a state one cannot name would leave the dot green,
    // which is the one misreading not to allow here.
    expect(wrapper.attributes('data-level')).toBe('alert')
    expect(wrapper.text()).toContain('hors ligne')
  })

  it('announces the queue rather than hide it when it is empty', () => {
    const wrapper = mount(HubIndicator, {
      props: { connectivity: 'DEGRADED', queueDepth: 12, offsetMs: 0, simulatedClock: false },
    })
    expect(wrapper.text()).toContain('12 en attente de remontée')
  })

  it('says the simulated clock in place of the offset, which would mean nothing', () => {
    const wrapper = mount(HubIndicator, {
      props: { connectivity: 'ONLINE', queueDepth: 0, offsetMs: 5_400_000, simulatedClock: true },
    })

    expect(wrapper.text()).toContain('horloge simulée par le hub')
    expect(wrapper.text()).not.toContain('décalée')
  })
})

describe('clock offset', () => {
  it('never returns a number one cannot picture', () => {
    // "décalée de +5 693 432,6 s" is exact and unreadable.
    expect(clockDrift(300)).toBe('horloge alignée')
    expect(clockDrift(2400)).toBe('horloge décalée de +2,4 s')
    expect(clockDrift(-600_000)).toBe('horloge décalée de −10 min')
    expect(clockDrift(5_693_432_600)).toBe('horloge décalée de +66 jours')
  })
})

describe('machine load', () => {
  it('admits a missing measurement rather than display zero', () => {
    const wrapper = mount(CpuIndicator, { props: { load: null } })

    expect(wrapper.attributes('data-level')).toBe('unknown')
    expect(wrapper.text()).toContain('Pastille sans valeur, pas poste au repos')
  })

  it('does not say "le poste encaisse" under a full memory', () => {
    const wrapper = mount(CpuIndicator, {
      props: {
        load: {
          cpu: 0.1,
          cores: 8,
          windowMs: 5000,
          memory: { usedBytes: 31_000_000_000, totalBytes: 32_000_000_000 },
        },
      },
    })

    // The verdict goes to the graver measurement: it is the other way a machine
    // gives out, and the most insidious — it starts swapping to the disk that is
    // writing the footage.
    expect(wrapper.attributes('data-level')).toBe('alert')
    expect(wrapper.text()).toContain('celui-là même qui écrit le rush')
  })

  it('keeps the large figure the colour of its own measurement', () => {
    const wrapper = mount(CpuIndicator, {
      props: {
        load: {
          cpu: 0.1,
          cores: 8,
          windowMs: 5000,
          memory: { usedBytes: 31_000_000_000, totalBytes: 32_000_000_000 },
        },
      },
    })

    // A processor at rest stays green under a red memory dot.
    expect(wrapper.html()).toContain('level-ok')
  })

  it('says nothing about memory while the first window has not elapsed', () => {
    const wrapper = mount(CpuIndicator, {
      props: { load: { cpu: null, cores: 8, windowMs: 0, memory: null } },
    })

    // An unmeasured memory became "the gravest" and the memory verdict table has
    // nothing to say about a memory that is fine: the original page displayed
    // "undefined" during the first window.
    expect(wrapper.text()).not.toContain('undefined')
    expect(wrapper.text()).toContain('première mesure en cours')
  })
})

describe('machine load, in detail', () => {
  const HEALTHY_MEMORY = { usedBytes: 4_000_000_000, totalBytes: 16_000_000_000 }

  function machine(load: HostLoad | null): ReturnType<typeof mount> {
    return mount(CpuIndicator, { props: { load } })
  }

  it('stays green for as long as the machine has headroom', () => {
    const wrapper = machine({ cpu: 0.31, cores: 8, windowMs: 5_000, memory: HEALTHY_MEMORY })

    expect(wrapper.attributes('data-level')).toBe('ok')
    expect(wrapper.get('.status-dot').classes()).toEqual(['status-dot'])
    expect(wrapper.text()).toContain('31 %')
    expect(wrapper.text()).toContain('8 cœurs')
    expect(wrapper.text()).toContain('sans forcer')
  })

  it('turns amber on a sustained load', () => {
    const wrapper = machine({ cpu: 0.78, cores: 8, windowMs: 5_000, memory: null })

    expect(wrapper.attributes('data-level')).toBe('warn')
    expect(wrapper.get('.status-dot').classes()).toContain('degraded')
    expect(wrapper.text()).toContain('charge soutenue')
  })

  it('turns red, and says what it costs', () => {
    const wrapper = machine({ cpu: 0.96, cores: 4, windowMs: 5_000, memory: null })

    expect(wrapper.attributes('data-level')).toBe('alert')
    expect(wrapper.get('.status-dot').classes()).toContain('offline')
    // A colour alone does not say what to do: the tooltip names the risk.
    expect(wrapper.text()).toContain('images')
  })

  it('colours the dot and the gauge from the same decision', () => {
    // Deux chemins finiraient par se contredire — pastille verte, jauge rouge —
    // and it is in that disagreement that one would stop believing the indicator.
    const wrapper = machine({ cpu: 0.96, cores: 4, windowMs: 5_000, memory: null })

    expect(wrapper.get('.gauge > span').attributes('style')).toContain('96%')
  })

  it('shows the memory beside the processor', () => {
    const wrapper = machine({ cpu: 0.31, cores: 8, windowMs: 5_000, memory: HEALTHY_MEMORY })

    expect(wrapper.text()).toContain('Mémoire')
    expect(wrapper.text()).toContain('25 %')
    expect(wrapper.text()).toContain('4,0 Go occupés sur 16,0')
  })

  it('does not take an unreadable memory for a full one', () => {
    const wrapper = machine({ cpu: 0.31, cores: 8, windowMs: 5_000, memory: null })

    expect(wrapper.attributes('data-level')).toBe('ok')
    expect(wrapper.text()).toContain('mémoire illisible')
  })

  it('does not add a native tooltip on top of its own', () => {
    const wrapper = machine({ cpu: 0.31, cores: 8, windowMs: 5_000, memory: HEALTHY_MEMORY })

    // A leftover `title` would show both, one over the other, a second apart.
    // The spoken announcement goes through `aria-label`.
    expect(wrapper.attributes('title')).toBeUndefined()
    expect(wrapper.attributes('aria-label')).toContain('31 %')
    expect(wrapper.get('.tooltip').attributes('aria-hidden')).toBe('true')
  })

  it('opens from the keyboard, with no mouse', () => {
    // The control app is also driven from the keyboard during a talk: a tooltip
    // that only opens on hover would be invisible to somebody still on shortcuts.
    expect(machine(null).attributes('tabindex')).toBe('0')
  })
})

describe('run mode', () => {
  it('stays quiet when everything is in production', () => {
    const wrapper = mount(ModeBadge, { props: { mode: { room: 'production', hub: 'production' } } })
    expect(wrapper.text()).toBe('')
  })

  it('cries out when the room and the hub are not on the same side', () => {
    const wrapper = mount(ModeBadge, { props: { mode: { room: 'dev', hub: 'production' } } })

    // A development room plugged into the event's hub would send real commands
    // from a machine that simulates everything.
    expect(wrapper.text()).toBe('dev · hub en production')
    expect(wrapper.html()).toContain('text-alert')
  })

  it('shouts in the other direction too', () => {
    const wrapper = mount(ModeBadge, { props: { mode: { room: 'production', hub: 'dev' } } })
    expect(wrapper.text()).toBe('hub en dev')
    expect(wrapper.html()).toContain('text-alert')
  })

  it('reports a development room, without alarming', () => {
    const wrapper = mount(ModeBadge, { props: { mode: { room: 'dev', hub: 'dev' } } })
    expect(wrapper.text()).toBe('mode dev')
    expect(wrapper.html()).toContain('text-warn')
  })

  it('waits for the first sync before concluding', () => {
    // Hub not reached yet: nothing to compare, and a premature alert would teach
    // people to ignore the badge.
    const wrapper = mount(ModeBadge, { props: { mode: { room: 'production', hub: null } } })
    expect(wrapper.text()).toBe('')
  })
})

describe('horloge', () => {
  it('reports a simulated time, otherwise the offset confuses', () => {
    const wrapper = mount(RoomClock, {
      props: { atMs: Date.parse('2026-10-30T09:00:00Z'), timeZone: 'Europe/Paris', simulated: true },
    })

    // Seeing 11:00 on an August morning with no explanation would cast doubt on
    // everything else on screen.
    expect(wrapper.text()).toContain('10:00:00')
    expect(wrapper.text()).toContain('simulée')
  })
})

describe('bandeau complet', () => {
  it('names the room, and says so when it is paired to nothing', () => {
    const without = payload()
    without.roomName = null
    without.state.roomId = null
    const wrapper = mount(ControlHeader, {
      props: { payload: without, nowMs: Date.now(), streamDead: false },
    })
    expect(wrapper.get('[data-role="room"]').text()).toBe('Salle non appairée')
  })

  it('says the screen is frozen, because a dead page looks like a live one', () => {
    const wrapper = mount(ControlHeader, {
      props: { payload: payload(), nowMs: Date.now(), streamDead: true },
    })

    // The clock and the countdown redraw every second from the last payload
    // received: only the talk's state stays stuck.
    expect(wrapper.get('[data-role="stream-dead"]').text()).toContain('écran figé')
  })

  it('shows the queue only when there is something in it', () => {
    const empty = mount(ControlHeader, {
      props: { payload: payload(), nowMs: Date.now(), streamDead: false },
    })
    expect(empty.find('[data-role="queue"]').exists()).toBe(false)

    const full = payload()
    full.diagnostics!.outboxDepth = 4
    const wrapper = mount(ControlHeader, {
      props: { payload: full, nowMs: Date.now(), streamDead: false },
    })
    expect(wrapper.get('[data-role="queue"]').text()).toBe('4 en attente')
  })
})

/**
 * Remote driving, seen from the room.
 *
 * The property to hold is not "the badge shows" but **"it takes nothing away"**:
 * the operator who is in the room keeps every one of their commands, whatever
 * happens to a phone gone off down a corridor or to a lock somebody forgot to
 * release.
 */
describe('driven remotely', () => {
  function withHolder(holder: string | null) {
    const base = payload()
    return { ...base, state: { ...base.state, remoteHolder: holder } }
  }

  it('names who is driving, rather than announce "occupée"', () => {
    const wrapper = mount(ControlHeader, {
      props: { payload: withHolder('regie@cloudnord.fr'), nowMs: Date.now(), streamDead: false },
    })

    // Without the name, a scene switching on its own reads as a failure — and one
    // goes looking for it where it is not, in the middle of a talk.
    expect(wrapper.get('[data-role="remote-holder"]').text()).toContain('regie@cloudnord.fr')
  })

  it('greys out none of the room\'s commands', () => {
    const wrapper = mount(ControlHeader, {
      props: { payload: withHolder('regie@cloudnord.fr'), nowMs: Date.now(), streamDead: false },
    })

    // The banner's buttons all stay active: the lock only shuts out the mobile
    // control apps among themselves.
    for (const button of wrapper.findAll('button')) {
      expect(button.attributes('disabled')).toBeUndefined()
    }
  })

  it('stays silent when nobody is driving remotely', () => {
    const wrapper = mount(ControlHeader, {
      props: { payload: withHolder(null), nowMs: Date.now(), streamDead: false },
    })
    expect(wrapper.find('[data-role="remote-holder"]').exists()).toBe(false)
  })

  it('does not show itself on the phone that is driving', () => {
    const wrapper = mount(ControlHeader, {
      props: {
        payload: withHolder('regie@cloudnord.fr'),
        nowMs: Date.now(),
        streamDead: false,
        remote: true,
      },
    })
    // The lock banner already says who holds the room; repeating it here would put
    // the same information twice on a screen with space for one.
    expect(wrapper.find('[data-role="remote-holder"]').exists()).toBe(false)
  })
})
