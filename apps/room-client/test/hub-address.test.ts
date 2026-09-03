import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HUB_ADDRESS,
  imposedAddress,
  normalizeHubAddress,
  resolveHubAddress,
} from '../src/main/hub-address.js'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-hub-'))
  path = join(dir, 'hub')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A simulated entry screen: returns what it is told, and notes what it is offered. */
function screen(answer: string | null) {
  const offered: string[] = []
  const ask = vi.fn(async (initialValue: string) => {
    offered.push(initialValue)
    return answer
  })
  return { ask, offered }
}

describe('normalizing the typed address', () => {
  it('fills in the missing scheme: one types an IP and a port, not a URL', () => {
    expect(normalizeHubAddress('192.168.1.10:8787')).toBe('http://192.168.1.10:8787')
    expect(normalizeHubAddress('  hub.cloudnord.fr  ')).toBe('http://hub.cloudnord.fr')
  })

  it('keeps https when it is written', () => {
    expect(normalizeHubAddress('https://hub.cloudnord.fr')).toBe('https://hub.cloudnord.fr')
  })

  it('strips path and trailing slash: the whole client resolves absolute paths', () => {
    expect(normalizeHubAddress('http://hub:8787/admin')).toBe('http://hub:8787')
    expect(normalizeHubAddress('http://hub:8787/')).toBe('http://hub:8787')
  })

  it('refuses, saying why, what cannot reach a hub', () => {
    expect(() => normalizeHubAddress('  ')).toThrow(/vide/i)
    expect(() => normalizeHubAddress('ftp://hub')).toThrow(/http/i)
    expect(() => normalizeHubAddress('http://')).toThrow()
  })
})

describe('address dictated from outside', () => {
  it("reads --hub by prefix: a package's argv and an `electron` one differ", () => {
    expect(imposedAddress(['Régie de salle.exe', '--hub=http://hub:8787'], {})).toEqual({
      value: 'http://hub:8787',
      source: 'argument',
    })
    expect(imposedAddress(['electron', 'dist/main.cjs', '--hub', 'http://hub:8787'], {})).toEqual({
      value: 'http://hub:8787',
      source: 'argument',
    })
  })

  it('hands over to HUB_ORIGIN, and the argument beats it', () => {
    expect(imposedAddress(['electron'], { HUB_ORIGIN: 'http://env:8787' })).toEqual({
      value: 'http://env:8787',
      source: 'environment',
    })
    expect(imposedAddress(['--hub=http://arg:8787'], { HUB_ORIGIN: 'http://env:8787' })?.value).toBe(
      'http://arg:8787',
    )
  })

  it('ignores an empty variable rather than taking it for an address', () => {
    expect(imposedAddress(['electron'], { HUB_ORIGIN: '   ' })).toBeNull()
  })
})

describe('resolution at start-up', () => {
  it('asks on every launch, offering the last address kept', async () => {
    const first = screen('192.168.1.10:8787')
    const address = await resolveHubAddress({ path, argv: [], env: {}, ask: first.ask })

    expect(address).toBe('http://192.168.1.10:8787')
    // Offered: the development default, for want of anything better.
    expect(first.offered).toEqual([DEFAULT_HUB_ADDRESS])
    expect(readFileSync(path, 'utf8')).toBe('http://192.168.1.10:8787')

    // On the next launch the question is asked again — but the answer is already
    // in the field: validating goes back to the same hub.
    const second = screen('http://192.168.1.10:8787')
    expect(
      await resolveHubAddress({ path, argv: [], env: {}, ask: second.ask }),
    ).toBe('http://192.168.1.10:8787')
    expect(second.offered).toEqual(['http://192.168.1.10:8787'])
  })

  it('opens no window when the address is dictated: a shortcut has nobody to answer', async () => {
    const entry = screen(null)
    await resolveHubAddress({
      path,
      argv: [],
      env: { HUB_ORIGIN: 'http://env:8787' },
      ask: entry.ask,
    })
    expect(entry.ask).not.toHaveBeenCalled()
  })

  it('returns null when the operator closes without validating: there is nothing to start', async () => {
    expect(
      await resolveHubAddress({ path, argv: [], env: {}, ask: screen(null).ask }),
    ).toBeNull()
  })

  it('provisions the machine from the argument, and that is also how one changes it', async () => {
    writeFileSync(path, 'http://ancien:8787', 'utf8')
    const entry = screen(null)

    const address = await resolveHubAddress({
      path,
      argv: ['--hub=http://nouveau:8787'],
      env: {},
      ask: entry.ask,
    })

    expect(address).toBe('http://nouveau:8787')
    expect(readFileSync(path, 'utf8')).toBe('http://nouveau:8787')
    expect(entry.ask).not.toHaveBeenCalled()
  })

  it('leaves the operator in charge: the remembered one is only a proposal', async () => {
    writeFileSync(path, 'http://ancien:8787', 'utf8')
    const entry = screen('http://nouveau:8787')

    const address = await resolveHubAddress({ path, argv: [], env: {}, ask: entry.ask })

    expect(entry.offered).toEqual(['http://ancien:8787'])
    expect(address).toBe('http://nouveau:8787')
    expect(readFileSync(path, 'utf8')).toBe('http://nouveau:8787')
  })

  it('says out loud that an argument is refused, rather than starting on yesterday\'s', async () => {
    writeFileSync(path, 'http://ancien:8787', 'utf8')
    const onLog = vi.fn()
    const entry = screen('http://choisi:8787')

    const address = await resolveHubAddress({
      path,
      argv: ['--hub=ftp://hub'],
      env: {},
      ask: entry.ask,
      onLog,
    })

    expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('argument'))
    // The offending value is put back in front of the eyes: it is the one to fix.
    expect(entry.offered).toEqual(['ftp://hub'])
    expect(address).toBe('http://choisi:8787')
  })

  it('asks again when the remembered file is unreadable', async () => {
    writeFileSync(path, 'ftp://n-importe-quoi', 'utf8')
    const onLog = vi.fn()
    const entry = screen('http://hub:8787')

    const address = await resolveHubAddress({
      path,
      argv: [],
      env: {},
      ask: entry.ask,
      onLog,
    })

    expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('mémorisée'))
    expect(entry.offered).toEqual([DEFAULT_HUB_ADDRESS])
    expect(address).toBe('http://hub:8787')
  })
})
