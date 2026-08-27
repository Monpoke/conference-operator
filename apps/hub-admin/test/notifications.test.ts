import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LEVELS,
  passes,
  readLevels,
  roomAlerts,
  type Levels,
  type RoomSeen,
} from '../src/stores/notifications.js'

/**
 * Ce dont la console prévient, et à qui.
 *
 * La décision de *quoi* annoncer est une fonction pure, exportée exprès : c'est
 * la seule partie du système qui vaut d'être éprouvée sans navigateur, sans
 * permission et sans service worker. Le reste — demander l'autorisation,
 * s'abonner au push — n'a pas de comportement propre à protéger : il enchaîne
 * des API que le navigateur possède.
 */

const SALLE = {
  roomId: 'track-1',
  name: 'Track #1',
  conference: 'en-cours',
  connectivity: 'ONLINE',
  currentSession: { title: 'Vue et les régies' },
}

function vues(etat: Partial<RoomSeen> = {}): Map<string, RoomSeen> {
  return new Map([['track-1', { conference: 'en-cours', connectivity: 'ONLINE', ...etat }]])
}

describe('réglage lu du stockage', () => {
  it('traite l’ancien réglage « 1 » comme les défauts', () => {
    // Il valait « allumé » : l'interpréter comme un objet vide éteindrait en
    // silence des notifications que quelqu'un avait acceptées.
    const storage = { getItem: () => '"1"' } as unknown as Storage
    expect(readLevels(storage)).toEqual(DEFAULT_LEVELS)
  })

  it('retombe sur les défauts plutôt que d’échouer sur un stockage illisible', () => {
    const storage = { getItem: () => '{ pas du json' } as unknown as Storage
    expect(readLevels(storage)).toEqual(DEFAULT_LEVELS)
  })

  it('complète un réglage partiel', () => {
    const storage = { getItem: () => '{"technique":"rien"}' } as unknown as Storage
    expect(readLevels(storage)).toEqual({ technique: 'rien', exploitation: 'essentiel' })
  })
})

describe('portée', () => {
  const tout: Levels = { technique: 'tout', exploitation: 'tout' }
  const essentiel: Levels = { technique: 'essentiel', exploitation: 'essentiel' }
  const rien: Levels = { technique: 'rien', exploitation: 'rien' }

  it('laisse passer l’essentiel à qui demande l’essentiel', () => {
    expect(passes(essentiel, 'technique', 'essentiel')).toBe(true)
  })

  it('retient le récit ordinaire pour qui ne veut que l’essentiel', () => {
    expect(passes(essentiel, 'exploitation', 'tout')).toBe(false)
    expect(passes(tout, 'exploitation', 'tout')).toBe(true)
  })

  it('ne laisse rien passer à qui ne veut rien', () => {
    expect(passes(rien, 'technique', 'essentiel')).toBe(false)
  })

  it('règle les deux familles séparément', () => {
    // Quelqu'un peut vouloir tout savoir des machines et rien du déroulé.
    const mixte: Levels = { technique: 'tout', exploitation: 'rien' }
    expect(passes(mixte, 'technique', 'tout')).toBe(true)
    expect(passes(mixte, 'exploitation', 'essentiel')).toBe(false)
  })
})

describe('ce qui change dans une salle', () => {
  it('ne dit rien au premier chargement', () => {
    // Annoncer l'état initial de six salles à l'ouverture de la console
    // noierait ce qui change vraiment.
    expect(roomAlerts(new Map(), [SALLE])).toEqual([])
  })

  it('annonce une salle qui ne répond plus, en essentiel', () => {
    const [premier] = roomAlerts(vues(), [{ ...SALLE, connectivity: 'OFFLINE' }])
    expect(premier?.family).toBe('technique')
    expect(premier?.alert.scope).toBe('essentiel')
    expect(premier?.alert.title).toContain('ne répond plus')
  })

  it('réserve le retour d’une salle à qui veut tout suivre', () => {
    // Un soulagement, pas une décision.
    const [premier] = roomAlerts(vues({ connectivity: 'OFFLINE' }), [SALLE])
    expect(premier?.alert.scope).toBe('tout')
  })

  it('met le dépassement en essentiel : c’est lui qui décale la journée', () => {
    const [premier] = roomAlerts(vues(), [{ ...SALLE, conference: 'depassement' }])
    expect(premier?.family).toBe('exploitation')
    expect(premier?.alert.scope).toBe('essentiel')
  })

  it('sépare la clé de la machine de celle de la conférence', () => {
    const alertes = roomAlerts(vues({ connectivity: 'OFFLINE', conference: 'pas-commencee' }), [
      { ...SALLE, conference: 'depassement' },
    ])
    // Deux étiquettes par salle : un « c'est parti » ne doit jamais venir
    // effacer un « ne répond plus » resté non lu.
    expect(alertes.map((entree) => entree.alert.key).sort()).toEqual([
      'conf-track-1',
      'salle-track-1',
    ])
  })

  it('se tait quand rien n’a changé', () => {
    expect(roomAlerts(vues(), [SALLE])).toEqual([])
  })

  it('ne dit rien d’une salle qu’il n’avait jamais vue', () => {
    // Elle vient d'être déclarée : son état n'est pas un changement.
    const alertes = roomAlerts(vues(), [SALLE, { ...SALLE, roomId: 'track-2', conference: 'depassement' }])
    expect(alertes).toEqual([])
  })

  it('conduit à la vue qui explique l’alerte', () => {
    // Un encart qui dit « Track #1 déborde » sans y conduire laisse chercher.
    const [premier] = roomAlerts(vues(), [{ ...SALLE, conference: 'retard' }])
    expect(premier?.alert.view).toBe('exploitation')
  })
})
