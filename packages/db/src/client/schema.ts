import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * Local schema of the room client (SQLite, in `userData`).
 *
 * Everything that must survive a crash, a restart or a whole day with no network
 * lives here. A room starts and runs from this database alone, without ever
 * reaching the hub.
 *
 * Table and column names never change: they are the disk of machines already in
 * the field. Where one is French (`televersement`, `octets_envoyes`), the Drizzle
 * property keeps the same spelling so that a name found in a SQL query can be
 * grepped in the code.
 */

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

/** Snapshots received from the hub. Several versions coexist to allow a rollback. */
export const programCache = sqliteTable('program_cache', {
  contentHash: text('content_hash').primaryKey(),
  programJson: text('program_json').notNull(),
  syncedAt: text('synced_at').notNull().default(now),
  active: integer('active', { mode: 'boolean' }).notNull().default(false),
})

/** The room's settings. A single row (`id = 1`), to keep reads trivial. */
export const roomSettings = sqliteTable('room_settings', {
  id: integer('id').primaryKey().default(1),
  roomId: text('room_id'),
  token: text('token'),
  configJson: text('config_json'),
  activeContentHash: text('active_content_hash'),
  /**
   * The event's accounts, pushed by the hub at sync.
   *
   * Cached like the program, and for the same reason: the waiting loop runs
   * during the breaks — when the event network is busiest — and a room starting
   * with an unreachable hub must run the same loop as any other.
   */
  socialLinksJson: text('social_links_json'),
  /**
   * The event's identity, pushed by the hub at sync.
   *
   * Cached for the same reason as the rest: a room starting with an unreachable
   * hub must title its windows and its waiting loop with the event's name, not
   * with a name compiled into the binary — otherwise the machine installed for one
   * edition shows the old one during the next.
   */
  eventIdentityJson: text('event_identity_json'),
  /**
   * Shipping the rushes back: does the hub have a destination, and under what
   * rules. Pushed at sync, cached for the same reason as the rest.
   *
   * The regulator decides several times a minute and must never depend on a
   * network call — least of all at the very moment the network is what we are
   * trying to spare. Absent, nothing leaves: that is the right default.
   */
  vodJson: text('vod_json'),
  /** Next `seq` to assign to outgoing events. Monotonic, never reset. */
  nextSeq: integer('next_seq').notNull().default(1),
  /** Last command `seq` applied: it is the `lastEventId` sent back on resumption. */
  lastCommandSeq: integer('last_command_seq').notNull().default(0),
  /** Smoothed clock offset vs the hub. The VOD timecodes depend on it. */
  clockOffsetMs: integer('clock_offset_ms').notNull().default(0),
  updatedAt: text('updated_at').notNull().default(now),
})

/**
 * Durable queue of the upstream events.
 *
 * `delivery = 'required'`     → replayed until `expires_at` (48 h by default)
 * `delivery = 'best-effort'`  → dropped at `expires_at` (30 s), collapsed by `dedup_key`
 */
export const outbox = sqliteTable(
  'outbox',
  {
    /** ULID generated client-side; forms the hub's idempotency key with `roomId`. */
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    delivery: text('delivery').notNull(),
    payloadJson: text('payload_json').notNull(),
    occurredAt: text('occurred_at').notNull(),
    monotonicMs: integer('monotonic_ms').notNull(),
    /**
     * Collapse: for an equal `dedup_key`, only the last unsent occurrence
     * survives. Stops an hour offline from piling up 720 heartbeats.
     */
    dedupKey: text('dedup_key'),
    expiresAt: text('expires_at'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: text('next_attempt_at').notNull().default(now),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [
    /** Index for electing the next batch: strict send order per room. */
    index('outbox_ready_idx').on(table.nextAttemptAt, table.seq),
    index('outbox_delivery_idx').on(table.delivery, table.expiresAt),
    /**
     * A single pending record per `dedup_key`: the collapse is guaranteed by the
     * database, not only by the calling code.
     */
    uniqueIndex('outbox_dedup_idx').on(table.roomId, table.dedupKey),
  ],
)

/** Commands already applied: protects against a replay after reconnection. */
export const appliedCommand = sqliteTable('applied_command', {
  seq: integer('seq').primaryKey(),
  type: text('type').notNull(),
  appliedAt: text('applied_at').notNull().default(now),
})

/**
 * Content-addressed asset cache. Once filled, no OBS browser source touches the
 * internet during the event.
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
 * Local log: events definitively rejected by the hub, OBS errors, incidents. It
 * is the usable trace when the network has been absent all day.
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
 * Queue of the rushes to upload, and where each stands.
 *
 * Persisted for the same reason as the outbox: a machine rebooted mid-upload must
 * restart from the next part, not from the first byte. On a three-gigabyte rush
 * and an event network, the difference between the two is the difference between
 * "it will finish" and "it will never finish".
 *
 * The plan itself (`objectKey`, `s3UploadId`, part size) comes from the hub: we
 * keep it here to be able to resume without asking again, and we ask again anyway
 * on the first failure — the hub is authoritative.
 */
export const televersement = sqliteTable(
  'televersement',
  {
    /** Path relative to the recordings root: the key of `vod-index`. */
    file: text('file').primaryKey(),
    kind: text('kind').notNull().default('rush'),
    sessionId: text('session_id'),
    tailleOctets: integer('taille_octets').notNull().default(0),
    objectKey: text('object_key'),
    s3UploadId: text('s3_upload_id'),
    taillePartOctets: integer('taille_part_octets'),
    /** Numbers of the parts already acknowledged by the hub. */
    partsJson: text('parts_json').notNull().default('[]'),
    octetsEnvoyes: integer('octets_envoyes').notNull().default(0),
    state: text('state').notNull().default('attente'),
    /**
     * Requested by a human, here or from the console.
     *
     * The regulator uses it to override its waiting rules: whoever presses the
     * button knows what they are doing, and answering "not now" without showing
     * anything reads as a dead button.
     */
    manuel: integer('manuel', { mode: 'boolean' }).notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Throughput of the last part, in bytes/s: it is what makes us ease off. */
    debitOctetsS: integer('debit_octets_s'),
    nextAttemptAt: text('next_attempt_at').notNull().default(now),
    demandeA: text('demande_a').notNull().default(now),
    commenceA: text('commence_a'),
    finiA: text('fini_a'),
  },
  (table) => [
    /** Electing the next candidate: manual requests first. */
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
