import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EVENT_IDENTITY,
  derivedShortName,
  resolveEventIdentity,
} from '../src/event-identity.js'

/**
 * The event's identity.
 *
 * This is the piece that makes the repository agnostic: nothing hard-codes an
 * event name any more, and changing edition — or event — comes down to importing
 * another program. So these tests are about the order of the sources, which is
 * all that separates "configurable" from "reconfigurable by accident".
 */
describe('event identity', () => {
  it('is derived from the imported program, with nothing configured', () => {
    // The normal case, and the only gesture required to serve another event.
    expect(resolveEventIdentity({ program: 'DevFest Lille 2027' })).toEqual({
      name: 'DevFest Lille 2027',
      shortName: 'DevFest Lille',
    })
  })

  it('lets the hub setting contradict the upstream export', () => {
    // For exports carrying an internal name, or no name at all.
    expect(
      resolveEventIdentity({
        setting: { name: 'Cloud Nord 2026', shortName: null },
        program: 'CN26-prod',
      }),
    ).toEqual({ name: 'Cloud Nord 2026', shortName: 'Cloud Nord' })
  })

  it('derives the short name from the chosen name, not from another source', () => {
    // Setting the full name without thinking about the short one must stay
    // coherent: otherwise the console would show the new name and the
    // notifications the old one.
    const identity = resolveEventIdentity({
      setting: { name: 'Sunny Tech 2027' },
      program: 'Cloud Nord 2026',
    })
    expect(identity.shortName).toBe('Sunny Tech')
  })

  it('keeps a short name set by hand', () => {
    expect(
      resolveEventIdentity({ setting: { name: 'Les Journées du Cloud', shortName: 'JDC' } }),
    ).toEqual({ name: 'Les Journées du Cloud', shortName: 'JDC' })
  })

  it('treats an empty string as no setting at all', () => {
    // The console sends `null` when a field is cleared, but an upstream import
    // may well carry `"name": ""` — both must release the source.
    expect(resolveEventIdentity({ setting: { name: '  ' }, program: 'Cloud Nord 2026' }).name)
      .toBe('Cloud Nord 2026')
    expect(resolveEventIdentity({ program: '' })).toEqual(DEFAULT_EVENT_IDENTITY)
  })

  it('falls back on a neutral word when nothing is known', () => {
    // A hub that has just been installed, before the first import: a neutral word
    // beats a hard-coded event name, which would be wrong everywhere else.
    expect(resolveEventIdentity()).toEqual(DEFAULT_EVENT_IDENTITY)
  })

  it('bounds what comes from the upstream export', () => {
    // The name travels through every room's `sync`: a fanciful export must not
    // fail their validation, so it is truncated, not refused.
    const identity = resolveEventIdentity({ program: 'x'.repeat(300) })
    expect(identity.name).toHaveLength(80)
    expect(identity.shortName).toHaveLength(40)
  })
})

describe('short name', () => {
  it('strips what dates the name', () => {
    expect(derivedShortName('Cloud Nord 2026')).toBe('Cloud Nord')
    expect(derivedShortName('DevFest Lille #12')).toBe('DevFest Lille')
    expect(derivedShortName('Sunny Tech — 2027')).toBe('Sunny Tech')
    expect(derivedShortName('Riviera DEV, édition 12')).toBe('Riviera DEV')
  })

  it('only cuts what it is sure of', () => {
    // Deliberately timid: a wrong short name would be read on every screen of the
    // day, a short name that is too long goes unnoticed.
    expect(derivedShortName('Web2Day')).toBe('Web2Day')
    expect(derivedShortName('Codeurs en Seine')).toBe('Codeurs en Seine')
    // A name that is only its year does not get shortened to nothing.
    expect(derivedShortName('2026')).toBe('2026')
  })
})
