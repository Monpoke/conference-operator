import { describe, expect, it } from 'vitest'
import { ulid } from './ulid.js'
import {
  DELIVERY_BY_EVENT,
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
      'ingest',
      'messages',
      'meta',
      'program',
      'questions',
      'rooms',
      'sessions',
      'settings',
      'wall',
    ])
    // Le cycle de vie est pilotable des deux côtés : régie de salle et console.
    expect(Object.keys(contract.sessions).sort()).toEqual(['end', 'reset', 'start', 'states'])
    expect(Object.keys(contract.rooms).sort()).toEqual([
      'commands',
      'list',
      // Publique : une machine non appairée doit pouvoir proposer un choix de salle.
      'public',
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
      'pending',
      'revoke',
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
    expect(hubSettingsSchema.parse({})).toEqual({ autoEndEnabled: true, autoEndGraceMinutes: 5 })
    expect(() => hubSettingsSchema.parse({ autoEndGraceMinutes: -1 })).toThrow()
    // Deux heures de grâce n'auraient plus rien d'automatique.
    expect(() => hubSettingsSchema.parse({ autoEndGraceMinutes: 121 })).toThrow()
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
