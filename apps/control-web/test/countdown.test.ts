import { NO_EDITING_MARKS } from '@conference-operator/contract'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Countdown from '../src/components/Countdown.vue'
import RecordingTimer from '../src/components/RecordingTimer.vue'
import { countdownFor } from '../src/lib/countdown.js'
import { START_MS, END_MS, payload, talk } from './fixtures.js'

/**
 * The large number, and what it aims at.
 *
 * It is the only figure the operator reads continuously in a talk's last two
 * minutes. Aiming at the wrong thing — counting towards an end when what is
 * awaited is a start — makes it wrong without making it visible: it descends, so
 * it looks right.
 */

describe('what the stopwatch counts', () => {
  it('counts towards the start while the slot has not begun', () => {
    const count = countdownFor(payload(), START_MS - 10 * 60_000)

    // Counting towards the end from the outset gave "2:01:59" in large type at
    // 8:38 for the 9:50 talk: a figure that reads as a talk under way, and that was
    // read that way.
    expect(count).toEqual({ ms: 10 * 60_000, beforeStart: true })
  })

  it('counts towards the end as soon as a talk is started, even early', () => {
    const state = payload()
    state.state.sessionStates = { 'talk-1': 'running' }

    // Once "Commencer" has been pressed, it is the gap against the program that
    // decides the rest of the day.
    const count = countdownFor(state, START_MS - 10 * 60_000)
    expect(count?.beforeStart).toBe(false)
    expect(count?.ms).toBe(END_MS - (START_MS - 10 * 60_000))
  })

  it('goes negative on an overrun, rather than stopping at zero', () => {
    const state = payload()
    state.state.sessionStates = { 'talk-1': 'running' }
    expect(countdownFor(state, END_MS + 90_000)?.ms).toBe(-90_000)
  })

  it('aims at the next talk as soon as this one has ended', () => {
    const next = talk({ id: 'talk-2', startsAtMs: END_MS + 15 * 60_000, endsAtMs: null })
    const state = payload({ sessions: [talk(), next] })
    state.state.sessionStates = { 'talk-1': 'ended' }

    /*
     * The stopwatch used to carry on over its slot: "Terminer" pressed at 10:35,
     * and fifteen minutes were left on screen for a talk the room had just left.
     */
    const count = countdownFor(state, END_MS)
    expect(count).toEqual({ ms: 15 * 60_000, beforeStart: true })
  })

  it('counts nothing down any more when nothing follows', () => {
    const state = payload()
    state.state.sessionStates = { 'talk-1': 'ended' }
    expect(countdownFor(state, END_MS)).toBe(null)
  })

  it('skips a break: a lunch is not what one is waiting for', () => {
    const brk = talk({ id: 'pause-1', kind: 'break', startsAtMs: END_MS + 60_000 })
    const next = talk({ id: 'talk-2', startsAtMs: END_MS + 45 * 60_000, endsAtMs: null })
    const state = payload({ sessions: [talk(), brk, next] })
    state.state.sessionStates = { 'talk-1': 'ended' }

    expect(countdownFor(state, END_MS)?.ms).toBe(45 * 60_000)
  })
})

describe('rendering the stopwatch', () => {
  it('dims a countdown that demands nothing, alerts on an overrun', () => {
    const before = mount(Countdown, { props: { payload: payload(), atMs: START_MS - 600_000 } })
    expect(before.get('[data-role="countdown"]').classes()).toContain('text-dim')
    // The badge says what the number counts down: the two read alike without it.
    expect(before.text()).toContain('à venir')

    const state = payload()
    state.state.sessionStates = { 'talk-1': 'running' }
    const after = mount(Countdown, { props: { payload: state, atMs: END_MS + 60_000 } })
    expect(after.get('[data-role="countdown"]').classes()).toContain('text-alert')
    expect(after.text()).not.toContain('à venir')
  })

  it('warns in the last five minutes, when one no longer looks away', () => {
    const state = payload()
    state.state.sessionStates = { 'talk-1': 'running' }
    const wrapper = mount(Countdown, { props: { payload: state, atMs: END_MS - 120_000 } })

    expect(wrapper.get('[data-role="countdown"]').classes()).toContain('text-warn')
    expect(wrapper.text()).toContain('2:00')
  })

  it('says "--:--" rather than zero when there is nothing to drive', () => {
    const state = payload()
    state.state.targetSession = null
    const wrapper = mount(Countdown, { props: { payload: state, atMs: START_MS } })
    expect(wrapper.get('[data-role="countdown"]').text()).toBe('--:--')
  })
})

describe('take stopwatch', () => {
  const REC = { active: true, markers: 0, startedAtMs: 1_000_000, startedAtCorrectedMs: null, editing: NO_EDITING_MARKS }

  it('stays dark outside a recording', () => {
    const wrapper = mount(RecordingTimer, {
      props: { recording: null, realMs: 1_000_000, roomMs: 1_000_000 },
    })
    expect(wrapper.text()).toBe('00:00')
    expect(wrapper.classes()).toContain('text-dim')
  })

  it('counts in real time when the payload says nothing else', () => {
    const wrapper = mount(RecordingTimer, {
      props: { recording: REC, realMs: 1_000_000 + 95_000, roomMs: 9_999_999 },
    })
    expect(wrapper.text()).toBe('01:35')
  })

  it('follows the hub\'s clock when the start is dated against it', () => {
    // The development case, where a day is run through by pushing it: the
    // stopwatch must say the same thing as the duration finally recorded.
    const wrapper = mount(RecordingTimer, {
      props: {
        recording: { ...REC, startedAtCorrectedMs: 5_000_000 },
        realMs: 1_000_000,
        roomMs: 5_000_000 + 62_000,
      },
    })
    expect(wrapper.text()).toBe('01:02')
  })

  it('never counts backwards', () => {
    // A clock pushed backwards returned a negative, displayed as "-1:-5".
    const wrapper = mount(RecordingTimer, {
      props: { recording: REC, realMs: 900_000, roomMs: 900_000 },
    })
    expect(wrapper.text()).toBe('00:00')
  })
})
