import { eventIterator, oc } from '@orpc/contract'
import { z } from 'zod'
import { programSchema } from '@cloudnord/program'
import { commandSchema } from './commands.js'
import { envelopeSchema, ingestResultSchema } from './events.js'
import {
  isoDateTimeSchema,
  roomIdSchema,
  sessionIdSchema,
  PROTOCOL_VERSION,
} from './primitives.js'
import {
  hubSettingsSchema,
  roomConfigSchema,
  roomStatusSchema,
  sessionStateSchema,
  sessionStateViewSchema,
  syncResultSchema,
} from './room-state.js'
import { commentSchema, commentSourceSchema, questionSchema } from './wall.js'

/**
 * Contrat unique du système, monté sur trois transports :
 *  - HTTP/Fastify  → hub-admin, wall-web
 *  - WebSocket     → room-client ↔ hub
 *  - MessagePort   → Electron main ↔ renderers (régie, display, overlay)
 *
 * Une seule définition, aucune duplication : validé par `spikes/orpc-v2`.
 */

export const contract = {
  meta: {
    /** Ping de disponibilité applicative — sert aussi de base à l'offset d'horloge. */
    hello: oc
      .input(z.object({ protocolVersion: z.number().int() }))
      .output(
        z.object({
          protocolVersion: z.literal(PROTOCOL_VERSION),
          serverTime: isoDateTimeSchema,
          /** Heure simulée : à signaler, sinon l'écart avec la réalité déroute. */
          simulatedClock: z.boolean().default(false),
          compatible: z.boolean(),
        }),
      ),
  },

  program: {
    /** Importe l'export amont et crée un snapshot versionné. Admin. */
    import: oc
      .input(z.object({ sourceUrl: z.url() }))
      .output(
        z.object({
          contentHash: z.string(),
          importedAt: isoDateTimeSchema,
          program: programSchema,
        }),
      ),
    /** Historique des snapshots, pour rollback en un clic le jour J. */
    snapshots: oc.output(
      z.array(
        z.object({
          contentHash: z.string(),
          importedAt: isoDateTimeSchema,
          active: z.boolean(),
          sessionCount: z.number().int(),
          issueCount: z.number().int(),
        }),
      ),
    ),
    activate: oc.input(z.object({ contentHash: z.string() })).output(z.object({ ok: z.boolean() })),
  },

  rooms: {
    /**
     * Liste publique des salles : identifiant et nom, rien d'autre.
     *
     * Une machine doit pouvoir proposer un choix **avant** d'être appairée,
     * donc avant d'avoir le moindre jeton. Ces noms sont déjà publics — le mur
     * scanné par les participants les affiche.
     */
    public: oc.output(z.array(z.object({ id: roomIdSchema, name: z.string() }))),
    list: oc.output(z.array(roomConfigSchema)),
    /** `since` = dernier `contentHash` connu ; le snapshot n'est renvoyé que s'il a changé. */
    sync: oc
      .input(z.object({ since: z.string().nullable() }))
      .output(syncResultSchema),
    /** Supervision des salles dans l'admin. */
    statuses: oc.output(z.array(roomStatusSchema)),
    /**
     * Flux descendant. Chaque événement est estampillé avec son `seq` via
     * `withEventMeta` : la reprise après coupure passe par `lastEventId`, pas
     * par un paramètre d'entrée.
     */
    commands: oc.output(eventIterator(commandSchema)),
  },

  /**
   * Cycle de vie des conférences.
   *
   * Piloté depuis la régie de la salle **et** depuis la console : un talk peut
   * déborder sans que l'opérateur de salle soit disponible, et l'organisateur
   * doit pouvoir trancher à distance.
   */
  sessions: {
    /** États connus. Sans `roomId`, toutes salles — c'est la vue de la console. */
    states: oc
      .input(z.object({ roomId: roomIdSchema.nullable() }))
      .output(z.array(sessionStateViewSchema)),
    start: oc.input(z.object({ sessionId: sessionIdSchema })).output(sessionStateSchema),
    end: oc.input(z.object({ sessionId: sessionIdSchema })).output(sessionStateSchema),
    /** Annule une décision : le talk redevient « à venir ». */
    reset: oc.input(z.object({ sessionId: sessionIdSchema })).output(z.object({ ok: z.boolean() })),
  },

  /**
   * Échange de messages entre la console et les salles.
   *
   * Deux sens distincts : la console diffuse une commande (immédiate, avec un
   * TTL), une salle remonte par son outbox (durable, survit à une coupure).
   */
  messages: {
    /** Envoie un message. `roomId` nul = toutes les salles. */
    send: oc
      .input(
        z.object({
          roomId: roomIdSchema.nullable(),
          text: z.string().min(1).max(500),
          level: z.enum(['info', 'warning', 'urgent']),
          target: z.enum(['operator', 'audience']),
          /** Durée d'affichage. `null` = jusqu'à remplacement. */
          ttlSeconds: z.number().int().positive().max(3600).nullable(),
        }),
      )
      .output(z.object({ ok: z.boolean() })),

    /** Messages remontés par les salles, du plus récent au plus ancien. */
    fromRooms: oc
      .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
      .output(
        z.array(
          z.object({
            id: z.string(),
            roomId: roomIdSchema,
            roomName: z.string().nullable(),
            text: z.string(),
            level: z.enum(['info', 'warning', 'urgent']),
            occurredAt: isoDateTimeSchema,
            receivedAt: isoDateTimeSchema,
          }),
        ),
      ),
  },

  /**
   * Heure du hub.
   *
   * Outil de développement : déplacer l'heure permet de dérouler une journée
   * d'événement à l'avance. Fermé par défaut côté serveur — le faire pendant
   * l'événement fausserait les timecodes des enregistrements.
   */
  clock: {
    get: oc.output(
      z.object({
        serverTime: isoDateTimeSchema,
        simulated: z.boolean(),
        /** Le hub autorise-t-il le réglage depuis la console ? */
        controllable: z.boolean(),
      }),
    ),
    /** `at` nul revient à l'heure réelle. */
    set: oc
      .input(z.object({ at: isoDateTimeSchema.nullable() }))
      .output(z.object({ serverTime: isoDateTimeSchema, simulated: z.boolean() })),
  },

  /** Réglages modifiables en cours d'événement. */
  settings: {
    get: oc.output(hubSettingsSchema),
    update: oc.input(hubSettingsSchema.partial()).output(hubSettingsSchema),
  },

  ingest: {
    /**
     * Vidange de l'outbox. Idempotent sur `(roomId, envelope.id)` : un rejeu
     * après reconnexion renvoie `duplicates`, jamais une seconde insertion.
     */
    push: oc
      .input(z.object({ batch: z.array(envelopeSchema).min(1).max(500) }))
      .output(ingestResultSchema),
  },

  wall: {
    /** Dépôt public depuis le mobile (QR). Passe par la modération. */
    post: oc
      .input(
        z.object({
          roomId: roomIdSchema.nullable(),
          author: z.string().min(1).max(80),
          text: z.string().min(1).max(500),
        }),
      )
      .output(z.object({ id: z.string(), status: z.literal('pending') })),
    /** Flux des messages approuvés, consommé par les écrans de salle. */
    feed: oc
      .input(z.object({ roomId: roomIdSchema.nullable() }))
      .output(eventIterator(commentSchema)),
    /** File de modération, toutes sources confondues. Admin. */
    pending: oc
      .input(z.object({ source: commentSourceSchema.optional() }))
      .output(z.array(commentSchema)),
    moderate: oc
      .input(z.object({ id: z.string(), decision: z.enum(['approve', 'reject']) }))
      .output(z.object({ ok: z.boolean() })),
  },

  /**
   * Appairage des machines de salle.
   *
   * L'échange de jetons lui-même se fait sur les endpoints Better Auth
   * (`/api/auth/device/*`, RFC 8628) : ces procédures-ci couvrent ce que Better
   * Auth ne sait pas — quelle salle une machine dessert.
   */
  devices: {
    /** Machines ayant demandé un appairage et pas encore traitées. Admin. */
    pending: oc.output(
      z.array(
        z.object({
          clientId: z.string(),
          scope: z.string().nullable(),
          requestedAt: isoDateTimeSchema,
        }),
      ),
    ),
    /**
     * Approuve une machine *et* l'affecte à une salle, en une seule opération.
     * Les deux doivent être atomiques : une machine approuvée mais non affectée
     * détiendrait un jeton valide sans salle, ce qui est un état inutile et
     * déroutant en régie.
     */
    approve: oc
      .input(
        z.object({
          userCode: z.string().min(4),
          clientId: z.string(),
          roomId: roomIdSchema,
          label: z.string().max(80).optional(),
        }),
      )
      .output(z.object({ ok: z.boolean() })),
    deny: oc.input(z.object({ userCode: z.string().min(4) })).output(z.object({ ok: z.boolean() })),
    /**
     * Échange la session d'approbation contre un jeton de salle.
     *
     * Appelé par la machine juste après l'appairage, avec la session que lui a
     * value l'approbation. Ce jeton porte les droits d'une salle et rien de
     * plus ; la session Better Auth est ensuite jetée.
     */
    claim: oc.output(
      z.object({
        token: z.string(),
        roomId: roomIdSchema,
      }),
    ),
    /** Machines appairées, pour la supervision et la révocation. */
    list: oc.output(
      z.array(
        z.object({
          clientId: z.string(),
          roomId: roomIdSchema,
          label: z.string().nullable(),
          approvedAt: isoDateTimeSchema,
          lastSeenAt: isoDateTimeSchema.nullable(),
          revokedAt: isoDateTimeSchema.nullable(),
        }),
      ),
    ),
    /** Coupe l'accès d'une machine sans toucher au compte de l'opérateur. */
    revoke: oc.input(z.object({ clientId: z.string() })).output(z.object({ ok: z.boolean() })),
  },

  questions: {
    post: oc
      .input(
        z.object({
          roomId: roomIdSchema,
          sessionId: sessionIdSchema.nullable(),
          author: z.string().max(80).nullable(),
          text: z.string().min(1).max(300),
        }),
      )
      .output(questionSchema),
    /** `deviceId` limite le vote multiple sans imposer de compte. */
    vote: oc
      .input(z.object({ id: z.string(), deviceId: z.string().min(8) }))
      .output(z.object({ votes: z.number().int() })),
    list: oc
      .input(z.object({ roomId: roomIdSchema, sessionId: sessionIdSchema.nullable() }))
      .output(z.array(questionSchema)),
  },
}

export type Contract = typeof contract
