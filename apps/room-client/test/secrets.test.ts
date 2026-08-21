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
 * `safeStorage` simulé. Le brouillage doit réellement masquer le clair, sinon le
 * test « le jeton n'est pas lisible sur le disque » ne prouverait rien.
 */
const MASQUE = 0x5a
const brouiller = (bytes: Buffer) => Buffer.from(bytes.map((octet) => octet ^ MASQUE))

const fakeSafeStorage = (available: boolean) => ({
  isEncryptionAvailable: () => available,
  encryptString: (value: string) => brouiller(Buffer.from(value, 'utf8')),
  decryptString: (value: Buffer) => brouiller(value).toString('utf8'),
})

describe('coffre du jeton de machine', () => {
  it('chiffre au repos quand le poste le permet', () => {
    const path = join(dir, 'jeton')
    const vault = createSecretVault(path, fakeSafeStorage(true))

    vault.write('jeton-secret')
    // Le jeton ne doit pas être lisible tel quel sur le disque.
    expect(readFileSync(path, 'utf8')).not.toContain('jeton-secret')
    expect(vault.read()).toBe('jeton-secret')
  })

  it('prévient explicitement quand le chiffrement est indisponible', () => {
    const onWarn = vi.fn()
    const vault = createSecretVault(join(dir, 'jeton'), fakeSafeStorage(false), onWarn)

    // Un secret silencieusement en clair serait pire qu'un secret annoncé comme tel.
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('en clair'))
    vault.write('jeton-secret')
    expect(vault.read()).toBe('jeton-secret')
  })

  it('redemande un appairage plutôt que de planter si le trousseau a changé', () => {
    const path = join(dir, 'jeton')
    createSecretVault(path, fakeSafeStorage(true)).write('jeton-secret')

    const casse = createSecretVault(path, {
      ...fakeSafeStorage(true),
      decryptString: () => {
        throw new Error('clé introuvable')
      },
    })
    expect(casse.read()).toBeNull()
  })

  it('renvoie null avant tout appairage', () => {
    expect(createSecretVault(join(dir, 'absent'), fakeSafeStorage(true)).read()).toBeNull()
  })
})

describe('identité de la machine', () => {
  it('génère un ULID stable et le conserve', () => {
    const path = join(dir, 'client-id')
    const first = loadOrCreateClientId(path)

    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(existsSync(path)).toBe(true)
    // Un nouvel identifiant à chaque incident obligerait à rappeler un
    // opérateur pour réappairer, en pleine journée d'événement.
    expect(loadOrCreateClientId(path)).toBe(first)
  })

  it('remplace un fichier corrompu', () => {
    const path = join(dir, 'client-id')
    const first = loadOrCreateClientId(path)
    rmSync(path)

    const second = loadOrCreateClientId(path)
    expect(second).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(second).not.toBe(first)
  })
})
