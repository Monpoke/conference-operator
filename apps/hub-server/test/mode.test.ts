import { describe, expect, it } from 'vitest'
import { configSchema } from '../src/config.js'

/**
 * Garde-fou du mode production sur le hub.
 *
 * Les réglages de développement sont neutralisés plutôt que refusés : un hub
 * qui ne redémarre pas parce qu'une ligne traîne dans un `.env` serait pire que
 * le mal qu'on soigne — c'est justement en cours d'événement qu'on le relance.
 */
const BASE = { authSecret: 'x'.repeat(48) }

describe('mode du hub', () => {
  it('est en production quand rien n\'est demandé', () => {
    const config = configSchema.parse(BASE)

    expect(config.mode).toBe('production')
    expect(config.ignores).toEqual([])
  })

  it('neutralise l\'heure simulée en production', () => {
    // Une erreur qu'on ne rattrape pas après coup : des timecodes faussés et
    // des clôtures automatiques à contretemps.
    const config = configSchema.parse({ ...BASE, simulatedTime: '2026-10-30T10:20:00.000Z' })

    expect(config.simulatedTime).toBeUndefined()
    // Et le dit, avec la raison : sinon le garde-fou ne vaudrait rien.
    expect(config.ignores).toEqual([
      { variable: 'SIMULATED_TIME', raison: 'réservé au mode développement (MODE=dev)' },
    ])
  })

  it('l\'applique en mode développement', () => {
    const config = configSchema.parse({
      ...BASE,
      mode: 'dev',
      simulatedTime: '2026-10-30T10:20:00.000Z',
    })

    expect(config.simulatedTime).toBe('2026-10-30T10:20:00.000Z')
    expect(config.ignores).toEqual([])
  })

  it('signale CLOCK_CONTROL comme obsolète, dans les deux modes', () => {
    // Un second interrupteur pour le réglage de l'heure laissait exister une
    // combinaison absurde : un hub de production dont on pouvait quand même
    // déplacer l'horloge. Le trouver dans un `.env` veut dire que quelqu'un
    // croit avoir ouvert quelque chose.
    for (const mode of ['production', 'dev'] as const) {
      const config = configSchema.parse({ ...BASE, mode, clockControl: '1' })

      expect(config.ignores).toContainEqual({
        variable: 'CLOCK_CONTROL',
        raison: "remplacé par MODE=dev, qui ouvre le réglage de l'heure",
      })
    }
  })

  it('ne s\'alarme pas d\'un CLOCK_CONTROL laissé à zéro', () => {
    expect(configSchema.parse({ ...BASE, clockControl: '0' }).ignores).toEqual([])
  })
})
