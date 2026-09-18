import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/**
 * Encryption at rest for the few secrets the hub holds on behalf of a room.
 *
 * Today that is the RTMP stream key, and the shape of the problem is what
 * dictates the shape here: the hub must be able to **give it back in clear**, to
 * one room and to that room only, so hashing is out — this has to be reversible.
 * What encryption buys, then, is not much and is worth saying plainly: a copy of
 * `hub.db` — a backup passed around, a volume snapshot, the file pulled off a
 * disposed disk — does not hand over the keys to the stream of every room. It
 * buys nothing at all against someone who already holds the hub's secret.
 */
export interface SecretBox {
  seal(value: string): string
  /** `null` when the ciphertext cannot be read back — see `createSecretBox`. */
  open(sealed: string): string | null
}

/** Marks the format, so a later one can be told apart rather than guessed at. */
const VERSION = 'v1'

/**
 * Derived rather than used raw: `BETTER_AUTH_SECRET` already signs the session
 * cookies, and one key doing two jobs is how a rotation for one reason breaks
 * the other. HKDF gives this use its own key from the same material.
 */
const SALT = 'conference-operator/secret-box'

/**
 * AES-256-GCM keyed off the hub's secret.
 *
 * `open` returns `null` instead of throwing, and that is deliberate. The day
 * `BETTER_AUTH_SECRET` is rotated — or restored from a different deployment —
 * every stored ciphertext becomes unreadable. A hub that refused to start then,
 * or that blew up at the first `sync`, would take the whole event down over a
 * stream key. It reads back empty instead: the room is told it has no key, the
 * console shows the field as blank, and an operator retypes it. Which is
 * exactly what has to happen, since the old one is genuinely lost.
 */
export function createSecretBox(secret: string): SecretBox {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), SALT, '', 32))

  return {
    seal(value) {
      // A fresh IV per call: GCM reusing one over two plaintexts under the same
      // key surrenders both, and two rooms sharing a stream server is common.
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return [
        VERSION,
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        sealed.toString('base64url'),
      ].join('.')
    },

    open(sealed) {
      const [version, iv, tag, payload] = sealed.split('.')
      if (version !== VERSION || iv == null || tag == null || payload == null) return null
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
        decipher.setAuthTag(Buffer.from(tag, 'base64url'))
        return Buffer.concat([
          decipher.update(Buffer.from(payload, 'base64url')),
          decipher.final(),
        ]).toString('utf8')
      } catch {
        // Wrong key, or a truncated row: both mean "no key", never a crash.
        return null
      }
    },
  }
}
