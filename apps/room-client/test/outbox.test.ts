import { beforeEach, describe, expect, it } from 'vitest'
import type { RoomEventPayload } from '@cloudnord/contract'
import { LocalStore } from '../src/core/store.js'
import { Outbox, backoffMs, heartbeatDedupKey } from '../src/core/outbox.js'

const TRACK_1 = 'track-1-teilhard-de-chardin'

let store: LocalStore
let clockMs: number
let outbox: Outbox

beforeEach(() => {
  store = new LocalStore(':memory:')
  clockMs = Date.parse('2026-10-30T09:00:00.000Z')
  outbox = new Outbox(store, TRACK_1, () => clockMs)
})

const heartbeat = (outboxDepth = 0): RoomEventPayload => ({
  type: 'room.heartbeat',
  connectivity: 'ONLINE',
  sceneRole: 'HOLD',
  recording: false,
  streaming: false,
  displayMode: 'loop',
  outboxDepth,
  programContentHash: 'hash-1',
})

const marker = (label: string): RoomEventPayload => ({
  type: 'talk.marker',
  sessionId: 'ses-1',
  label,
  offsetMs: 90_000,
})

describe('politiques de livraison', () => {
  it('déduit la politique du type d\'événement', () => {
    // L'appelant ne choisit pas : c'est le type qui décide, une fois pour toutes.
    expect(outbox.enqueue(marker('démo')).delivery).toBe('required')
    expect(outbox.enqueue(heartbeat()).delivery).toBe('best-effort')
  })

  it('numérote les événements dans l\'ordre d\'émission', () => {
    const premier = outbox.enqueue(marker('un'))
    const second = outbox.enqueue(marker('deux'))

    expect(second.seq).toBe(premier.seq + 1)
    expect(outbox.claimBatch().map((e) => e.seq)).toEqual([premier.seq, second.seq])
  })

  it('horodate avec l\'horloge corrigée, pas celle du PC', () => {
    store.saveSettings({ clockOffsetMs: 40 * 60_000 })
    const envelope = outbox.enqueue(marker('démo'))
    // Les timecodes VOD dépendent de cette correction.
    expect(envelope.occurredAt).toBe('2026-10-30T09:40:00.000Z')
  })
})

describe('collapse des événements jetables', () => {
  it('ne garde que la dernière occurrence par clé', () => {
    for (let i = 1; i <= 720; i += 1) {
      outbox.enqueue(heartbeat(i), { dedupKey: 'heartbeat' })
    }
    // Une heure hors ligne ne doit pas accumuler 720 heartbeats.
    const pending = outbox.claimBatch()
    expect(pending).toHaveLength(1)
    expect((pending[0]!.payload as { outboxDepth: number }).outboxDepth).toBe(720)
  })

  it('n\'affecte pas les événements sans clé', () => {
    outbox.enqueue(marker('un'))
    outbox.enqueue(marker('deux'))
    expect(outbox.depth()).toBe(2)
  })
})

describe('remontée et rejeu', () => {
  it('sort les événements acquittés', () => {
    const a = outbox.enqueue(marker('un'))
    const b = outbox.enqueue(marker('deux'))

    outbox.ack([a.id])
    expect(outbox.claimBatch().map((e) => e.id)).toEqual([b.id])
  })

  it('reporte un lot en échec avec un backoff croissant', () => {
    const envelope = outbox.enqueue(marker('démo'))

    outbox.defer([envelope.id])
    // Reporté : plus rien à envoyer tout de suite.
    expect(outbox.claimBatch()).toHaveLength(0)

    clockMs += 5_000
    expect(outbox.claimBatch().map((e) => e.id)).toEqual([envelope.id])
  })

  it('sort un événement définitivement rejeté sans bloquer la file', () => {
    const casse = outbox.enqueue(marker('malformé'))
    const sain = outbox.enqueue(marker('sain'))

    outbox.reject([{ id: casse.id, reason: 'invalid-schema' }])

    // Le laisser en tête bloquerait tout ce qui le suit.
    expect(outbox.claimBatch().map((e) => e.id)).toEqual([sain.id])
    expect(store.recentLogs()[0]?.message).toContain('rejeté par le hub')
  })
})

describe('expiration', () => {
  it('jette la télémétrie périmée sans bruit', () => {
    outbox.enqueue(heartbeat(), { dedupKey: 'heartbeat' })

    clockMs += 31_000
    expect(outbox.evictExpired().dropped).toBe(1)
    expect(outbox.depth()).toBe(0)
    // Rien au journal : une télémétrie périmée n'intéresse personne.
    expect(store.recentLogs().filter((l) => l.level === 'error')).toHaveLength(0)
  })

  it('garde un événement obligatoire pendant 48 h', () => {
    outbox.enqueue(marker('démo'))

    clockMs += 47 * 60 * 60 * 1000
    expect(outbox.evictExpired().dropped).toBe(0)
    expect(outbox.depth()).toBe(1)
  })

  it('trace bruyamment un événement obligatoire perdu', () => {
    outbox.enqueue(marker('démo'))

    clockMs += 49 * 60 * 60 * 1000
    expect(outbox.evictExpired().dropped).toBe(1)

    // Perdre un marqueur de talk en silence rendrait le editing inexplicable.
    const erreur = store.recentLogs().find((l) => l.level === 'error')
    expect(erreur?.message).toContain('obligatoire expiré')
    expect(erreur?.contextJson).toContain('talk.marker')
  })
})

describe('saturation de la file', () => {
  /** Plafond abaissé : le comportement est le même, le test reste rapide. */
  const petitOutbox = () => new Outbox(store, TRACK_1, () => clockMs, 200)

  it('évince la télémétrie avant tout le reste', () => {
    const petit = petitOutbox()
    // Clés distinctes : pas de collapse, la file se remplit vraiment.
    for (let i = 0; i < 400; i += 1) petit.enqueue(heartbeat(i), { dedupKey: `hb-${i}` })

    expect(petit.stats().total).toBeLessThanOrEqual(200 + 128)
    expect(petit.stats().required).toBe(0)
  })

  it('ne sacrifie jamais un événement obligatoire pour tenir le quota', () => {
    const petit = petitOutbox()
    for (let i = 0; i < 400; i += 1) petit.enqueue(marker(`marqueur-${i}`))

    // Jeter un enregistrement pour tenir un quota serait le pire compromis
    // possible : la file grossit et l'alerte remonte en régie à la place.
    expect(petit.stats().required).toBe(400)
    expect(store.recentLogs()[0]?.message).toContain('saturée')
  })
})

describe('backoff', () => {
  it('croît en exponentiel puis plafonne', () => {
    const sansGigue = () => 0.5
    expect(backoffMs(1, sansGigue)).toBe(1_000)
    expect(backoffMs(2, sansGigue)).toBe(2_000)
    expect(backoffMs(5, sansGigue)).toBe(16_000)
    expect(backoffMs(20, sansGigue)).toBe(60_000)
  })

  it('applique une gigue pour ne pas synchroniser les trois salles', () => {
    // Sans gigue, trois salles coupées ensemble reviendraient frapper le hub
    // exactement au même instant à chaque tentative.
    expect(backoffMs(4, () => 0)).toBeLessThan(8_000)
    expect(backoffMs(4, () => 1)).toBeGreaterThan(8_000)
  })
})

describe('retard de remontée affiché', () => {
  it('ignore le battement, qui se renouvelle indéfiniment', () => {
    // Le battement se réinscrit toutes les 10 s et repart au drain suivant.
    // Le compter faisait osciller l'indicateur entre 0 et 1 en permanence, et
    // chaque bascule republiait l'état complet à toutes les pages abonnées.
    outbox.enqueue(heartbeat(), { dedupKey: heartbeatDedupKey(TRACK_1) })
    expect(outbox.depth()).toBe(1)
    expect(outbox.backlog()).toBe(0)
  })

  it('compte tout ce qui traduit un vrai retard', () => {
    outbox.enqueue(heartbeat(), { dedupKey: heartbeatDedupKey(TRACK_1) })
    outbox.enqueue(marker('chapitre 1'))
    outbox.enqueue(marker('chapitre 2'))
    // Un marqueur non remonté est du travail perdu s'il n'part pas : il compte.
    expect(outbox.backlog()).toBe(2)
    expect(outbox.depth()).toBe(3)
  })

  it("ne masque pas le battement d'une autre salle", () => {
    // La clé est nominative : masquer par préfixe aurait effacé le retard
    // d'une salle voisine partageant la même base en secours.
    outbox.enqueue(heartbeat(), { dedupKey: heartbeatDedupKey('une-autre-salle') })
    expect(outbox.backlog()).toBe(1)
  })
})
