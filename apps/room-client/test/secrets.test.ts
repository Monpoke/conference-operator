import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSecretVault } from '../src/main/secrets.js'
import { loadOrCreateClientId } from '../src/main/identity.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-secrets-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/**
 * A simulated `safeStorage`. The scrambling has to really hide the cleartext,
 * otherwise the "the token is not readable on disk" test would prove nothing.
 */
const MASK = 0x5a
const scramble = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ MASK))

const fakeSafeStorage = (available: boolean) => ({
  isEncryptionAvailable: () => available,
  encryptString: (value: string) => scramble(Buffer.from(value, 'utf8')),
  decryptString: (value: Buffer) => scramble(value).toString('utf8'),
})

describe('machine token vault', () => {
  it('encrypts at rest when the machine allows it', () => {
    const path = join(dir, 'jeton')
    const vault = createSecretVault(path, fakeSafeStorage(true))

    vault.write('jeton-secret')
    // The token must not be readable as is on disk.
    expect(readFileSync(path, 'utf8')).not.toContain('jeton-secret')
    expect(vault.read()).toBe('jeton-secret')
  })

  it('warns explicitly when encryption is unavailable', () => {
    const onWarn = vi.fn()
    const vault = createSecretVault(join(dir, 'jeton'), fakeSafeStorage(false), onWarn)

    // A secret silently in clear would be worse than one announced as such.
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('en clair'))
    vault.write('jeton-secret')
    expect(vault.read()).toBe('jeton-secret')
  })

  it('asks for a pairing again rather than crashing if the keyring changed', () => {
    const path = join(dir, 'jeton')
    createSecretVault(path, fakeSafeStorage(true)).write('jeton-secret')

    const broken = createSecretVault(path, {
      ...fakeSafeStorage(true),
      decryptString: () => {
        throw new Error('clé introuvable')
      },
    })
    expect(broken.read()).toBeNull()
  })

  it('returns null before any pairing', () => {
    expect(createSecretVault(join(dir, 'absent'), fakeSafeStorage(true)).read()).toBeNull()
  })
})

describe('the machine identity', () => {
  it('generates a stable ULID and keeps it', () => {
    const path = join(dir, 'client-id')
    const first = loadOrCreateClientId(path)

    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(existsSync(path)).toBe(true)
    // A new identifier on every incident would force an operator to be called
    // back to pair again, in the middle of an event day.
    expect(loadOrCreateClientId(path)).toBe(first)
  })

  it('replaces a corrupt file', () => {
    const path = join(dir, 'client-id')
    const first = loadOrCreateClientId(path)
    rmSync(path)

    const second = loadOrCreateClientId(path)
    expect(second).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(second).not.toBe(first)
  })
})
