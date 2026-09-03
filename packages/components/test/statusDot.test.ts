import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StatusDot from '../src/domain/StatusDot.vue'

/**
 * The two-part dot, and the confusion it exists to prevent.
 *
 * Fill says where the talk is; outline says what we know of the room. A dot
 * carrying only connectivity showed a room in green while it was ten minutes
 * over its slot — "green" only ever meant "the machine answers".
 */
describe('StatusDot', () => {
  it('paints the talk and outlines the room, separately', () => {
    const wrapper = mount(StatusDot, {
      props: { state: 'depassement', connectivity: 'DEGRADED' },
    })

    expect(wrapper.classes()).toContain('overrun')
    expect(wrapper.classes()).toContain('unsure')
  })

  it('leaves an unknown room hollow rather than claiming a colour', () => {
    // Not knowing and painting it in colour is exactly what the outline exists
    // to prevent.
    expect(mount(StatusDot, { props: { state: 'en-cours' } }).classes()).toContain('silent')
  })

  it('takes no fill from the appearance table when given a machine level', () => {
    // A machine has no talk: `level` and `state` describe different things, and
    // offering both would let one be painted with the other's meaning.
    const wrapper = mount(StatusDot, { props: { level: 'alert', connectivity: 'ONLINE' } })
    expect(wrapper.classes()).toContain('offline')
  })

  it('leaves a machine dot solid: there is no room to doubt', () => {
    /*
     * The outline says what we know of a *room*. A CPU is not a room — nothing
     * about it is uncertain in that sense. Applying the rule turned both header
     * dots of the room control hollow: a green ring where a green disc belongs.
     */
    expect(mount(StatusDot, { props: { level: 'ok' } }).classes()).toEqual(['status-dot'])
    expect(mount(StatusDot, { props: { level: 'alert' } }).classes()).not.toContain('silent')
  })

  it('names a machine level in the machine vocabulary', () => {
    /*
     * `offline` and `overrun` paint the same red, so nothing would look wrong
     * either way. The stylesheet keeps the two families apart all the same, and
     * says why: one describes a machine, the other a talk. A CPU at 95% called
     * "overrun" would send whoever reads the sheet next looking for a talk that
     * is not there.
     */
    const machine = mount(StatusDot, { props: { level: 'warn' } }).classes()
    expect(machine).toContain('degraded')
    expect(machine).not.toContain('ending-soon')
  })

  it('carries the word when asked, because not everyone tells tints apart', () => {
    const wrapper = mount(StatusDot, { props: { state: 'retard', connectivity: 'ONLINE', word: true } })
    expect(wrapper.text()).toBe('retard au démarrage')
  })

  it('does not invent the vocabulary', () => {
    // The class names come from shared business code that a page which will
    // never be Vue also reads. This component renders them; it does not decide
    // them.
    expect(mount(StatusDot, { props: { state: 'fin-proche', connectivity: 'ONLINE' } }).classes())
      .toContain('ending-soon')
  })
})
