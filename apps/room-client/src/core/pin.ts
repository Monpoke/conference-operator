import { scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * The control app's PIN, checked on the machine.
 *
 * An urgent message from the room's own control app asks for it: the local page
 * has no account, and the alarm must sound with the hub cut off — so the hub sends
 * the hash down at sync and the room checks here. Format and cost are the hub's,
 * see `apps/hub-server/src/pin.ts`: `scrypt$<N>$<salt>$<hash>`, base64.
 */
export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, cost, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || cost == null || salt == null || hash == null) return false
  const expected = Buffer.from(hash, 'base64')
  const N = Number(cost)
  if (!Number.isInteger(N) || N < 2 || expected.length === 0) return false
  try {
    const actual = scryptSync(pin, Buffer.from(salt, 'base64'), expected.length, { N })
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** Wrong PINs before the control app stops asking for a while. */
const MAX_FAILURES = 5
const LOCK_MS = 60_000

/**
 * The gate an urgent message goes through.
 *
 * A PIN is short: guessing it at the keyboard of an unattended control machine
 * must cost minutes, not seconds. Five misses lock it for a minute; a good PIN
 * resets the count.
 */
export class UrgentPinGate {
  private failures = 0
  private lockedUntil = 0

  constructor(
    private readonly hash: () => string | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** `null` when the PIN opens; otherwise what to tell the operator. */
  check(pin: string | undefined): string | null {
    const stored = this.hash()
    if (stored == null) {
      return "Aucun code PIN régie n'est défini au hub : un message urgent ne peut pas partir d'ici."
    }
    const now = this.now()
    if (now < this.lockedUntil) {
      return `Trop d'essais : réessayez dans ${Math.ceil((this.lockedUntil - now) / 1000)} s.`
    }
    if (pin == null || pin === '') return 'Code PIN requis pour un message urgent.'
    if (verifyPin(pin, stored)) {
      this.failures = 0
      return null
    }
    this.failures += 1
    if (this.failures >= MAX_FAILURES) {
      this.failures = 0
      this.lockedUntil = now + LOCK_MS
      return "Code PIN incorrect. Trop d'essais : bloqué une minute."
    }
    return 'Code PIN incorrect.'
  }
}
