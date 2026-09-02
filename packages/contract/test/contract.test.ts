import { describe, expect, it } from 'vitest'
import { ulid } from './ulid.js'
import {
  DELIVERY_BY_EVENT,
  POLITIQUE_VOD_PAR_DEFAUT,
  PROTOCOL_VERSION,
  commandPayloadSchema,
  commandSchema,
  contract,
  envelopeSchema,
  hubSettingsSchema,
  sessionStateSchema,
  sessionStateViewSchema,
  isCommandExpired,
  roomEventPayloadSchema,
  sceneRoleMapSchema,
  syncResultSchema,
} from '../src/index.js'

const NOW = '2026-10-30T09:00:00.000+00:00'

const envelopeOf = (payload: unknown, overrides: Record<string, unknown> = {}) => ({
  id: ulid(),
  roomId: 'track-1-teilhard-de-chardin',
  seq: 42,
  occurredAt: NOW,
  monotonicMs: 123_456,
  delivery: 'required',
  payload,
  ...overrides,
})

describe('enveloppe outbox', () => {
  it('valide un événement d\'enregistrement complet', () => {
    const parsed = envelopeSchema.parse(
      envelopeOf({
        type: 'recording.stopped',
        obs: 'B',
        sessionId: 'ses-1',
        outputPath: '/rec/2026-10-30_track1_1100_honeyswamp.mkv',
        durationMs: 3_000_000,
        sidecarWritten: true,
      }),
    )
    expect(parsed.payload.type).toBe('recording.stopped')
    expect(parsed.delivery).toBe('required')
  })

  it('refuse un id qui n\'est pas un ULID', () => {
    expect(() => envelopeSchema.parse(envelopeOf({ type: 'incident', level: 'warn', message: 'x' }, { id: 'pas-un-ulid' })))
      .toThrow()
  })

  it('refuse un type d\'événement inconnu', () => {
    expect(() => envelopeSchema.parse(envelopeOf({ type: 'type.invente', foo: 1 }))).toThrow()
  })

  it('survit à un aller-retour JSON', () => {
    const envelope = envelopeSchema.parse(
      envelopeOf({ type: 'talk.marker', sessionId: 'ses-1', label: 'démo', offsetMs: 90_000 }),
    )
    expect(envelopeSchema.parse(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope)
  })
})

describe('politiques de livraison', () => {
  it('couvre exhaustivement les types d\'événements', () => {
    const declared = roomEventPayloadSchema.options
      .map((option) => option.shape.type.value as string)
      .sort()
    expect(Object.keys(DELIVERY_BY_EVENT).sort()).toEqual(declared)
  })

  it('classe la télémétrie en best-effort et le reste en required', () => {
    expect(DELIVERY_BY_EVENT['room.heartbeat']).toBe('best-effort')
    expect(DELIVERY_BY_EVENT['stream.telemetry']).toBe('best-effort')
    expect(DELIVERY_BY_EVENT['recording.started']).toBe('required')
    expect(DELIVERY_BY_EVENT['talk.marker']).toBe('required')
  })
})

describe('commandes descendantes', () => {
  const command = (payload: unknown, ttlSeconds: number | null) =>
    commandSchema.parse({ seq: 7, issuedAt: NOW, ttlSeconds, payload })

  it('valide chaque type de commande', () => {
    expect(() => commandPayloadSchema.parse({ type: 'scene.force', role: 'HOLD' })).not.toThrow()
    expect(() =>
      commandPayloadSchema.parse({ type: 'message.broadcast', text: 'Salle évacuée', level: 'urgent' }),
    ).not.toThrow()
    expect(() => commandPayloadSchema.parse({ type: 'scene.force', role: 'SCENE_INEXISTANTE' })).toThrow()
  })

  it('applique `display.set` sans sessionId explicite', () => {
    const parsed = commandPayloadSchema.parse({ type: 'display.set', mode: 'sponsors' })
    expect(parsed).toEqual({ type: 'display.set', mode: 'sponsors', sessionId: null })
  })

  it('écarte une commande rattrapée après expiration', () => {
    const lunch = command({ type: 'message.broadcast', text: 'Pause déjeuner', level: 'info' }, 600)
    const issuedMs = Date.parse(NOW)
    expect(isCommandExpired(lunch, issuedMs + 5 * 60_000)).toBe(false)
    // Reconnexion 40 minutes plus tard : le message ne doit plus s'afficher.
    expect(isCommandExpired(lunch, issuedMs + 40 * 60_000)).toBe(true)
  })

  it('garde indéfiniment une commande sans TTL', () => {
    const forced = command({ type: 'scene.force', role: 'LIVE' }, null)
    expect(isCommandExpired(forced, Date.parse(NOW) + 86_400_000)).toBe(false)
  })
})

describe('configuration de salle', () => {
  it('accepte un mapping de rôles partiel', () => {
    // OBS-A n'a que LIVE et HOLD : c'est le cas nominal, pas une erreur.
    const parsed = sceneRoleMapSchema.parse({
      A: { LIVE: 'Capture HDMI', HOLD: 'Habillage web' },
      B: { TALK: 'Talk complet', CAM_ONLY: 'Caméra seule' },
    })
    expect(parsed.A.LIVE).toBe('Capture HDMI')
    expect(parsed.B.RELAY).toBeUndefined()
  })
})

describe('surface du contrat', () => {
  it('expose les procédures attendues par chaque application', () => {
    expect(Object.keys(contract).sort()).toEqual([
      'clock',
      'devices',
      // Identité de l'événement, en lecture : ce que le hub a tranché du nom
      // affiché partout, et ce qu'il déduirait sans réglage.
      'event',
      'ingest',
      'messages',
      'meta',
      // Surface à part, et non un mode de plus sur l'écran de salle : le
      // bandeau se superpose à la vidéo là où un message d'écran remplace tout.
      'overlay',
      'program',
      // Notifications qui survivent à la fermeture de la console : la
      // supervision se regarde sur un téléphone rangé dans une poche.
      'push',
      'questions',
      'regie',
      'rooms',
      'sessions',
      'settings',
      // Rapatriement des rushes : le hub détient les clés du stockage et signe
      // des adresses, la salle téléverse. Aucun secret ne descend en salle.
      'vod',
      'wall',
    ])
    // Le cycle de vie est pilotable des deux côtés : régie de salle et console.
    // `override` corrige le programme lui-même — un déjeuner que l'export donne
    // pour une conférence — là où les quatre autres pilotent son déroulé.
    expect(Object.keys(contract.sessions).sort()).toEqual([
      'end',
      // Corrige l'identifiant OpenFeedback d'un créneau quand celui de l'export
      // ne correspond pas : sans elle, un QR mort ne se répare pas.
      'feedbackId',
      'override',
      'reset',
      'start',
      'states',
    ])
    expect(Object.keys(contract.program).sort()).toEqual([
      'activate',
      // Le seul appel sortant de la console : confronte les identifiants du
      // programme à ce qu'OpenFeedback connaît, sur demande et jamais en fond.
      'controleOpenFeedback',
      'globalBreak',
      'import',
      'planning',
      'snapshots',
    ])
    expect(Object.keys(contract.rooms).sort()).toEqual([
      'commands',
      // Une salle se règle elle-même : les adresses OBS et les noms de scènes
      // se constatent devant les machines, pas depuis la console.
      'configure',
      // Publique : le mur dit au participant ce qu'il est en train d'écouter.
      'current',
      'list',
      // Publique : une machine non appairée doit pouvoir proposer un choix de salle.
      'public',
      // Geste de console : remettre une salle d'aplomb sans la redémarrer,
      // donc sans couper sa captation.
      'resync',
      'statuses',
      'sync',
    ])
    // L'appairage passe par Better Auth ; le contrat ne porte que la partie
    // métier (quelle salle) que Better Auth ne connaît pas.
    expect(Object.keys(contract.devices).sort()).toEqual([
      'approve',
      'claim',
      'deny',
      'list',
      'lookup',
      'pending',
      'revoke',
    ])
    // Cinq procédures de salle et quatre de console. Les premières sont bornées
    // à la salle appelante par son jeton — aucune n'a de `roomId` en entrée —,
    // les secondes ne font que regarder et demander : la console ne détient pas
    // les fichiers, elle ne peut pas téléverser à la place de qui que ce soit.
    expect(Object.keys(contract.vod).sort()).toEqual([
      'abort',
      // Ouvre *ou reprend* : c'est ce qui rend une coupure à 90 % rattrapable.
      'begin',
      // Le vrai geste, pas une sonde : ouvrir, signer, écrire, abandonner.
      'check',
      'complete',
      // Le dossier d'*une* conférence : prises de la régie et objets chez le
      // stockage. L'autre sens de lecture que `uploads`, qui range par fichier.
      'conference',
      'parts',
      'progress',
      'request',
      // Efface le préfixe du bucket et les rushes des salles. Développement
      // seulement, et refusé côté serveur — pas seulement absent de la console.
      'reset',
      'status',
      'uploads',
    ])
  })

  it('n\'expose aucun paramètre de rattrapage sur le flux de commandes', () => {
    // La reprise passe par `lastEventId` d'oRPC, pas par un `sinceSeq` maison.
    const inputsOf = (procedure: unknown): unknown[] | undefined =>
      (procedure as { '~orpc': { inputSchemas?: unknown[] } })['~orpc'].inputSchemas

    expect(inputsOf(contract.rooms.commands)).toBeUndefined()
    // Contrôle que l'introspection ci-dessus n'est pas vide de sens :
    // une procédure qui prend bien une entrée doit, elle, en déclarer une.
    expect(inputsOf(contract.rooms.sync)).toHaveLength(1)
  })

  it('fige la version de protocole', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    expect(() =>
      syncResultSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        contentHash: 'abc',
        program: null,
        room: {
          id: 'track-1',
          name: 'Track 1',
          trackId: 'track-1',
          obs: { A: { url: 'ws://127.0.0.1:4455', password: null }, B: { url: 'ws://127.0.0.1:4456', password: null } },
          sceneRoles: { A: { LIVE: 'Live', HOLD: 'Hold' }, B: { TALK: 'Talk' } },
        },
        overrides: [],
        serverTime: NOW,
      }),
    ).not.toThrow()
  })
})

describe('cycle de vie des conférences', () => {
  it('n\'a pas d\'état « à venir » stocké', () => {
    // `scheduled` est l'absence d'état : le stocker reviendrait à enregistrer
    // que rien ne s'est produit.
    const etat = sessionStateSchema.parse({
      sessionId: 'ses-1',
      roomId: 'track-1',
      status: 'running',
      startedAt: '2026-10-30T10:00:00.000+00:00',
      endedAt: null,
      decidedBy: 'regie@cloudnord.fr',
    })
    expect(etat.status).toBe('running')
    expect(() => sessionStateSchema.parse({ ...etat, status: 'inventé' })).toThrow()
  })

  it('borne le délai de clôture automatique', () => {
    expect(hubSettingsSchema.parse({})).toEqual({
      autoEndEnabled: true,
      autoEndGraceMinutes: 5,
      // Aucun compte déclaré au départ : la boucle des salles saute sa page
      // réseaux plutôt que d'afficher un cadre vide.
      socialLinks: [],
      programSourceUrl: null,
      // Rien de l'événement n'est réglé par défaut : le hub le déduit du
      // programme importé, et c'est ce qui rend le dépôt agnostique.
      eventName: null,
      eventShortName: null,
      openFeedbackProjectId: null,
      // Pas de stockage, et surtout : rien qui parte tout seul. Le défaut doit
      // être le cas où aucun octet ne quitte une salle sans qu'on l'ait demandé.
      vodBucket: null,
      vodPrefix: null,
      vodPolitique: POLITIQUE_VOD_PAR_DEFAUT,
    })
    expect(POLITIQUE_VOD_PAR_DEFAUT.actif).toBe(false)
    expect(POLITIQUE_VOD_PAR_DEFAUT.debitMaxOctetsS).toBeNull()
    // Cinq mégaoctets est le minimum d'une part multipart chez S3 : descendre
    // en dessous produirait des téléversements refusés à la dernière étape.
    expect(() => hubSettingsSchema.parse({ vodPolitique: { taillePartMo: 4 } })).toThrow()
    expect(() => hubSettingsSchema.parse({ autoEndGraceMinutes: -1 })).toThrow()
    // Deux heures de grâce n'auraient plus rien d'automatique.
    expect(() => hubSettingsSchema.parse({ autoEndGraceMinutes: 121 })).toThrow()
    // L'URL est validée comme telle : un « oui » saisi dans la console ne doit
    // pas se découvrir au démarrage suivant, quand le hub tente l'import.
    expect(() => hubSettingsSchema.parse({ programSourceUrl: 'pas-une-url' })).toThrow()
  })

  it('transporte un changement d\'état vers toutes les salles', () => {
    const commande = commandPayloadSchema.parse({
      type: 'session.state',
      sessionId: 'ses-1',
      roomId: 'track-2-mf-1092',
      sessionTitle: 'HoneySwamp',
      status: 'ended',
      decidedBy: 'auto',
    })
    // La salle et le titre voyagent avec : une régie doit pouvoir signaler
    // « HoneySwamp vient de terminer à côté » sans interroger le hub.
    expect(commande).toMatchObject({
      roomId: 'track-2-mf-1092',
      sessionTitle: 'HoneySwamp',
      decidedBy: 'auto',
    })
  })

  it('enrichit l\'état des conférences pour la console', () => {
    // Un identifiant opaque ne se lit pas, et ne permet aucun calcul de temps.
    const vue = sessionStateViewSchema.parse({
      sessionId: 'ses-1',
      roomId: 'track-1',
      status: 'running',
      startedAt: '2026-10-30T10:02:00.000+00:00',
      endedAt: null,
      decidedBy: 'regie@cloudnord.fr',
      title: 'HoneySwamp',
      roomName: 'Track #1',
      scheduledStartsAt: '2026-10-30T10:00:00.000+00:00',
      scheduledEndsAt: '2026-10-30T10:50:00.000+00:00',
    })
    expect(vue.title).toBe('HoneySwamp')
    expect(vue.scheduledEndsAt).toBeTruthy()
  })
})

describe("échange de messages", () => {
  it("distingue le destinataire d'un message", () => {
    const pourLOperateur = commandPayloadSchema.parse({
      type: 'message.broadcast',
      text: 'Ton speaker est arrivé',
      level: 'info',
      target: 'operator',
    })
    // Sans cette distinction, une note à l'opérateur s'afficherait en grand
    // devant le public.
    expect(pourLOperateur).toMatchObject({ target: 'operator', from: null })

    expect(() =>
      commandPayloadSchema.parse({
        type: 'message.broadcast',
        text: 'x',
        level: 'urgent',
        target: 'tout-le-monde',
      }),
    ).toThrow()
  })

  it("retient le bandeau de régie par défaut", () => {
    // Le défaut le moins dommageable : un message qui n'atteint que
    // l'opérateur se rattrape, un message projeté par erreur non.
    const parDefaut = commandPayloadSchema.parse({
      type: 'message.broadcast',
      text: 'coucou',
      level: 'info',
    })
    expect(parDefaut).toMatchObject({ target: 'operator' })
  })

  it("classe un message de salle comme obligatoire", () => {
    const envelope = envelopeSchema.parse({
      id: '01JB2ZK5T7QW9V0YHRXM3N4P6C',
      roomId: 'track-1',
      seq: 1,
      occurredAt: '2026-10-30T10:00:00.000+00:00',
      monotonicMs: 1,
      delivery: 'required',
      payload: { type: 'room.message', text: "Besoin d'aide", level: 'urgent' },
    })
    expect(envelope.payload.type).toBe('room.message')
    // Un appel à l'aide émis pendant une coupure doit arriver, même en retard.
    expect(DELIVERY_BY_EVENT['room.message']).toBe('required')
  })
})
