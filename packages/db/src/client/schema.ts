import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * Schéma local du client de salle (SQLite, dans `userData`).
 *
 * Tout ce qui doit survivre à un crash, un redémarrage ou une journée entière
 * sans réseau vit ici. Une salle démarre et fonctionne à partir de cette base
 * seule, sans jamais joindre le hub.
 */

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

/** Snapshots reçus du hub. Plusieurs versions coexistent pour permettre un retour arrière. */
export const programCache = sqliteTable('program_cache', {
  contentHash: text('content_hash').primaryKey(),
  programJson: text('program_json').notNull(),
  syncedAt: text('synced_at').notNull().default(now),
  active: integer('active', { mode: 'boolean' }).notNull().default(false),
})

/** Réglages de la salle. Une seule ligne (`id = 1`), pour garder les lectures triviales. */
export const roomSettings = sqliteTable('room_settings', {
  id: integer('id').primaryKey().default(1),
  roomId: text('room_id'),
  token: text('token'),
  configJson: text('config_json'),
  activeContentHash: text('active_content_hash'),
  /**
   * Comptes de l'événement, poussés par le hub au sync.
   *
   * Mis en cache comme le programme, et pour la même raison : la boucle
   * d'attente tourne pendant les pauses — quand le réseau de l'événement est le
   * plus chargé — et une salle qui démarre hub injoignable doit dérouler la
   * même boucle qu'une autre.
   */
  socialLinksJson: text('social_links_json'),
  /**
   * Identité de l'événement, poussée par le hub au sync.
   *
   * En cache pour la même raison que le reste : une salle qui démarre hub
   * injoignable doit titrer ses fenêtres et sa boucle d'attente du nom de
   * l'événement, pas d'un nom compilé dans le binaire — sinon la machine
   * installée pour une édition affiche l'ancienne pendant la suivante.
   */
  eventIdentityJson: text('event_identity_json'),
  /**
   * Rapatriement des rushes : le hub a-t-il une destination, et sous quelles
   * règles. Poussé au sync, en cache pour la même raison que le reste.
   *
   * Le régulateur tranche plusieurs fois par minute et ne doit jamais dépendre
   * d'un appel réseau — surtout pas au moment précis où le réseau est ce qu'on
   * cherche à ménager. Absent, rien ne part : c'est le bon défaut.
   */
  vodJson: text('vod_json'),
  /** Prochain `seq` à attribuer aux événements sortants. Monotone, jamais réinitialisé. */
  nextSeq: integer('next_seq').notNull().default(1),
  /** Dernier `seq` de commande appliqué : c'est le `lastEventId` renvoyé à la reprise. */
  lastCommandSeq: integer('last_command_seq').notNull().default(0),
  /** Offset d'horloge lissé vs le hub. Les timecodes VOD en dépendent. */
  clockOffsetMs: integer('clock_offset_ms').notNull().default(0),
  updatedAt: text('updated_at').notNull().default(now),
})

/**
 * File d'attente durable des événements montants.
 *
 * `delivery = 'required'`     → rejoué jusqu'à `expires_at` (48 h par défaut)
 * `delivery = 'best-effort'`  → abandonné dès `expires_at` (30 s), collapsé par `dedup_key`
 */
export const outbox = sqliteTable(
  'outbox',
  {
    /** ULID généré côté client ; forme avec `roomId` la clé d'idempotence côté hub. */
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    delivery: text('delivery').notNull(),
    payloadJson: text('payload_json').notNull(),
    occurredAt: text('occurred_at').notNull(),
    monotonicMs: integer('monotonic_ms').notNull(),
    /**
     * Collapse : à `dedup_key` égale, seule la dernière occurrence non envoyée
     * survit. Évite qu'une heure hors-ligne accumule 720 heartbeats.
     */
    dedupKey: text('dedup_key'),
    expiresAt: text('expires_at'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: text('next_attempt_at').notNull().default(now),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [
    /** Index d'élection du prochain lot : ordre d'émission strict par salle. */
    index('outbox_ready_idx').on(table.nextAttemptAt, table.seq),
    index('outbox_delivery_idx').on(table.delivery, table.expiresAt),
    /**
     * Un seul enregistrement en attente par `dedup_key` : le collapse est
     * garanti par la base, pas seulement par le code appelant.
     */
    uniqueIndex('outbox_dedup_idx').on(table.roomId, table.dedupKey),
  ],
)

/** Commandes déjà appliquées : protège du rejeu après reconnexion. */
export const appliedCommand = sqliteTable('applied_command', {
  seq: integer('seq').primaryKey(),
  type: text('type').notNull(),
  appliedAt: text('applied_at').notNull().default(now),
})

/**
 * Cache d'assets adressé par contenu. Une fois rempli, aucune source navigateur
 * d'OBS ne touche Internet pendant l'événement.
 */
export const assetCache = sqliteTable(
  'asset_cache',
  {
    sha256: text('sha256').primaryKey(),
    sourceUrl: text('source_url').notNull(),
    contentType: text('content_type'),
    byteSize: integer('byte_size').notNull(),
    downloadedAt: text('downloaded_at').notNull().default(now),
  },
  (table) => [index('asset_cache_source_idx').on(table.sourceUrl)],
)

/**
 * Journal local : événements rejetés définitivement par le hub, erreurs OBS,
 * incidents. C'est la trace exploitable quand le réseau a été absent toute la journée.
 */
export const journal = sqliteTable(
  'journal',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    level: text('level').notNull(),
    message: text('message').notNull(),
    contextJson: text('context_json'),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [index('journal_created_idx').on(table.createdAt)],
)

/**
 * File des rushes à téléverser, et où en est chacun.
 *
 * Persistée pour la même raison que l'outbox : une machine redémarrée en pleine
 * montée doit repartir de la part suivante, pas du premier octet. Sur un rush de
 * trois gigaoctets et un réseau d'événement, la différence entre les deux est
 * celle entre « ça finira » et « ça ne finira jamais ».
 *
 * Le plan lui-même (`objectKey`, `s3UploadId`, taille de part) vient du hub :
 * on le garde ici pour pouvoir reprendre sans redemander, et on le redemande
 * quand même au premier échec — c'est le hub qui fait foi.
 */
export const televersement = sqliteTable(
  'televersement',
  {
    /** Chemin relatif à la racine des enregistrements : la clé de `vod-index`. */
    file: text('file').primaryKey(),
    kind: text('kind').notNull().default('rush'),
    sessionId: text('session_id'),
    tailleOctets: integer('taille_octets').notNull().default(0),
    objectKey: text('object_key'),
    s3UploadId: text('s3_upload_id'),
    taillePartOctets: integer('taille_part_octets'),
    /** Numéros de parts déjà acquittées par le hub. */
    partsJson: text('parts_json').notNull().default('[]'),
    octetsEnvoyes: integer('octets_envoyes').notNull().default(0),
    state: text('state').notNull().default('attente'),
    /**
     * Demandé par un humain, ici ou depuis la console.
     *
     * Le régulateur s'en sert pour passer outre ses règles d'attente : celui
     * qui appuie sur le bouton sait ce qu'il fait, et lui répondre « pas
     * maintenant » sans rien montrer se lit comme un bouton mort.
     */
    manuel: integer('manuel', { mode: 'boolean' }).notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Débit de la dernière part, en octets/s : c'est lui qui fait lever le pied. */
    debitOctetsS: integer('debit_octets_s'),
    nextAttemptAt: text('next_attempt_at').notNull().default(now),
    demandeA: text('demande_a').notNull().default(now),
    commenceA: text('commence_a'),
    finiA: text('fini_a'),
  },
  (table) => [
    /** Élection du prochain candidat : les demandes manuelles d'abord. */
    index('televersement_pret_idx').on(table.state, table.nextAttemptAt),
  ],
)

export const clientSchema = {
  programCache,
  roomSettings,
  outbox,
  appliedCommand,
  assetCache,
  journal,
  televersement,
}
