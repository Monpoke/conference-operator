import { describe, expect, it, vi, beforeEach } from 'vitest'
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
