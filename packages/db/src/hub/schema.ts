import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/**
 * Schéma du hub (SQLite/WAL, instance unique).
 *
 * Les payloads structurés sont stockés en JSON texte plutôt qu'éclatés en
 * colonnes : leur forme est déjà garantie par les schémas zod de
 * `@cloudnord/contract`, et un ajout de champ ne doit pas imposer une migration
 * la veille de l'événement.
 */

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

/** Snapshots versionnés du programme. On garde l'historique pour rollback. */
export const programSnapshot = sqliteTable('program_snapshot', {
  contentHash: text('content_hash').primaryKey(),
  sourceUrl: text('source_url').notNull(),
  /** Export amont tel quel : permet de rejouer la normalisation après un correctif. */
  rawJson: text('raw_json').notNull(),
  programJson: text('program_json').notNull(),
  sessionCount: integer('session_count').notNull(),
  issueCount: integer('issue_count').notNull(),
  importedAt: text('imported_at').notNull().default(now),
  active: integer('active', { mode: 'boolean' }).notNull().default(false),
})

export const room = sqliteTable(
  'room',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** `event.tracks[].id` de l'export amont. */
    trackId: text('track_id').notNull(),
    configJson: text('config_json').notNull(),
    /** Clé RTMP chiffrée au repos ; ne quitte le hub que vers sa propre salle. */
    streamKeyEnc: text('stream_key_enc'),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [index('room_track_idx').on(table.trackId)],
)

/** Dernier état connu d'une salle, alimenté par les heartbeats. */
export const roomState = sqliteTable('room_state', {
  roomId: text('room_id')
    .primaryKey()
    .references(() => room.id, { onDelete: 'cascade' }),
  connectivity: text('connectivity').notNull().default('OFFLINE'),
  lastSeenAt: text('last_seen_at'),
  sceneRole: text('scene_role'),
  currentSessionId: text('current_session_id'),
  recording: integer('recording', { mode: 'boolean' }).notNull().default(false),
  streaming: integer('streaming', { mode: 'boolean' }).notNull().default(false),
  outboxDepth: integer('outbox_depth').notNull().default(0),
  programContentHash: text('program_content_hash'),
  /** Plus haut `seq` d'événement appliqué, pour détecter les trous. */
  lastSeq: integer('last_seq').notNull().default(0),
})

/**
 * Journal append-only des événements remontés par les salles.
 *
 * La clé primaire composite `(room_id, id)` **est** le mécanisme d'idempotence :
 * un rejeu de batch après reconnexion se heurte à la contrainte au lieu de
 * dupliquer une ligne. C'est ce qui rend l'outbox rejouable sans risque.
 */
export const ingestEvent = sqliteTable(
  'ingest_event',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => room.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    delivery: text('delivery').notNull(),
    occurredAt: text('occurred_at').notNull(),
    monotonicMs: integer('monotonic_ms').notNull(),
    payloadJson: text('payload_json').notNull(),
    receivedAt: text('received_at').notNull().default(now),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.id] }),
    index('ingest_event_room_seq_idx').on(table.roomId, table.seq),
    index('ingest_event_type_idx').on(table.type),
  ],
)

/**
 * Commandes descendantes. `room_id` nul = diffusion à toutes les salles.
 *
 * `seq` est **globalement** monotone, pas par salle, et c'est délibéré : le flux
 * d'une salle mélange ses commandes propres et les diffusions globales. Avec
 * deux compteurs séparés, le `seq` du flux fusionné ne serait plus croissant et
 * la reprise par `lastEventId` sauterait des commandes. La clé auto-incrémentée
 * fait donc directement office de `seq`.
 */
export const command = sqliteTable(
  'command',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    roomId: text('room_id').references(() => room.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    /** `null` = pas d'expiration (changement d'état durable). */
    ttlSeconds: integer('ttl_seconds'),
    issuedAt: text('issued_at').notNull().default(now),
  },
  (table) => [index('command_room_idx').on(table.roomId, table.seq)],
)

/**
 * Messages du mur, toutes sources confondues.
 *
 * `seq` auto-incrémenté sert d'ordre stable **et** d'identifiant d'événement
 * pour la reprise du flux (`lastEventId`), comme pour les commandes. `id` reste
 * l'identifiant public, celui qu'on manipule dans l'admin.
 */
export const comment = sqliteTable(
  'comment',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    source: text('source').notNull(),
    author: text('author').notNull(),
    authorHandle: text('author_handle'),
    /** Identifiant du post chez la source (URI Bluesky, id Mastodon…), `null` pour le formulaire. */
    externalId: text('external_id'),
    text: text('text').notNull(),
    status: text('status').notNull().default('pending'),
    roomId: text('room_id').references(() => room.id, { onDelete: 'set null' }),
    sessionId: text('session_id'),
    createdAt: text('created_at').notNull().default(now),
    moderatedAt: text('moderated_at'),
    moderatedBy: text('moderated_by'),
  },
  (table) => [
    uniqueIndex('comment_id_idx').on(table.id),
    index('comment_status_idx').on(table.status, table.seq),
    /**
     * Déduplication des sources sociales : un firehose peut relivrer un post,
     * et un polling recouvre toujours un peu la fenêtre précédente.
     * SQLite traite les NULL comme distincts, donc les messages du formulaire
     * (`external_id` nul) ne sont pas contraints par cet index.
     */
    uniqueIndex('comment_source_external_idx').on(table.source, table.externalId),
  ],
)

export const question = sqliteTable(
  'question',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => room.id, { onDelete: 'cascade' }),
    sessionId: text('session_id'),
    author: text('author'),
    text: text('text').notNull(),
    votes: integer('votes').notNull().default(0),
    status: text('status').notNull().default('open'),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [index('question_room_status_idx').on(table.roomId, table.status)],
)

/** Un vote par appareil et par question, sans imposer de compte utilisateur. */
export const questionVote = sqliteTable(
  'question_vote',
  {
    questionId: text('question_id')
      .notNull()
      .references(() => question.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    votedAt: text('voted_at').notNull().default(now),
  },
  (table) => [primaryKey({ columns: [table.questionId, table.deviceId] })],
)

/** Décisions du jour J (retard, annulation, changement de salle) sans réimport. */
export const sessionOverride = sqliteTable('session_override', {
  sessionId: text('session_id').primaryKey(),
  status: text('status').notNull(),
  delayMinutes: integer('delay_minutes'),
  note: text('note'),
  updatedAt: text('updated_at').notNull().default(now),
})

/**
 * Liaison machine → salle.
 *
 * Better Auth (device authorization) authentifie **l'opérateur** qui a mis la
 * machine en service : `/device/approve` lie l'appareil à l'utilisateur qui
 * approuve, pas à une salle. Quelle salle une machine dessert relève de notre
 * domaine, donc de cette table.
 *
 * Conséquence pratique : révoquer une machine (`revoked_at`) coupe son accès
 * sans toucher au compte de l'opérateur, et une machine de secours se réaffecte
 * à une salle sans repasser par un compte.
 */
export const roomDevice = sqliteTable(
  'room_device',
  {
    /** ULID généré et persisté par le client au premier lancement (`client_id` OAuth). */
    clientId: text('client_id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => room.id, { onDelete: 'cascade' }),
    /** Libellé lisible en régie : « PC régie salle 1 ». */
    label: text('label'),
    /** Utilisateur Better Auth ayant approuvé l'appareil — trace d'imputabilité. */
    approvedByUserId: text('approved_by_user_id'),
    /*
     * Empreinte du jeton de machine.
     *
     * Better Auth authentifie l'opérateur qui approuve ; sa session lui donne
     * tous les droits de la console. Une machine de régie n'a aucune raison de
     * pouvoir importer un programme ou modérer le mur. On lui délivre donc son
     * propre jeton, à droits réduits, échangé contre la session d'approbation.
     *
     * Stocké haché : une fuite de la base ne doit pas rendre les salles usurpables.
     */
    tokenHash: text('token_hash'),
    tokenIssuedAt: text('token_issued_at'),
    approvedAt: text('approved_at').notNull().default(now),
    lastSeenAt: text('last_seen_at'),
    revokedAt: text('revoked_at'),
  },
  (table) => [index('room_device_room_idx').on(table.roomId)],
)

/**
 * Demandes d'appairage en attente.
 *
 * Alimentée par le hook `onDeviceAuthRequest` du plugin : sans elle, l'admin
 * verrait un code utilisateur sans savoir quelle machine le demande.
 */
export const deviceRequest = sqliteTable('device_request', {
  clientId: text('client_id').primaryKey(),
  scope: text('scope'),
  requestedAt: text('requested_at').notNull().default(now),
})

/**
 * Cycle de vie d'une conférence.
 *
 * Distinct de `session_override` : celui-ci dit ce qui *change* par rapport au
 * programme (retard, annulation), celui-là dit où en est réellement le talk.
 * Une session sans ligne ici est simplement « à venir » — on n'écrit que ce qui
 * s'est produit.
 */
export const sessionState = sqliteTable(
  'session_state',
  {
    sessionId: text('session_id').primaryKey(),
    roomId: text('room_id').references(() => room.id, { onDelete: 'cascade' }),
    /** `running` ou `ended`. L'absence de ligne vaut `scheduled`. */
    status: text('status').notNull(),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    /**
     * Qui a décidé. `auto` quand la règle horaire a clôturé le créneau : en
     * régie, savoir si un talk a été terminé par un humain ou par la règle
     * change la lecture qu'on en fait.
     */
    decidedBy: text('decided_by').notNull(),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (table) => [index('session_state_room_idx').on(table.roomId, table.status)],
)

/**
 * Réglages du hub, en clé/valeur JSON.
 *
 * Générique volontairement : ces réglages se règlent le jour J, souvent dans
 * l'urgence, et ajouter une colonne à chaque fois imposerait une migration au
 * pire moment.
 */
export const hubSetting = sqliteTable('hub_setting', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at').notNull().default(now),
})

/**
 * Abonnements Web Push des consoles.
 *
 * Une ligne par navigateur, pas par opérateur : la même personne consulte la
 * console sur son téléphone et sur un poste, et n'attend pas la même chose des
 * deux. L'`endpoint` est l'identité que donne le service de push du navigateur ;
 * c'est lui la clé, parce que c'est lui qui devient invalide et que le service
 * nous le dit alors par un 404 ou un 410.
 */
export const pushSubscription = sqliteTable('push_subscription', {
  endpoint: text('endpoint').primaryKey(),
  /** Clés de chiffrement du navigateur : le hub ne peut pas pousser sans elles. */
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  /** Opérateur qui s'est abonné, pour révoquer avec le compte. */
  userId: text('user_id'),
  /** Étiquette lisible — « iPhone de la régie » — laissée au client. */
  label: text('label'),
  /**
   * Niveau voulu par famille : `rien`, `essentiel` ou `tout`.
   *
   * Ici et non dans un réglage d'opérateur : le filtrage se fait à l'envoi, et
   * l'envoi vise un navigateur. Le téléphone dans la poche et la console posée
   * sur la table n'attendent pas la même chose de la journée.
   */
  niveauTechnique: text('niveau_technique').notNull().default('essentiel'),
  niveauExploitation: text('niveau_exploitation').notNull().default('essentiel'),
  createdAt: text('created_at').notNull().default(now),
  /** Dernier envoi accepté : sert à purger ce qui ne répond plus. */
  lastPushedAt: text('last_pushed_at'),
})

export const hubSchema = {
  programSnapshot,
  room,
  roomState,
  ingestEvent,
  command,
  comment,
  question,
  questionVote,
  sessionOverride,
  roomDevice,
  deviceRequest,
  sessionState,
  hubSetting,
  pushSubscription,
}
