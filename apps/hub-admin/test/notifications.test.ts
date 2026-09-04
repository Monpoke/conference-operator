import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LEVELS,
  passes,
  readLevels,
  roomAlerts,
  type Levels,
  type RoomSeen,
} from '../src/stores/notifications.js'

/**
 * What the console warns about, and whom.
 *
 * The decision of *what* to announce is a pure function, exported on purpose: it
 * is the only part of the system worth exercising with no browser, no
 * permission et sans service worker. Le reste — demander l'autorisation,
 * subscribing to push — has no behaviour of its own to protect: it chains APIs the
 * browser owns.
 */

const ROOM = {
  roomId: 'track-1',
  name: 'Track #1',
  conference: 'en-cours',
  connectivity: 'ONLINE',
  currentSession: { title: 'Vue et les régies' },
}

function views(overrides: Partial<RoomSeen> = {}): Map<string, RoomSeen> {
  return new Map([['track-1', { conference: 'en-cours', connectivity: 'ONLINE', ...overrides }]])
}

describe('setting read from storage', () => {
  it('treats the old "1" setting as the defaults', () => {
    // It meant "on": reading it as an empty object would silently switch off
    // notifications somebody had accepted.
    const storage = { getItem: () => '"1"' } as unknown as Storage
    expect(readLevels(storage)).toEqual(DEFAULT_LEVELS)
  })

  it('falls back on the defaults rather than fail on unreadable storage', () => {
    const storage = { getItem: () => '{ pas du json' } as unknown as Storage
    expect(readLevels(storage)).toEqual(DEFAULT_LEVELS)
  })

  it('fills in a partial setting', () => {
    const storage = { getItem: () => '{"technique":"rien"}' } as unknown as Storage
    expect(readLevels(storage)).toEqual({ technique: 'rien', exploitation: 'essentiel' })
  })
})

describe('scope', () => {
  const tout: Levels = { technique: 'tout', exploitation: 'tout' }
  const essentiel: Levels = { technique: 'essentiel', exploitation: 'essentiel' }
  const rien: Levels = { technique: 'rien', exploitation: 'rien' }

  it('lets the essentials through to whoever asks for the essentials', () => {
    expect(passes(essentiel, 'technique', 'essentiel')).toBe(true)
  })

  it('holds back the ordinary narrative from whoever wants only the essentials', () => {
    expect(passes(essentiel, 'exploitation', 'tout')).toBe(false)
    expect(passes(tout, 'exploitation', 'tout')).toBe(true)
  })

  it('lets nothing through to whoever wants nothing', () => {
    expect(passes(rien, 'technique', 'essentiel')).toBe(false)
  })

  it('sets the two families separately', () => {
    // Somebody may want to know everything about the machines and nothing about the day.
    const mixed: Levels = { technique: 'tout', exploitation: 'rien' }
    expect(passes(mixed, 'technique', 'tout')).toBe(true)
    expect(passes(mixed, 'exploitation', 'essentiel')).toBe(false)
  })
})

describe('ce qui change dans une salle', () => {
  it('says nothing on the first load', () => {
    // Announcing six rooms' initial state when the console opens
    // noierait ce qui change vraiment.
    expect(roomAlerts(new Map(), [ROOM])).toEqual([])
  })

  it('announces a room that no longer answers, as an essential', () => {
    const [first] = roomAlerts(views(), [{ ...ROOM, connectivity: 'OFFLINE' }])
    expect(first?.family).toBe('technique')
    expect(first?.alert.scope).toBe('essentiel')
    expect(first?.alert.title).toContain('ne répond plus')
  })

  it("reserves a room's return for whoever wants to follow everything", () => {
    // A relief, not a decision.
    const [first] = roomAlerts(views({ connectivity: 'OFFLINE' }), [ROOM])
    expect(first?.alert.scope).toBe('tout')
  })

  it('makes the overrun an essential: it is what shifts the day', () => {
    const [first] = roomAlerts(views(), [{ ...ROOM, conference: 'depassement' }])
    expect(first?.family).toBe('exploitation')
    expect(first?.alert.scope).toBe('essentiel')
  })

  it("keeps the machine's key apart from the talk's", () => {
    const alerts = roomAlerts(views({ connectivity: 'OFFLINE', conference: 'pas-commencee' }), [
      { ...ROOM, conference: 'depassement' },
    ])
    // Two keys per room: a "c'est parti" must never come and erase an unread
    // "ne répond plus".
    expect(alerts.map((entry) => entry.alert.key).sort()).toEqual([
      'conf-track-1',
      'salle-track-1',
    ])
  })

  it('stays silent when nothing has changed', () => {
    expect(roomAlerts(views(), [ROOM])).toEqual([])
  })

  it('says nothing about a room it had never seen', () => {
    // It has just been declared: its state is not a change.
    const alerts = roomAlerts(views(), [ROOM, { ...ROOM, roomId: 'track-2', conference: 'depassement' }])
    expect(alerts).toEqual([])
  })

  it('leads to the view that explains the alert', () => {
    // A card saying "Track #1 déborde" without leading there leaves one searching.
    const [first] = roomAlerts(views(), [{ ...ROOM, conference: 'retard' }])
    expect(first?.alert.view).toBe('exploitation')
  })
})
