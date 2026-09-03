import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Encryption at rest supplied by Electron; absent outside Electron. */
export interface SecretVault {
  read(): string | null
  write(value: string): void
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/**
 * The vault for the machine's token.
 *
 * Goes through Electron's `safeStorage` when encryption is available. Otherwise —
 * a Linux machine with no keyring, for instance — we write in clear **and say
 * so**: a secret silently left unencrypted would be worse than one announced as
 * such.
 */
export function createSecretVault(
  path: string,
  safeStorage: SafeStorageLike | null,
  onWarn?: (message: string) => void,
): SecretVault {
  const encrypted = safeStorage?.isEncryptionAvailable() === true
  if (!encrypted) {
    onWarn?.(
      "Chiffrement indisponible sur ce poste : le jeton de la machine est stocké en clair. " +
        'Restreindre les droits du profil utilisateur.',
    )
  }

  return {
    read() {
      if (!existsSync(path)) return null
      const raw = readFileSync(path)
      if (!encrypted) return raw.toString('utf8')
      try {
        return safeStorage!.decryptString(raw)
      } catch {
        // Keyring changed or profile moved: better to pair again than to crash.
        return null
      }
    },
    write(value) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, encrypted ? safeStorage!.encryptString(value) : Buffer.from(value, 'utf8'), {
        mode: 0o600,
      })
    },
  }
}
