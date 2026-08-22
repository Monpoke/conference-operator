import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { PushService } from '../src/services/push.js'
import { VeilleSupervision } from '../src/supervision.js'
import type { RoomStatus } from '@cloudnord/contract'

/**
 * Notifications poussées aux consoles fermées.
 *
 * Ce qui les distingue des notifications de page : plus personne ne regarde. Le
 * hub doit donc constater lui-même ce qui change, et ne pousser que cela — un
 * avis répété fait couper les notifications pour de bon.
 */

const SALLE = (patch: Partial<RoomStatus> = {}): RoomStatus =>
  ({
    roomId: 'track-1',
    name: 'Track #1',
    connectivity: 'ONLINE',
    lastSeenAt: new Date().toISOString(),
    sceneRole: 'LIVE',
    currentSessionId: null,
    recording: false,
    streaming: false,
    outboxDepth: 0,
    programContentHash: 'h',
    currentSession: null,
    conference: 'en-cours',
    ...patch,
  }) as RoomStatus

describe('veille de supervision', () => {
  it('ne dit rien du premier tour', () => {
    const veille = new VeilleSupervision()

    // Démarrer le hub sur une salle déjà coupée n'est pas un événement : c'est
    // un état, et trois avis à l'allumage rendraient les suivants invisibles.
    expect(veille.passe([SALLE({ connectivity: 'OFFLINE', conference: 'depassement' })])).toEqual([])
  })

  it('signale une salle qui tombe, puis qui revient', () => {
    const veille = new VeilleSupervision()
    veille.passe([SALLE()])

    const chute = veille.passe([SALLE({ connectivity: 'OFFLINE' })])
    expect(chute.map((avis) => avis.title)).toEqual(['Track #1 ne répond plus'])

    const retour = veille.passe([SALLE()])
    expect(retour.map((avis) => avis.title)).toEqual(['Track #1 est revenue'])
  })

  it('signale un dépassement une seule fois', () => {
    const veille = new VeilleSupervision()
    veille.passe([SALLE()])

    expect(veille.passe([SALLE({ conference: 'depassement' })])).toHaveLength(1)
    // Répéter ferait couper les notifications au bout de deux minutes, et on ne
    // les rallume pas.
    expect(veille.passe([SALLE({ conference: 'depassement' })])).toEqual([])
  })

  it('annonce les machines qui arrivent dans la file, pas celles déjà là', () => {
    const veille = new VeilleSupervision()
    veille.passe([SALLE()], [{ clientId: 'machine-a' }])

    expect(veille.passe([SALLE()], [{ clientId: 'machine-a' }])).toEqual([])
    const arrivee = veille.passe([SALLE()], [{ clientId: 'machine-a' }, { clientId: 'machine-b' }])
    expect(arrivee.map((avis) => avis.tag)).toEqual(['appairage'])
  })

  it('oublie une salle retirée du programme', () => {
    const veille = new VeilleSupervision()
    veille.passe([SALLE({ connectivity: 'OFFLINE' })])
    veille.passe([])

    // Sans l'oubli, son retour se lirait comme un changement d'état alors que
    // c'est une salle qu'on redécouvre.
    expect(veille.passe([SALLE()])).toEqual([])
  })
})

describe('abonnements', () => {
  let db: HubDatabase
  let sqlite: Database.Database

  beforeEach(() => {
    const ouvert = openHubDatabase(':memory:')
    db = ouvert.orm
    sqlite = ouvert.sqlite
  })

  afterEach(() => {
    sqlite.close()
  })

  it('fabrique une paire de clés et la garde entre deux démarrages', () => {
    const premier = new PushService(db)
    const cle = premier.publicKey()
    expect(cle).toBeTruthy()

    // Des clés qui changeraient à chaque redémarrage invalideraient tous les
    // abonnements, et personne ne se réabonne deux fois.
    expect(new PushService(db).publicKey()).toBe(cle)
  })

  it('préfère les clés de la configuration', async () => {
    const webpush = (await import('web-push')).default
    const paire = webpush.generateVAPIDKeys()

    const service = new PushService(db, { ...paire, subject: 'mailto:ops@cloudnord.fr' })
    expect(service.publicKey()).toBe(paire.publicKey)
  })

  it('désactive le push sur une clé illisible, sans arrêter le hub', () => {
    // Une ligne de `.env` mal recopiée ne doit pas condamner l'événement : le
    // push est un confort de supervision, pas le cœur du système.
    const service = new PushService(db, {
      publicKey: 'pas-une-cle',
      privateKey: 'pas-une-cle-non-plus',
      subject: 'mailto:ops@cloudnord.fr',
    })

    expect(service.publicKey()).toBeNull()
    expect(service.unavailableReason()).toContain('VAPID')
  })

  it('remplace un abonnement au lieu de le doubler', () => {
    const service = new PushService(db)
    const abonnement = {
      endpoint: 'https://push.exemple/abc',
      p256dh: 'cle',
      auth: 'secret',
      userId: 'op-1',
      label: 'iPhone',
    }
    service.subscribe(abonnement)
    // Le navigateur rend le même endpoint après une réinstallation : un doublon
    // enverrait deux fois chaque avis.
    service.subscribe({ ...abonnement, label: 'iPhone de la régie' })

    expect(service.count()).toBe(1)
  })

  it('oublie un abonnement que le service de push a révoqué', async () => {
    const service = new PushService(db)
    service.subscribe({
      endpoint: 'https://push.exemple/mort',
      p256dh: 'cle',
      auth: 'secret',
      userId: null,
      label: null,
    })

    const webpush = (await import('web-push')).default
    // 410 Gone : le navigateur a désinstallé la page ou révoqué la permission.
    vi.spyOn(webpush, 'sendNotification').mockRejectedValue(
      Object.assign(new Error('Gone'), { statusCode: 410 }),
    )

    await service.send({ title: 'x', body: 'y', tag: 'z' })
    expect(service.count()).toBe(0)
    vi.restoreAllMocks()
  })

  it('garde un abonnement après une panne passagère', async () => {
    const service = new PushService(db)
    service.subscribe({
      endpoint: 'https://push.exemple/vivant',
      p256dh: 'cle',
      auth: 'secret',
      userId: null,
      label: null,
    })

    const webpush = (await import('web-push')).default
    vi.spyOn(webpush, 'sendNotification').mockRejectedValue(
      Object.assign(new Error('timeout'), { statusCode: 502 }),
    )

    await service.send({ title: 'x', body: 'y', tag: 'z' })
    // Réseau ou quota : l'abonnement est toujours bon, et le prochain avis
    // passera.
    expect(service.count()).toBe(1)
    vi.restoreAllMocks()
  })
})
