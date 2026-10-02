import { describe, expect, it } from 'vitest'
import { featuresOf, withdrawnScreens } from '../src/lib/features.js'
import { payload } from './fixtures.js'

describe('the wall and questions switches, in the control app', () => {
  it('leaves everything on for a room that does not say', () => {
    const data = payload()
    delete (data as { features?: unknown }).features
    expect(featuresOf(data)).toEqual({ wall: true, questions: true })
    expect(withdrawnScreens(data)).toEqual(data.screensDisabled)
  })

  it('drops "Question choisie" with the questions, and keeps the wall screen', () => {
    const data = { ...payload(), features: { wall: true, questions: false } }
    expect(withdrawnScreens(data)).toContain('question')
    expect(withdrawnScreens(data)).not.toContain('wall')
  })

  it('drops the wall screen only once both are off', () => {
    expect(withdrawnScreens({ ...payload(), features: { wall: false, questions: true } })).not.toContain('wall')
    expect(withdrawnScreens({ ...payload(), features: { wall: false, questions: false } })).toEqual(
      expect.arrayContaining(['wall', 'question']),
    )
  })

  it('keeps what the hub already withdrew', () => {
    const data = { ...payload(), screensDisabled: ['sponsors' as const], features: { wall: false, questions: false } }
    expect(withdrawnScreens(data)).toEqual(expect.arrayContaining(['sponsors', 'wall', 'question']))
  })
})
