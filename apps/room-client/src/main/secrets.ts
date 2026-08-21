import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Chiffrement au repos fourni par Electron ; absent hors Electron. */
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
 * Coffre du jeton de la machine.
 *
 * Passe par `safeStorage` d'Electron quand le chiffrement est disponible. Sinon
 * — poste Linux sans trousseau, par exemple — on écrit en clair **et on le dit** :
 * un secret silencieusement non chiffré serait pire qu'un secret annoncé comme tel.
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
        // Trousseau changé ou profil déplacé : mieux vaut réappairer que planter.
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
