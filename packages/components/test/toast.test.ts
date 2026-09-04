import { mount } from '@vue/test-utils'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import Toaster from '../src/common/Toaster.vue'
import { NOTICE_MS, useToast } from '../src/common/toast.js'

/**
 * The queue is the behaviour change worth pinning.
 *
 * Three implementations were replaced here, and all three *replaced* the
 * current notice instead of queueing: two failures in a row showed one message,
 * and the operator saw the second only. Restoring that by accident would look
 * like a simplification.
 */
beforeEach(() => {
  useToast().clear()
  vi.useFakeTimers()
})

describe('notices', () => {
  it('keeps both when two things fail in a row', () => {
    const toast = useToast()
    toast.fail('OBS-A ne répond pas')
    toast.fail('OBS-B ne répond pas')

    expect(toast.notices.value.map((notice) => notice.text)).toEqual([
      'OBS-A ne répond pas',
      'OBS-B ne répond pas',
    ])
  })

  it('tells a success from a failure', () => {
    const toast = useToast()
    toast.say('Message publié.')
    toast.fail('Refusé.')

    expect(toast.notices.value.map((notice) => notice.failed)).toEqual([false, true])
  })

  it('lets each notice go on its own clock', () => {
    const toast = useToast()
    toast.say('premier')
    vi.advanceTimersByTime(NOTICE_MS / 2)
    toast.say('second')

    vi.advanceTimersByTime(NOTICE_MS / 2 + 1)
    // The first has served its time; the second still has half of its own left.
    expect(toast.notices.value.map((notice) => notice.text)).toEqual(['second'])

    vi.advanceTimersByTime(NOTICE_MS)
    expect(toast.notices.value).toEqual([])
  })
})

/**
 * The exception to the queue, and why it is not a return to the replacement.
 *
 * A queue is right for facts that each happened once. A gesture one repeats —
 * hunting for a shot switches the scene three times in ten seconds — is one
 * fact restated, and stacking it puts three rectangles between the operator and
 * the room. The key is what tells the two apart, and only a caller can know
 * which of the two it is raising.
 */
describe('notices that repeat', () => {
  it('takes the place of the last one carrying the same key', () => {
    const toast = useToast()
    toast.say('Scène : LIVE', { key: 'scene.set' })
    toast.say('Scène : HOLD', { key: 'scene.set' })

    expect(toast.notices.value.map((notice) => notice.text)).toEqual(['Scène : HOLD'])
  })

  it('leaves the unkeyed ones where they are', () => {
    const toast = useToast()
    toast.fail('OBS-A ne répond pas')
    toast.say('Scène : LIVE', { key: 'scene.set' })
    toast.say('Scène : HOLD', { key: 'scene.set' })

    expect(toast.notices.value.map((notice) => notice.text)).toEqual([
      'OBS-A ne répond pas',
      'Scène : HOLD',
    ])
  })

  it('gives the replacement a full clock of its own', () => {
    const toast = useToast()
    toast.say('Scène : LIVE', { key: 'scene.set' })
    vi.advanceTimersByTime(NOTICE_MS - 1)
    toast.say('Scène : HOLD', { key: 'scene.set' })

    /*
     * The replaced notice's timer goes on running and fires here: it must find
     * nothing to take away. Removing by id and not by key is what makes that so
     * — the mistake would blank the screen a millisecond after the switch.
     */
    vi.advanceTimersByTime(2)
    expect(toast.notices.value.map((notice) => notice.text)).toEqual(['Scène : HOLD'])
  })
})

describe('dismissing a notice', () => {
  it('takes it away before its time, and only it', () => {
    const toast = useToast()
    toast.say('premier')
    toast.fail('second')
    const first = toast.notices.value[0]!.id

    toast.dismiss(first)

    expect(toast.notices.value.map((notice) => notice.text)).toEqual(['second'])
  })

  it('closes the one clicked, the whole card being the target', async () => {
    const toast = useToast()
    toast.say('Scène : LIVE')
    toast.fail('OBS-A ne répond pas')
    const wrapper = mount(Toaster)

    /*
     * The card, not a cross in its corner.
     *
     * Aiming at a twelve-pixel target in a dark room means stopping and looking
     * — that is, taking one's eyes off the stage for a gesture that does not
     * deserve it. The notice stack next door made the same choice.
     */
    await wrapper.get('button').trigger('click')

    expect(toast.notices.value.map((notice) => notice.text)).toEqual(['OBS-A ne répond pas'])
    expect(wrapper.findAll('button')).toHaveLength(1)
  })

  it('says nothing of an id that has already gone', () => {
    const toast = useToast()
    toast.say('premier')
    const id = toast.notices.value[0]!.id

    toast.dismiss(id)
    // Dismissed a hair after its expiry: the ordinary race, not a fault.
    expect(() => toast.dismiss(id)).not.toThrow()
    expect(toast.notices.value).toEqual([])
  })
})
