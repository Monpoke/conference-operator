const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** ULID minimal, suffisant pour les fixtures de test. */
export function ulid(): string {
  let out = ''
  for (let i = 0; i < 26; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return out
}
