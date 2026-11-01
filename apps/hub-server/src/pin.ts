import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * The control app's PIN, hashed for the rooms.
 *
 * An urgent message from a room machine asks for it — the local control app has
 * no account, and the alarm must still sound with the hub cut off. So the hash
 * travels to the rooms at sync and each one checks the PIN itself.
 *
 * `scrypt$<N>$<salt>$<hash>`, base64: the format `apps/room-client/src/core/pin.ts`
 * reads back. Salted, and costly enough that the hash read off a machine's disk
 * does not give a four-digit PIN away in a blink — but a PIN is short, and it is
 * a deterrent, not a vault: the rule stays changing it when a machine is lost.
 */
const COST = 16_384
const KEY_LENGTH = 32

export function hashPin(pin: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(pin, salt, KEY_LENGTH, { N: COST })
  return `scrypt$${COST}$${salt.toString('base64')}$${hash.toString('base64')}`
}

/** Whether this secret is the one `hashPin` hashed. */
export function verifyPin(pin: string, stored: string): boolean {
  const [, cost, salt, hash] = stored.split('$')
  if (cost == null || salt == null || hash == null) return false
  const expected = Buffer.from(hash, 'base64')
  return timingSafeEqual(scryptSync(pin, Buffer.from(salt, 'base64'), expected.length, { N: Number(cost) }), expected)
}

/** 4 to 12 digits: typed on a control machine's keyboard, in a hurry. */
export const PIN_PATTERN = /^\d{4,12}$/
