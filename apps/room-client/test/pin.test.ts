import { randomBytes, scryptSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runControlAction, type ControlTarget } from '../src/core/control-api.js'
import { UrgentPinGate, verifyPin } from '../src/core/pin.js'

/**
 * The hub's format, rebuilt here rather than imported: the room must read what
 * the hub writes (`apps/hub-server/src/pin.ts`), and a test importing the hub's
 * code would prove nothing about two programs agreeing.
 */
function hubHash(pin: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(pin, salt, 32, { N: 16_384 })
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`
}

describe('the control app PIN', () => {
  const stored = hubHash('4821')

  it('reads the hash the hub writes', () => {
    expect(verifyPin('4821', stored)).toBe(true)
    expect(verifyPin('4822', stored)).toBe(false)
    expect(verifyPin('4821', 'garbage')).toBe(false)
  })

  it('refuses everything when the hub set no PIN', () => {
    expect(new UrgentPinGate(() => null).check('4821')).toContain('Aucun code PIN')
  })

  it('locks for a minute after five misses, then opens again', () => {
    let now = 0
    const gate = new UrgentPinGate(() => stored, () => now)
    for (let miss = 0; miss < 4; miss += 1) expect(gate.check('0000')).toBe('Code PIN incorrect.')
    expect(gate.check('0000')).toContain('bloqué')
    // Even the right PIN waits out the lock.
    expect(gate.check('4821')).toContain("Trop d'essais")
    now = 61_000
    expect(gate.check('4821')).toBeNull()
  })
})

describe('an urgent screen message from the control app', () => {
  function target(pinOk: boolean): { shown: string[]; target: ControlTarget } {
    const shown: string[] = []
    return {
      shown,
      target: {
        showScreenMessage: (text: string) => shown.push(text),
        checkUrgentPin: () => (pinOk ? null : 'Code PIN incorrect.'),
      } as unknown as ControlTarget,
    }
  }

  it('does not go up without the PIN', async () => {
    const refused = target(false)
    const outcome = await runControlAction(refused.target, {
      action: 'screen.message',
      text: 'Évacuez',
      level: 'urgent',
      ttlSeconds: null,
    })
    expect(outcome).toMatchObject({ ok: false, message: 'Code PIN incorrect.' })
    expect(refused.shown).toEqual([])
  })

  it('goes up with it, and an ordinary message never asks', async () => {
    const accepted = target(true)
    await runControlAction(accepted.target, {
      action: 'screen.message',
      text: 'Évacuez',
      level: 'urgent',
      ttlSeconds: null,
      pin: '4821',
    })
    const plain = target(false)
    await runControlAction(plain.target, { action: 'screen.message', text: 'Pause', level: 'info', ttlSeconds: null })
    expect(accepted.shown).toEqual(['Évacuez'])
    expect(plain.shown).toEqual(['Pause'])
  })
})
