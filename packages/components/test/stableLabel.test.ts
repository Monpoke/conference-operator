import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StableLabel from '../src/common/StableLabel.vue'

describe('StableLabel', () => {
  it('reads as its current label, and keeps the room of the others', () => {
    const wrapper = mount(StableLabel, { props: { current: 'Pause', labels: ['Pause', 'Reprendre la lecture'] } })
    expect(wrapper.text()).toBe('Pause')
    const sizer = wrapper.get('[aria-hidden="true"]')
    expect(sizer.attributes('data-label')).toBe('Reprendre la lecture')
    expect(sizer.classes()).toContain('invisible')
  })
})
