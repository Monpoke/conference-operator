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

/** Abonnement qui veut tout : sert de base aux tests d'envoi. */
const TOUT = { technique: 'tout', exploitation: 'tout' } as const

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

  it('annonce début et fin depuis le cycle de vie, pas depuis la couleur', () => {
    /**
     * Une conférence terminée à l'heure passe directement de « en cours » à
     * « aucune » : déduire la fin de l'état agrégé l'aurait manquée.
     */
    const veille = new VeilleSupervision()
    const titres = (id: string) => (id === 'ses-1' ? 'HoneySwamp' : null)
    veille.passe([SALLE()], [], { 'track-1': { 'ses-1': 'scheduled' } }, titres)

    const debut = veille.passe([SALLE()], [], { 'track-1': { 'ses-1': 'running' } }, titres)
    expect(debut.map((avis) => [avis.title, avis.body, avis.niveau])).toEqual([
      ["Track #1 · c'est parti", 'HoneySwamp', 'tout'],
    ])

    const fin = veille.passe([SALLE()], [], { 'track-1': { 'ses-1': 'ended' } }, titres)
    expect(fin.map((avis) => avis.title)).toEqual(['Track #1 · terminé'])
  })

  it('sépare les étiquettes des machines et du déroulé', () => {
    // Un « c'est parti » ne doit jamais venir effacer un « ne répond plus »
    // resté non lu sur un écran de verrouillage.
    const veille = new VeilleSupervision()
    veille.passe([SALLE()], [], { 'track-1': { 'ses-1': 'scheduled' } })

    const avis = veille.passe(
      [SALLE({ connectivity: 'OFFLINE' })],
      [],
      { 'track-1': { 'ses-1': 'running' } },
    )
    const etiquettes = avis.map((a) => a.tag)
    expect(new Set(etiquettes).size).toBe(etiquettes.length)
    expect(etiquettes).toContain('salle-track-1')
    expect(etiquettes).toContain('conf-track-1')
  })

  it('classe chaque avis dans sa famille et son niveau', () => {
    const veille = new VeilleSupervision()
    veille.passe([SALLE()])

    const classe = (avis: { famille: string; niveau: string }[]) =>
      avis.map((un) => [un.famille, un.niveau])

    expect(classe(veille.passe([SALLE({ connectivity: 'OFFLINE' })]))).toEqual([
      ['technique', 'essentiel'],
    ])
    // Un soulagement, pas une décision.
    expect(classe(veille.passe([SALLE()]))).toEqual([['technique', 'tout']])
    expect(classe(veille.passe([SALLE({ conference: 'fin-proche' })]))).toEqual([
      ['exploitation', 'tout'],
    ])
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
      levels: TOUT,
    }
    service.subscribe(abonnement)
    // Le navigateur rend le même endpoint après une réinstallation : un doublon
    // enverrait deux fois chaque avis.
    service.subscribe({ ...abonnement, label: 'iPhone de la régie' })

    expect(service.count()).toBe(1)
  })

  it('ne pousse pas au-delà du niveau choisi', async () => {
    const service = new PushService(db)
    service.subscribe({
      endpoint: 'https://push.exemple/essentiel',
      p256dh: 'cle',
      auth: 'secret',
      userId: null,
      label: 'téléphone en poche',
      levels: { technique: 'essentiel', exploitation: 'essentiel' },
    })

    const webpush = (await import('web-push')).default
    const envoi = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({} as never)

    await service.send({ title: 'rythme', body: '', tag: 't', famille: 'exploitation', niveau: 'tout' })
    // Le rythme de la journée ne réveille pas un téléphone réglé sur l'essentiel.
    expect(envoi).not.toHaveBeenCalled()

    await service.send({ title: 'écart', body: '', tag: 't', famille: 'exploitation', niveau: 'essentiel' })
    expect(envoi).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it('oublie un abonnement que le service de push a révoqué', async () => {
    const service = new PushService(db)
    service.subscribe({
      endpoint: 'https://push.exemple/mort',
      p256dh: 'cle',
      auth: 'secret',
      userId: null,
      label: null,
      levels: TOUT,
    })

    const webpush = (await import('web-push')).default
    // 410 Gone : le navigateur a désinstallé la page ou révoqué la permission.
    vi.spyOn(webpush, 'sendNotification').mockRejectedValue(
      Object.assign(new Error('Gone'), { statusCode: 410 }),
    )

    await service.send({ title: 'x', body: 'y', tag: 'z', famille: 'technique', niveau: 'essentiel' })
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
      levels: TOUT,
    })

    const webpush = (await import('web-push')).default
    vi.spyOn(webpush, 'sendNotification').mockRejectedValue(
      Object.assign(new Error('timeout'), { statusCode: 502 }),
    )

    await service.send({ title: 'x', body: 'y', tag: 'z', famille: 'technique', niveau: 'essentiel' })
    // Réseau ou quota : l'abonnement est toujours bon, et le prochain avis
    // passera.
    expect(service.count()).toBe(1)
    vi.restoreAllMocks()
  })
})
