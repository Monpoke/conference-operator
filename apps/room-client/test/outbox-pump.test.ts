import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Connectivity, Envelope, RoomEventPayload } from '@cloudnord/contract'
import { LocalStore } from '../src/core/store.js'
import { Outbox } from '../src/core/outbox.js'
import { OutboxPump, type PushResult } from '../src/core/outbox-pump.js'

const TRACK_1 = 'track-1-teilhard-de-chardin'

let store: LocalStore
let outbox: Outbox
let clockMs: number

beforeEach(() => {
  store = new LocalStore(':memory:')
  clockMs = Date.parse('2026-10-30T09:00:00.000Z')
  outbox = new Outbox(store, TRACK_1, () => clockMs)
})

const marker = (label: string): RoomEventPayload => ({
  type: 'talk.marker',
  sessionId: 'ses-1',
  label,
  offsetMs: 1000,
})

/** Hub simulé : accepte tout, mémorise, et sait tomber en panne. */
function fakeHub() {
  const recu = new Map<string, Envelope>()
  let enPanne = false

  const push = vi.fn(async (batch: Envelope[]): Promise<PushResult> => {
    if (enPanne) throw new Error('réseau injoignable')
    const acked: string[] = []
    const duplicates: string[] = []
    for (const envelope of batch) {
      if (recu.has(envelope.id)) duplicates.push(envelope.id)
      else {
        recu.set(envelope.id, envelope)
        acked.push(envelope.id)
      }
    }
    return { acked, duplicates, rejected: [], serverTime: '2026-10-30T09:00:05.000Z' }
  })

  return {
    push,
    recu,
    couper: () => {
      enPanne = true
    },
    retablir: () => {
      enPanne = false
    },
  }
}

function makePump(hub: ReturnType<typeof fakeHub>) {
  const connectivites: Connectivity[] = []
  const pump = new OutboxPump({
    outbox,
    store,
    push: hub.push,
    onConnectivity: (c) => connectivites.push(c),
    now: () => clockMs,
  })
  return { pump, connectivites }
}

describe('vidange de la file', () => {
  it('remonte les événements dans l\'ordre d\'émission', async () => {
    const hub = fakeHub()
    const { pump } = makePump(hub)

    outbox.enqueue(marker('un'))
    outbox.enqueue(marker('deux'))
    outbox.enqueue(marker('trois'))

    const outcome = await pump.drainOnce()
    expect(outcome.sent).toBe(3)
    expect(outbox.depth()).toBe(0)

    const labels = [...hub.recu.values()].map((e) => (e.payload as { label: string }).label)
    expect(labels).toEqual(['un', 'deux', 'trois'])
  })

  it('ne perd rien pendant une coupure et rattrape à la reprise', async () => {
    const hub = fakeHub()
    const { pump, connectivites } = makePump(hub)

    outbox.enqueue(marker('avant'))
    await pump.drainOnce()
    expect(hub.recu.size).toBe(1)

    // Le réseau tombe : la régie continue d'émettre.
    hub.couper()
    outbox.enqueue(marker('pendant-1'))
    outbox.enqueue(marker('pendant-2'))
    const enPanne = await pump.drainOnce()

    expect(enPanne.connectivity).toBe('OFFLINE')
    expect(enPanne.deferred).toBe(2)
    // Rien n'est perdu : les événements restent en file.
    expect(outbox.depth()).toBe(2)

    // Reprise, après le backoff.
    hub.retablir()
    clockMs += 5_000
    const apres = await pump.drainOnce()

    expect(apres.sent).toBe(2)
    expect(outbox.depth()).toBe(0)
    expect(connectivites).toEqual(['ONLINE', 'OFFLINE', 'ONLINE'])
  })

  it('traite un doublon comme un acquittement', async () => {
    const hub = fakeHub()
    const { pump } = makePump(hub)
    const envelope = outbox.enqueue(marker('démo'))

    // Le hub l'a déjà reçu (l'acquittement s'était perdu au retour).
    await hub.push([envelope])
    const outcome = await pump.drainOnce()

    expect(outcome.duplicates).toBe(1)
    // Dans les deux cas le hub le détient : l'événement doit sortir de la file.
    expect(outbox.depth()).toBe(0)
  })

  it('sort un événement rejeté sans bloquer les suivants', async () => {
    const casse = outbox.enqueue(marker('malformé'))
    const sain = outbox.enqueue(marker('sain'))

    const push = vi.fn(async (batch: Envelope[]): Promise<PushResult> => ({
      acked: batch.filter((e) => e.id !== casse.id).map((e) => e.id),
      duplicates: [],
      rejected: batch.filter((e) => e.id === casse.id).map((e) => ({ id: e.id, reason: 'invalid-schema' })),
    }))

    const pump = new OutboxPump({ outbox, store, push, now: () => clockMs })
    const outcome = await pump.drainOnce()

    expect(outcome).toMatchObject({ sent: 1, rejected: 1, deferred: 0 })
    expect(outbox.depth()).toBe(0)
    expect(store.recentLogs().some((l) => l.message.includes('rejeté'))).toBe(true)
    expect(sain.id).toBeTruthy()
  })

  it('reporte ce que le hub n\'a ni acquitté ni rejeté', async () => {
    outbox.enqueue(marker('un'))
    outbox.enqueue(marker('deux'))

    // Hub qui ne traite que la moitié du lot : le reste doit être repris,
    // pas considéré comme livré.
    const push = vi.fn(async (batch: Envelope[]): Promise<PushResult> => ({
      acked: [batch[0]!.id],
      duplicates: [],
      rejected: [],
    }))

    const pump = new OutboxPump({ outbox, store, push, now: () => clockMs })
    const outcome = await pump.drainOnce()

    expect(outcome).toMatchObject({ sent: 1, deferred: 1 })
    expect(outbox.depth()).toBe(1)
  })

  it('mesure le décalage d\'horloge à chaque remontée réussie', async () => {
    const hub = fakeHub()
    const heures: string[] = []
    const pump = new OutboxPump({
      outbox,
      store,
      push: hub.push,
      onServerTime: (t) => heures.push(t),
      now: () => clockMs,
    })

    outbox.enqueue(marker('démo'))
    await pump.drainOnce()
    expect(heures).toEqual(['2026-10-30T09:00:05.000Z'])
  })

  it('ne fait rien quand la file est vide', async () => {
    const hub = fakeHub()
    const { pump } = makePump(hub)
    expect(await pump.drainOnce()).toMatchObject({ sent: 0, deferred: 0 })
    expect(hub.push).not.toHaveBeenCalled()
  })
})

/**
 * Le réveil : remonter tout de suite ce qui vient de changer.
 *
 * Pour ce qui se pilote de loin. Une régie mobile lit l'état de la salle par le
 * hub, qui le tient du battement : sans réveil, une bascule de scène met
 * jusqu'à un tic de pompe à se voir sur le téléphone. Or la régie ne peint
 * jamais d'avance — c'est le flux qui repeint le bouton —, si bien que ce délai
 * se lit comme un geste manqué, et qu'on appuie une seconde fois.
 */
describe('réveil de la pompe', () => {
  it('vide la file sans attendre le tic', async () => {
    const hub = fakeHub()
    const { pump } = makePump(hub)
    outbox.enqueue(marker('un'))

    pump.start()
    pump.reveiller()
    await vi.waitFor(() => expect(hub.recu.size).toBe(1))
    pump.stop()
  })

  it('ne réécrit pas en base quand le lot revient après la fermeture', async () => {
    /*
     * La course qui tuait le processus, une fois sur trois.
     *
     * Un lot part, l'application se ferme pendant que le hub réfléchit, et la
     * réponse — ou l'échec — revient sur une base close. `defer` écrivait alors
     * depuis l'intérieur du `catch` qui existe pour rattraper les échecs : le
     * rejet n'avait plus personne pour l'attraper et remontait au processus.
     *
     * Rien n'est perdu au passage : `claimBatch` ne marque pas ce qu'il lit, un
     * lot non reporté reste éligible et repart à la prochaine ouverture.
     */
    const hub = fakeHub()
    let repondre: (() => void) | null = null
    const lent = new Promise<void>((resolve) => {
      repondre = resolve
    })
    const pump = new OutboxPump({
      outbox,
      store,
      push: async (batch) => {
        await lent
        return hub.push(batch)
      },
    })
    outbox.enqueue(marker('un'))

    pump.start()
    const vidange = pump.drainOnce()
    pump.stop()
    store.close()
    repondre!()

    // Ne lève pas, et le dit : le lot est reporté à la prochaine ouverture.
    await expect(vidange).resolves.toMatchObject({ sent: 0, deferred: 1 })
  })

  it('ne fait rien quand la pompe est arrêtée', async () => {
    /*
     * Le garde n'est pas cosmétique.
     *
     * OBS continue d'émettre pendant l'arrêt de l'application, et une vidange
     * lancée après la fermeture de la base échoue dans son propre `catch` — qui
     * écrit lui-même en base pour reporter le lot. Le rejet remontait alors
     * jusqu'au processus, sans que personne ne puisse l'attraper.
     */
    const hub = fakeHub()
    const { pump } = makePump(hub)
    outbox.enqueue(marker('un'))

    // Jamais démarrée : il n'y a aucun tic à devancer.
    pump.reveiller()
    await Promise.resolve()
    expect(hub.push).not.toHaveBeenCalled()

    // Et après un arrêt, non plus : c'est le cas de la fermeture.
    pump.start()
    pump.stop()
    pump.reveiller()
    await Promise.resolve()
    expect(hub.push).not.toHaveBeenCalled()
  })
})
