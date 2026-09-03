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
 * The hub's schema (SQLite/WAL, single instance).
 *
 * Structured payloads are stored as JSON text rather than exploded into columns:
 * their shape is already guaranteed by the zod schemas of `@cloudnord/contract`,
 * and adding a field must not force a migration on the eve of the event.
 *
 * Column and table names never change: they are the disk. Where one is French
 * (`niveau_technique`, `debit_octets_s`), the Drizzle property keeps the same
 * spelling so that a name found in a SQL query can be grepped in the code.
 */

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

/** Versioned program snapshots. We keep the history for a rollback. */
export const programSnapshot = sqliteTable('program_snapshot', {
  contentHash: text('content_hash').primaryKey(),
  sourceUrl: text('source_url').notNull(),
  /** The upstream export as is: lets normalization be replayed after a fix. */
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
    /** `event.tracks[].id` from the upstream export. */
    trackId: text('track_id').notNull(),
    configJson: text('config_json').notNull(),
    /** RTMP key encrypted at rest; leaves the hub only towards its own room. */
    streamKeyEnc: text('stream_key_enc'),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [index('room_track_idx').on(table.trackId)],
)

/** Last known state of a room, fed by the heartbeats. */
export const roomState = sqliteTable('room_state', {
  roomId: text('room_id')
    .primaryKey()
    .references(() => room.id, { onDelete: 'cascade' }),
  connectivity: text('connectivity').notNull().default('OFFLINE'),
  lastSeenAt: text('last_seen_at'),
  sceneRole: text('scene_role'),
  /** What the room's screen is showing, reported on the heartbeat. */
  displayMode: text('display_mode'),
  currentSessionId: text('current_session_id'),
  recording: integer('recording', { mode: 'boolean' }).notNull().default(false),
  streaming: integer('streaming', { mode: 'boolean' }).notNull().default(false),
  outboxDepth: integer('outbox_depth').notNull().default(0),
  programContentHash: text('program_content_hash'),
  /** Highest event `seq` applied, to detect gaps. */
  lastSeq: integer('last_seq').notNull().default(0),
})

/**
 * Append-only log of the events reported by the rooms.
 *
 * The composite primary key `(room_id, id)` **is** the idempotency mechanism: a
 * batch replayed after reconnection hits the constraint instead of duplicating a
 * row. That is what makes the outbox safely replayable.
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
 * Downstream commands. A null `room_id` = broadcast to every room.
 *
 * `seq` is **globally** monotonic, not per room, and that is deliberate: a
 * room's flow mixes its own commands with the global broadcasts. With two
 * separate counters, the merged flow's `seq` would no longer increase and
 * resumption by `lastEventId` would skip commands. So the auto-incremented key
 * directly acts as `seq`.
 */
export const command = sqliteTable(
  'command',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    roomId: text('room_id').references(() => room.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    /** `null` = no expiry (durable state change). */
    ttlSeconds: integer('ttl_seconds'),
    issuedAt: text('issued_at').notNull().default(now),
  },
  (table) => [index('command_room_idx').on(table.roomId, table.seq)],
)

/**
 * Wall messages, from every source.
 *
 * The auto-incremented `seq` acts as a stable ordering **and** as the event
 * identifier for resuming the flow (`lastEventId`), as for the commands. `id`
 * stays the public identifier, the one handled in the admin console.
 */
export const comment = sqliteTable(
  'comment',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    source: text('source').notNull(),
    author: text('author').notNull(),
    authorHandle: text('author_handle'),
    /** Post identifier at the source (Bluesky URI, Mastodon id…), `null` for the form. */
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
     * Deduplication of the social sources: a firehose can redeliver a post, and
     * polling always overlaps the previous window a little. SQLite treats NULLs
     * as distinct, so the form's messages (null `external_id`) are not
     * constrained by this index.
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

/** One vote per device and per question, without requiring a user account. */
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

/** Decisions taken on the day (delay, cancellation, room change) with no reimport. */
export const sessionOverride = sqliteTable('session_override', {
  sessionId: text('session_id').primaryKey(),
  status: text('status').notNull(),
  delayMinutes: integer('delay_minutes'),
  note: text('note'),
  updatedAt: text('updated_at').notNull().default(now),
})

/**
 * A talk's OpenFeedback identifier, when the export's does not work.
 *
 * The `openfeedback.io/{project}/{day}/{id}` address is built with no network
 * call at all, betting that OpenFeedback reuses the session identifiers of the
 * upstream export. The bet has held so far — all twenty-seven match — but nothing
 * guarantees it, and it is a bet that is lost silently: the link stays clickable,
 * the QR code stays scannable, and they lead to a page that talks about no talk.
 * Nobody notices before the feedback is missing, which is to say too late.
 *
 * A row here corrects one slot, by hand, without touching the export. A separate
 * table and not a column of `session_override`: that one carries a decision about
 * the slot's *kind*, with a mandatory `status`, and correcting an identifier is
 * not deciding that a talk is a break.
 *
 * Survives a reimport, like the overrides: it really is a property of the hub,
 * not of the program, and the reimported program would bring back the faulty
 * identifier.
 */
export const sessionFeedback = sqliteTable('session_feedback', {
  sessionId: text('session_id').primaryKey(),
  /** What goes into the URL in place of the export's identifier. */
  feedbackId: text('feedback_id').notNull(),
  updatedAt: text('updated_at').notNull().default(now),
})

/**
 * Machine → room binding.
 *
 * Better Auth (device authorization) authenticates **the operator** who put the
 * machine into service: `/device/approve` binds the device to the user who
 * approves, not to a room. Which room a machine serves belongs to our domain, and
 * therefore to this table.
 *
 * Practical consequence: revoking a machine (`revoked_at`) cuts its access
 * without touching the operator's account, and a spare machine is reassigned to a
 * room without going through an account again.
 */
export const roomDevice = sqliteTable(
  'room_device',
  {
    /** ULID generated and persisted by the client at first launch (OAuth `client_id`). */
    clientId: text('client_id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => room.id, { onDelete: 'cascade' }),
    /** Label readable in the control room: "PC régie salle 1". */
    label: text('label'),
    /** Better Auth user who approved the device — an accountability trace. */
    approvedByUserId: text('approved_by_user_id'),
    /*
     * Fingerprint of the machine token.
     *
     * Better Auth authenticates the operator who approves; their session gives
     * them every right in the console. A control machine has no reason to be able
     * to import a program or moderate the wall. So it is issued its own token,
     * with reduced rights, exchanged for the approval session.
     *
     * Stored hashed: a database leak must not make the rooms impersonable.
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
 * Pending pairing requests.
 *
 * Fed by the plugin's `onDeviceAuthRequest` hook: without it, the admin console
 * would see a user code with no idea which machine is asking.
 */
export const deviceRequest = sqliteTable('device_request', {
  clientId: text('client_id').primaryKey(),
  scope: text('scope'),
  requestedAt: text('requested_at').notNull().default(now),
})

/**
 * A talk's lifecycle.
 *
 * Distinct from `session_override`: that one says what *changes* relative to the
 * program (delay, cancellation), this one says where the talk really stands. A
 * session with no row here is simply "upcoming" — we only write what happened.
 */
export const sessionState = sqliteTable(
  'session_state',
  {
    sessionId: text('session_id').primaryKey(),
    roomId: text('room_id').references(() => room.id, { onDelete: 'cascade' }),
    /** `running` or `ended`. The absence of a row means `scheduled`. */
    status: text('status').notNull(),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    /**
     * Who decided. `auto` when the scheduling rule closed the slot: in the
     * control room, knowing whether a talk was ended by a human or by the rule
     * changes how you read it.
     */
    decidedBy: text('decided_by').notNull(),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (table) => [index('session_state_room_idx').on(table.roomId, table.status)],
)

/**
 * Who holds a room's mobile control app.
 *
 * One row per **held** room, and nothing for the others: like `session_state`,
 * the table only contains what happened. Making it exhaustive would mean creating
 * a row per room at program import, for a state whose default value is "nobody".
 *
 * No expiry column: it is computed on read (`last_seen_at + CONTROL_LOCK_TTL_MS`).
 * A written column would require a sweep to keep it up to date, and a lock whose
 * deadline has passed but whose row says otherwise is exactly the kind of state we
 * do not want to be able to manufacture.
 */
export const regieLock = sqliteTable('regie_lock', {
  roomId: text('room_id')
    .primaryKey()
    .references(() => room.id, { onDelete: 'cascade' }),
  /** The operator's address, like `session_state.decided_by`. */
  holder: text('holder').notNull(),
  /**
   * The tab holding the room, and not the account.
   *
   * Two tabs of the same person would otherwise drive the same room each
   * believing it was alone — the situation the lock exists to remove. The empty
   * default covers the rows from before this column: a lock lives thirty seconds,
   * there is none at migration time.
   */
  holderId: text('holder_id').notNull().default(''),
  /** Since when that person has held the room. A takeover resets it. */
  heldSince: text('held_since').notNull().default(now),
  /** Last heartbeat received. That is what keeps the lock alive. */
  lastSeenAt: text('last_seen_at').notNull().default(now),
})

/**
 * Hub settings, as JSON key/value.
 *
 * Deliberately generic: these settings get changed on the day, often in a hurry,
 * and adding a column each time would force a migration at the worst moment.
 */
export const hubSetting = sqliteTable('hub_setting', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at').notNull().default(now),
})

/**
 * Web Push subscriptions of the consoles.
 *
 * One row per browser, not per operator: the same person watches the console on
 * their phone and on a machine, and does not expect the same thing from both. The
 * `endpoint` is the identity the browser's push service gives; it is the key,
 * because it is what becomes invalid and what the service tells us about with a
 * 404 or a 410.
 */
export const pushSubscription = sqliteTable('push_subscription', {
  endpoint: text('endpoint').primaryKey(),
  /** The browser's encryption keys: the hub cannot push without them. */
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  /** Operator who subscribed, to revoke along with the account. */
  userId: text('user_id'),
  /** Readable label — "the control room's iPhone" — left to the client. */
  label: text('label'),
  /**
   * Level wanted per family: `rien`, `essentiel` or `tout`.
   *
   * Here and not in an operator setting: filtering happens at send time, and a
   * send targets a browser. The phone in a pocket and the console sitting on the
   * table do not expect the same thing from the day.
   */
  niveauTechnique: text('niveau_technique').notNull().default('essentiel'),
  niveauExploitation: text('niveau_exploitation').notNull().default('essentiel'),
  createdAt: text('created_at').notNull().default(now),
  /** Last accepted send: used to purge what no longer answers. */
  lastPushedAt: text('last_pushed_at'),
})

/**
 * Uploads of the rushes to the S3 storage.
 *
 * The hub keeps the register because it holds the keys: it is the one that opens
 * a multipart at the storage, the one that collects the ETags — S3 asks for all
 * of them again when reassembling the object —, and the one that abandons what is
 * left hanging. A room that loses its local database can ask for its plan again;
 * the reverse is not true, and that is why the truth lives here.
 *
 * None of this exists as long as no storage is configured.
 */
export const vodUpload = sqliteTable(
  'vod_upload',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => room.id, { onDelete: 'cascade' }),
    /** Path relative to the recordings root, as the room names it. */
    file: text('file').notNull(),
    /** `rush` or `sidecar`: both leave, extension aside. */
    kind: text('kind').notNull(),
    sessionId: text('session_id'),
    objectKey: text('object_key').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    partSizeBytes: integer('part_size_bytes').notNull(),
    bytesSent: integer('bytes_sent').notNull().default(0),
    /** Multipart identifier at S3. `null` for a direct send (the sidecar). */
    s3UploadId: text('s3_upload_id'),
    /**
     * `[{n, etag}]` of the parts that have arrived.
     *
     * This is not bookkeeping: `CompleteMultipartUpload` requires the full list,
     * part by part. Losing it makes the object unrecoverable at the storage even
     * though all its bytes are already there.
     */
    partsJson: text('parts_json').notNull().default('[]'),
    state: text('state').notNull().default('en-cours'),
    /** Last observed throughput, in bytes/s — what the console shows. */
    debitOctetsS: integer('debit_octets_s'),
    startedAt: text('started_at').notNull().default(now),
    /**
     * Last part received.
     *
     * That is the field housekeeping works from: a room switched off mid-upload
     * says nothing, and a multipart abandoned in silence stays billed
     * indefinitely.
     */
    lastProgressAt: text('last_progress_at').notNull().default(now),
    finishedAt: text('finished_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (table) => [
    /**
     * A file only uploads once per room.
     *
     * It is this constraint that makes `vod.begin` a resumption: a rebooted
     * machine asks for its plan again, finds its row, and restarts from the next
     * part instead of opening a second multipart over the same bytes.
     */
    uniqueIndex('vod_upload_room_file_idx').on(table.roomId, table.file),
    index('vod_upload_state_idx').on(table.state, table.lastProgressAt),
  ],
)

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
  sessionFeedback,
  roomDevice,
  deviceRequest,
  sessionState,
  hubSetting,
  pushSubscription,
  vodUpload,
}
