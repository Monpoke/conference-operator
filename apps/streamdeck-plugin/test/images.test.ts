import { describe, expect, it } from 'vitest'
import type { DisplayPayload } from '@conference-operator/contract/room-display'
import type { ButtonFace } from '../src/core/buttons.js'
import { keyImage, pictogram } from '../src/core/images.js'

const idle: ButtonFace = { title: '', on: false, offline: false }
const lit: ButtonFace = { title: '', on: true, offline: false }
const room = (sceneRole: string) => ({ state: { sceneRole } }) as unknown as DisplayPayload

describe('the key pictures say what the key does', () => {
  it('draws starting and ending a talk differently', () => {
    expect(pictogram({ kind: 'session', which: 'start' }, idle, null).glyph).toBe('play')
    expect(pictogram({ kind: 'session', which: 'start-norec' }, idle, null).glyph).toBe('playNoRec')
    expect(pictogram({ kind: 'session', which: 'end' }, idle, null).glyph).toBe('stop')
  })

  it('shows what pressing the recording key will do', () => {
    expect(pictogram({ kind: 'recording' }, idle, null).glyph).toBe('record')
    expect(pictogram({ kind: 'recording' }, lit, null)).toEqual({ glyph: 'stop', ground: '#e11d48' })
  })

  it('tells the marks apart, and a muted source from a live one', () => {
    expect(pictogram({ kind: 'mark', mark: 'debut' }, idle, null).glyph).toBe('markStart')
    expect(pictogram({ kind: 'mark', mark: 'fin' }, idle, null).glyph).toBe('markEnd')
    expect(pictogram({ kind: 'mark', mark: 'chapitre' }, idle, null).glyph).toBe('bookmark')
    expect(pictogram({ kind: 'mic', input: 'Micro' }, lit, null).glyph).toBe('micOff')
    expect(pictogram({ kind: 'mic', input: 'Micro' }, idle, null).glyph).toBe('mic')
  })

  it('draws each scene and screen with its own pictogram', () => {
    expect(pictogram({ kind: 'scene', role: 'LIVE' }, lit, null)).toEqual({ glyph: 'broadcast', ground: '#e11d48' })
    expect(pictogram({ kind: 'scene', role: 'HOLD' }, idle, null).glyph).toBe('overlay')
    expect(pictogram({ kind: 'display', mode: 'countdown' }, idle, null).glyph).toBe('hourglass')
  })

  it('draws the toggle as a swap, red while the first scene is on air', () => {
    expect(pictogram({ kind: 'scene-toggle' }, lit, room('LIVE'))).toEqual({ glyph: 'swap', ground: '#e11d48' })
    expect(pictogram({ kind: 'scene-toggle' }, idle, room('HOLD'))).toEqual({ glyph: 'swap', ground: '#1d2334' })
  })

  it('greys the picture out while the room does not answer', () => {
    const image = keyImage({ kind: 'recording' }, { title: '', on: false, offline: true }, null)
    expect(image.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(Buffer.from(image.split(',')[1]!, 'base64').toString()).toContain('#2b3348')
  })
})
