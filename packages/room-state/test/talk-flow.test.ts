import { describe, expect, it } from 'vitest'
import {
  TOO_EARLY_MS,
  endAsksStopRecording,
  endEarly,
  endSteps,
  runTalkSteps,
  startAsksRecording,
  startSteps,
  startTooEarly,
  type TalkFlowInput,
} from '../src/talk-flow.js'

const START = 1_000_000_000

function room(patch: Partial<TalkFlowInput> = {}): TalkFlowInput {
  return {
    nowMs: START - 60_000,
    target: { id: 'talk-1', startsAtMs: START, endsAtMs: START + 45 * 60_000 },
    pinnedSessionId: null,
    recording: false,
    config: null,
    ...patch,
  }
}

describe('starting a talk', () => {
  it('asks when the start is very early, unless the talk was forced', () => {
    expect(startTooEarly(room())).toBe(false)
    expect(startTooEarly(room({ nowMs: START - TOO_EARLY_MS - 1 }))).toBe(true)
    expect(startTooEarly(room({ nowMs: START - TOO_EARLY_MS - 1, pinnedSessionId: 'talk-1' }))).toBe(false)
  })

  it('asks about the recording only when nothing records and the guard is on', () => {
    expect(startAsksRecording(room())).toBe(true)
    expect(startAsksRecording(room({ recording: true }))).toBe(false)
    expect(startAsksRecording(room({ config: { promptRecordingOnStart: false } }))).toBe(false)
  })

  it('records first, then starts, then switches to the start scene', () => {
    expect(startSteps(room(), true).map((step) => step.gesture)).toEqual([
      { action: 'recording.start' },
      { action: 'session.start' },
      { action: 'scene.set', role: 'LIVE' },
    ])
    // A room set to switch nothing at start keeps its scene.
    expect(startSteps(room({ config: { sceneOnStart: null } }), false).map((step) => step.gesture)).toEqual([
      { action: 'session.start' },
    ])
  })
})

describe('ending a talk', () => {
  it('asks when the slot is not over, and about a take still running', () => {
    expect(endEarly(room({ nowMs: START + 10 * 60_000 }))).toBe(true)
    expect(endEarly(room({ nowMs: START + 50 * 60_000 }))).toBe(false)
    expect(endAsksStopRecording(room({ recording: true }))).toBe(true)
    expect(endAsksStopRecording(room({ recording: true, config: { promptRecordingOnStop: false } }))).toBe(false)
  })

  it('stops the take first, then ends', () => {
    expect(endSteps(true).map((step) => step.gesture)).toEqual([{ action: 'recording.stop' }, { action: 'session.end' }])
  })
})

describe('playing the steps', () => {
  it('stops at a failed guard, and only there', async () => {
    const sent: string[] = []
    const held = await runTalkSteps(startSteps(room(), true), async (gesture) => {
      sent.push(gesture.action)
      return { ok: gesture.action !== 'recording.start' }
    })
    expect(held).toBe(false)
    expect(sent).toEqual(['recording.start'])
  })
})
