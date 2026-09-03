import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Badge from '../src/common/Badge.vue'
import Button from '../src/common/Button.vue'

/**
 * The two decisions this design system made on purpose, and that an
 * off-the-shelf component library would quietly undo.
 *
 * Neither is a matter of taste: one comes from a dark room during a talk, the
 * other from a table people scan rather than read. Both were written down where
 * they were decided, and these tests are what stops a later "let us just use
 * the standard button" from erasing them without saying so.
 */
describe('Button', () => {
  it('keeps targets wide enough for a dark room', () => {
    const wrapper = mount(Button, { slots: { default: 'Enregistrer' } })

    // shadcn's button is `h-9 px-4 py-2`, a density meant for somebody leaning
    // into a desktop app. Fourteen vertical pixels is the deliberate choice
    // here, and it is what makes the command findable without looking.
    expect(wrapper.classes()).toContain('py-3.5')
  })

  it('reports a state rather than offering an action when active', () => {
    const idle = mount(Button, { props: { active: false } })
    const active = mount(Button, { props: { active: true } })

    expect(idle.classes()).not.toContain('bg-brand')
    expect(active.classes()).toContain('bg-brand')
  })

  it('lets the caller override without fighting the variant', () => {
    const wrapper = mount(Button, { props: { class: 'w-full' } })
    expect(wrapper.classes()).toContain('w-full')
    expect(wrapper.classes()).toContain('rounded-lg')
  })

  it('cannot be clicked while disabled', async () => {
    const wrapper = mount(Button, { props: { disabled: true } })
    await wrapper.trigger('click')
    expect(wrapper.attributes('disabled')).toBeDefined()
  })
})

describe('Badge', () => {
  it('stays readable at the size the table needs', () => {
    const wrapper = mount(Badge, { slots: { default: 'en cours' } })

    // `text-sm`, not `text-xs`: against 13 px of base text, a 12 px label in
    // tightened capitals read like a footnote — when it is the talk's state
    // people come to that column to find.
    expect(wrapper.classes()).toContain('text-sm')
  })

  it('carries the word, not only the colour', () => {
    // Not everyone tells the tints apart, and the badge is read from across a
    // room. The word is the information; the colour only speeds it up.
    expect(mount(Badge, { slots: { default: 'terminée' } }).text()).toBe('terminée')
  })
})
