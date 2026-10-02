import { describe, expect, it } from 'vitest'
import type { DisplayPayload } from '@conference-operator/contract/room-display'
import { decide, elapsed, faceOf, pressOf, LONG_PRESS_MS } from '../src/core/buttons.js'
import { normalizeBase } from '../src/core/regie.js'

/** The fields the buttons read, nothing else: the rest of a payload is irrelevant here. */
function payload(state: Record<string, unknown> = {}, diagnostics: Record<string, unknown> | null = null): DisplayPayload {
  return {
    state: {
      mode: 'loop',
      sceneRole: 'HOLD',
      recording: false,
      streaming: false,
      connectivity: 'ONLINE',
      currentSession: null,
      message: null,
      audioInputs: [{ name: 'Micro cravate', muted: { A: false, B: false } }],
      ...state,
    },
    diagnostics,
  } as unknown as DisplayPayload
}

const NOW = 1_000_000

describe('what a key shows', () => {
  it('greys every key out while the room machine does not answer', () => {
    expect(faceOf({ kind: 'recording' }, null, NOW)).toMatchObject({ offline: true, on: false })
  })

  it("names the scenes as the control app's Projection panel does", () => {
    expect(faceOf({ kind: 'scene', role: 'LIVE' }, payload(), NOW).title).toBe('Direct')
    expect(faceOf({ kind: 'scene', role: 'HOLD' }, payload(), NOW)).toMatchObject({ title: 'Habillage', on: true })
  })

  it('toggles from what is really on air, and says which scene that is', () => {
    expect(faceOf({ kind: 'scene-toggle' }, payload({ sceneRole: 'LIVE' }), NOW)).toMatchObject({ title: 'Direct', on: true })
    expect(faceOf({ kind: 'scene-toggle' }, payload({ sceneRole: 'HOLD' }), NOW)).toMatchObject({ title: 'Habillage', on: false })
    expect(decide({ kind: 'scene-toggle' }, payload({ sceneRole: 'LIVE' }), 'short')).toEqual({
      gesture: { action: 'scene.set', role: 'HOLD' },
    })
    // Neither of the two on air (a relay): back to the first.
    expect(decide({ kind: 'scene-toggle' }, payload({ sceneRole: 'RELAY' }), 'short')).toEqual({
      gesture: { action: 'scene.set', role: 'LIVE' },
    })
  })

  it('lights the scene and the screen the room is really on', () => {
    expect(faceOf({ kind: 'scene', role: 'LIVE' }, payload({ sceneRole: 'LIVE' }), NOW).on).toBe(true)
    expect(faceOf({ kind: 'scene', role: 'LIVE' }, payload(), NOW).on).toBe(false)
    expect(faceOf({ kind: 'display', mode: 'loop' }, payload(), NOW).on).toBe(true)
  })

  it('shows the recording running, with its duration', () => {
    const face = faceOf(
      { kind: 'recording' },
      payload({ recording: true }, { recording: { active: true, startedAtMs: NOW - 125_000, markers: 0, editing: { startMs: null, endMs: null } } }),
      NOW,
    )
    expect(face).toMatchObject({ on: true, title: 'REC\n02:05' })
  })

  it('ticks the editing marks once set', () => {
    const diagnostics = { recording: { active: true, startedAtMs: NOW, markers: 3, editing: { startMs: 12_000, endMs: null } } }
    expect(faceOf({ kind: 'mark', mark: 'debut' }, payload({}, diagnostics), NOW).on).toBe(true)
    expect(faceOf({ kind: 'mark', mark: 'fin' }, payload({}, diagnostics), NOW).on).toBe(false)
    expect(faceOf({ kind: 'mark', mark: 'chapitre' }, payload({}, diagnostics), NOW).title).toBe('Chapitre\n3')
  })

  it('shows a muted source, and says when the source is unknown', () => {
    const cut = payload({ audioInputs: [{ name: 'Micro cravate', muted: { A: true, B: null } }] })
    expect(faceOf({ kind: 'mic', input: 'Micro cravate' }, cut, NOW).on).toBe(true)
    expect(faceOf({ kind: 'mic', input: 'Ambiance' }, cut, NOW).title).toContain('?')
  })

  it('says which OBS or hub link is down', () => {
    const face = faceOf(
      { kind: 'status' },
      payload({ connectivity: 'OFFLINE' }, { obs: { A: { connected: true }, B: { connected: false } } }),
      NOW,
    )
    expect(face.title).toBe('OBS-A ✓\nOBS-B ✗\nHub ✗')
    expect(face.on).toBe(false)
  })
})

describe('what a press sends', () => {
  it('starts on a short press, and only stops on a long one', () => {
    expect(decide({ kind: 'recording' }, payload(), 'short')).toEqual({ gesture: { action: 'recording.start' } })
    const running = payload({ recording: true })
    expect(decide({ kind: 'recording' }, running, 'short')).toEqual({ hint: "Maintenir pour arrêter l'enregistrement" })
    expect(decide({ kind: 'recording' }, running, 'long')).toEqual({ gesture: { action: 'recording.stop' } })
  })

  it('holds back ending the talk and cutting the stream the same way', () => {
    expect(decide({ kind: 'session', which: 'end' }, payload(), 'short')).toHaveProperty('hint')
    expect(decide({ kind: 'stream' }, payload({ streaming: true }), 'short')).toHaveProperty('hint')
  })

  it('sends the editing marks with their role, and a chapter without', () => {
    expect(decide({ kind: 'mark', mark: 'debut' }, payload(), 'short')).toEqual({
      gesture: { action: 'recording.mark', label: 'Début', role: 'debut' },
    })
    expect(decide({ kind: 'mark', mark: 'chapitre' }, payload(), 'short')).toEqual({
      gesture: { action: 'recording.mark', label: 'Chapitre', role: null },
    })
  })

  it('toggles a source from what the room says, not from what the key last did', () => {
    expect(decide({ kind: 'mic', input: 'Micro cravate' }, payload(), 'short')).toEqual({
      gesture: { action: 'audio.mute', input: 'Micro cravate', muted: true },
    })
  })

  it('clears the message only when there is one, and sends nothing while offline', () => {
    expect(decide({ kind: 'message-clear' }, payload(), 'short')).toBeNull()
    expect(decide({ kind: 'message-clear' }, payload({ message: { text: 'x', level: 'info', expiresAtMs: null } }), 'short')).toEqual({
      gesture: { action: 'screen.message.clear' },
    })
    expect(decide({ kind: 'scene', role: 'LIVE' }, null, 'short')).toEqual({ hint: 'Poste de salle injoignable' })
  })
})

describe('small helpers', () => {
  it('tells a long press from a short one', () => {
    expect(pressOf(0, LONG_PRESS_MS - 1)).toBe('short')
    expect(pressOf(0, LONG_PRESS_MS)).toBe('long')
  })

  it('reads durations as a clock', () => {
    expect(elapsed(0, 59_000)).toBe('00:59')
    expect(elapsed(0, 3_725_000)).toBe('1:02:05')
  })

  it('tidies the address typed in the settings', () => {
    expect(normalizeBase('')).toBe('http://127.0.0.1:7788')
    expect(normalizeBase('192.168.1.20:7788/')).toBe('http://192.168.1.20:7788')
    expect(normalizeBase('http://localhost:7790')).toBe('http://localhost:7790')
  })
})

describe("the talk key follows the control app's sequence", () => {
  const SLOT = NOW + 5 * 60_000
  /** A room with a talk five minutes away, and OBS-B idle unless told otherwise. */
  function talkRoom(patch: Record<string, unknown> = {}, recording = false, config: Record<string, unknown> | null = null) {
    return payload(
      {
        targetSession: { id: 'talk-1', title: 'Le futur du cloud', startsAtMs: SLOT, endsAtMs: SLOT + 45 * 60_000 },
        pinnedSessionId: null,
        serverTimeOffsetMs: 0,
        ...patch,
      },
      { recording: { active: recording, startedAtMs: null, markers: 0, editing: { startMs: null, endMs: null } }, config },
    )
  }
  const gestures = (decision: unknown) =>
    (decision as { steps: { gesture: Record<string, unknown> }[] }).steps.map((step) => step.gesture)

  it('records first when nothing records, then starts, then switches the scene', () => {
    expect(gestures(decide({ kind: 'session', which: 'start' }, talkRoom(), 'short', NOW))).toEqual([
      { action: 'recording.start' },
      { action: 'session.start' },
      { action: 'scene.set', role: 'LIVE' },
    ])
  })

  it('starts without recording when the key is set so, or when the room does not ask', () => {
    expect(gestures(decide({ kind: 'session', which: 'start-norec' }, talkRoom(), 'short', NOW))[0]).toEqual({ action: 'session.start' })
    const noGuard = talkRoom({}, false, { promptRecordingOnStart: false, sceneOnStart: 'HOLD' })
    expect(gestures(decide({ kind: 'session', which: 'start' }, noGuard, 'short', NOW))).toEqual([
      { action: 'session.start' },
      { action: 'scene.set', role: 'HOLD' },
    ])
  })

  it('asks a long press for a start very early, and says so on the key', () => {
    const early = talkRoom({ targetSession: { id: 'talk-1', title: 'X', startsAtMs: NOW + 90 * 60_000, endsAtMs: null } })
    expect(faceOf({ kind: 'session', which: 'start' }, early, NOW).title).toBe('En avance\n1 h 30')
    expect(decide({ kind: 'session', which: 'start' }, early, 'short', NOW)).toEqual({ hint: 'Maintenir : très en avance' })
    expect(decide({ kind: 'session', which: 'start' }, early, 'long', NOW)).toHaveProperty('steps')
  })

  it('stops the take with the end when the room says so', () => {
    expect(gestures(decide({ kind: 'session', which: 'end' }, talkRoom({}, true), 'long', NOW))).toEqual([
      { action: 'recording.stop' },
      { action: 'session.end' },
    ])
  })
})
