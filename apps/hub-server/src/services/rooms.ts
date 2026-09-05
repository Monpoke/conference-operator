import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, isNull, lt } from 'drizzle-orm'
import {
  roomConfigSchema,
  roomStatusSchema,
  type RoomConfig,
  type RoomConfigInput,
  type RoomStatus,
} from '@conference-operator/contract'
import {
  deviceRequest,
  room,
  roomDevice,
  roomState,
  sessionFeedback,
  sessionOverride,
} from '@conference-operator/db/hub'
import type { HubDatabase } from '../db.js'

/**
 * Silence beyond which a room is declared offline.
 *
 * The rooms beat every ten seconds; three missed beats leave no doubt, and stay
 * short enough for an operator to see it before crossing the building. On the
 * real clock, like the heartbeats themselves: a simulated time would declare
 * everyone dead.
 */
const SILENCE_MS = 35_000

export class RoomService {
  constructor(private readonly db: HubDatabase) {}

  upsert(input: RoomConfigInput): void {
    // Normalized on write: what is stored already carries every default.
    const config = roomConfigSchema.parse(input)
    const values = {
      id: config.id,
      name: config.name,
      trackId: config.trackId,
      configJson: JSON.stringify(config),
    }
    this.db
      .insert(room)
      .values(values)
      .onConflictDoUpdate({ target: room.id, set: values })
      .run()
  }

  /**
   * Creates the missing rooms from the program's tracks.
   *
   * `event.tracks[]` **are** the rooms: that is the project's founding decision,
   * and it would be absurd to ask again by hand for what the export already
   * contains. Existing rooms are not touched — their OBS configuration, their
   * stream key and their scene mapping are entered once and must not be
   * overwritten on every reimport.
   */
  ensureFromTracks(tracks: { id: string; name: string }[]): { created: string[] } {
    const created: string[] = []
    for (const track of tracks) {
      if (this.get(track.id) != null) continue
      this.upsert({
        id: track.id,
        name: track.name,
        trackId: track.id,
        // Default OBS ports, to be adjusted per room if the two instances do not
        // run on the same machine.
        obs: {
          A: { url: 'ws://127.0.0.1:4455', password: null },
          B: { url: 'ws://127.0.0.1:4456', password: null },
        },
        /**
         * A default mapping rather than an empty one: a room with no roles has no
         * working button in the control app, and the error message only arrives
         * at the moment you need it. These names are to be adjusted per room if
         * OBS names its scenes otherwise — the control app reports unresolvable
         * roles as soon as it connects.
         */
        sceneRoles: {
          A: { LIVE: 'Direct — capture HDMI', HOLD: 'Habillage — écran de salle' },
          B: {
            TALK: 'Talk — caméra + slides',
            CAM_ONLY: 'Caméra seule',
            SLIDES_ONLY: 'Slides seules',
          },
        },
      })
      created.push(track.id)
    }
    return { created }
  }

  list(): RoomConfig[] {
    return this.db
      .select()
      .from(room)
      .orderBy(asc(room.name))
      .all()
      .map((row) => roomConfigSchema.parse(JSON.parse(row.configJson)))
  }

  get(roomId: string): RoomConfig | null {
    const row = this.db.select().from(room).where(eq(room.id, roomId)).get()
    return row == null ? null : roomConfigSchema.parse(JSON.parse(row.configJson))
  }

  /**
   * Brings back to the hub an OpenFeedback project once entered on a control app.
   *
   * The field used to be editable in each room's ⚙. It no longer is — the project
   * is a property of the event —, but existing databases carry its trace, and on
   * the development hub it was even the *only* trace: event setting empty, room 1
   * filled in, two rooms silent. Removing the field without taking anything over
   * would have switched off the links of the one room that had them.
   *
   * Two gestures, in this order. Adopt, if the hub has nothing: a control app's
   * value already described the whole event, it was only waiting for a place to
   * say so. Then erase the room values, all of them, including the one just
   * adopted: leaving in the database a field nothing reads any more is the best
   * way to see it resurrected at the next refactor.
   *
   * Idempotent: at the second startup there is nothing left to take over, and the
   * method does not touch the disk.
   */
  takeOverOpenFeedbackProject(settings: {
    get(): { openFeedbackProjectId: string | null }
    update(patch: { openFeedbackProjectId: string }): unknown
  }): { adopted: string | null; cleanedRooms: string[] } {
    const rooms = this.list()
    const carrying = rooms.filter(
      (item) => (item.openFeedbackProjectId ?? '').trim() !== '',
    )
    if (carrying.length === 0) return { adopted: null, cleanedRooms: [] }

    const fromHub = (settings.get().openFeedbackProjectId ?? '').trim()
    let adopted: string | null = null
    if (fromHub === '') {
      /*
       * The most frequent one, rooms walked in identifier order.
       *
       * Two control apps that contradict each other must give the same answer at
       * every startup: a takeover that depended on SQLite's read order would
       * change project on restart, and nobody would know which one was right.
       */
      const counts = new Map<string, number>()
      for (const item of [...carrying].sort((a, b) => a.id.localeCompare(b.id))) {
        const project = item.openFeedbackProjectId!.trim()
        counts.set(project, (counts.get(project) ?? 0) + 1)
      }
      let best = 0
      for (const [project, count] of counts) {
        // Strict: on a tie, the first room in order keeps the hand.
        if (count > best) {
          adopted = project
          best = count
        }
      }
      if (adopted != null) settings.update({ openFeedbackProjectId: adopted })
    }

    for (const item of carrying) {
      this.upsert({ ...item, openFeedbackProjectId: null })
    }
    return { adopted, cleanedRooms: carrying.map((item) => item.id) }
  }

  overrides(sessionIds?: string[]) {
    const rows = this.db.select().from(sessionOverride).all()
    return rows
      .filter((row) => sessionIds == null || sessionIds.includes(row.sessionId))
      .map((row) => ({
        sessionId: row.sessionId,
        status: row.status as 'talk' | 'break' | 'delayed' | 'cancelled' | 'moved',
        delayMinutes: row.delayMinutes,
        note: row.note,
      }))
  }

  /**
   * The OpenFeedback identifiers corrected by hand, per slot.
   *
   * A dictionary and not a list: the callers all ask "does this session have a
   * correction", never "give me every correction in order". Empty in the normal
   * case — the export is authoritative until somebody contradicts it.
   */
  feedbackIds(): Record<string, string> {
    const rows = this.db.select().from(sessionFeedback).all()
    return Object.fromEntries(rows.map((row) => [row.sessionId, row.feedbackId]))
  }

  /**
   * Corrects — or gives back to the export — a slot's OpenFeedback identifier.
   *
   * `null` deletes the row instead of recording an empty correction, for the same
   * reason as `setOverride`: a removed correction must be indistinguishable from
   * a correction never made. A blank string counts as `null` — an identifier made
   * of spaces only builds a dead address, and that is what the form field returns
   * when it is cleared.
   */
  setFeedbackId(sessionId: string, feedbackId: string | null): void {
    const clean = feedbackId?.trim() ?? ''
    if (clean === '') {
      this.db.delete(sessionFeedback).where(eq(sessionFeedback.sessionId, sessionId)).run()
      return
    }
    const values = { sessionId, feedbackId: clean, updatedAt: new Date().toISOString() }
    this.db
      .insert(sessionFeedback)
      .values(values)
      .onConflictDoUpdate({ target: sessionFeedback.sessionId, set: values })
      .run()
  }

  /**
   * Sets or removes a decision on a slot.
   *
   * `null` deletes the row rather than record a "nothing" status: a removed
   * override must be indistinguishable from an override never made, otherwise the
   * served program's fingerprint would not come back to its previous value and
   * the rooms would re-download for nothing.
   */
  setOverride(sessionId: string, status: 'talk' | 'break' | null): void {
    if (status == null) {
      this.db.delete(sessionOverride).where(eq(sessionOverride.sessionId, sessionId)).run()
      return
    }
    const values = {
      sessionId,
      status,
      delayMinutes: null,
      note: null,
      updatedAt: new Date().toISOString(),
    }
    this.db
      .insert(sessionOverride)
      .values(values)
      .onConflictDoUpdate({ target: sessionOverride.sessionId, set: values })
      .run()
  }

  statuses(): RoomStatus[] {
    const limit = Date.now() - SILENCE_MS
    return this.db
      .select()
      .from(room)
      .leftJoin(roomState, eq(roomState.roomId, room.id))
      .all()
      .map(({ room: r, room_state: state }) =>
        roomStatusSchema.parse({
          roomId: r.id,
          name: r.name,
          /**
           * A room that has gone quiet is offline, whatever it said last.
           *
           * `connectivity` is what the room **reported**: unplugging its PC left
           * "ONLINE" in the database forever, and the console showed a room in
           * perfect health that nobody had heard from. Silence is precisely the
           * symptom we want to see.
           */
          connectivity:
            state?.lastSeenAt != null && Date.parse(state.lastSeenAt) < limit
              ? 'OFFLINE'
              : (state?.connectivity ?? 'OFFLINE'),
          lastSeenAt: state?.lastSeenAt ?? null,
          sceneRole: state?.sceneRole ?? null,
          displayMode: state?.displayMode ?? null,
          currentSessionId: state?.currentSessionId ?? null,
          recording: state?.recording ?? false,
          streaming: state?.streaming ?? false,
          outboxDepth: state?.outboxDepth ?? 0,
          programContentHash: state?.programContentHash ?? null,
        }),
      )
  }
}

/**
 * Machine pairing.
 *
 * Better Auth covers the token exchange (RFC 8628) but binds the device to the
 * operator who approves. Which room a machine serves belongs here.
 */
export class DeviceService {
  /**
   * @param ttlMs Lifetime of a request, aligned on that of the pairing code
   *   (`DEVICE_CODE_TTL`). On the real clock, not on the hub's: Better Auth's
   *   codes also expire in real time, and a simulated time must not decide
   *   whether a pairing survives.
   */
  constructor(
    private readonly db: HubDatabase,
    private readonly ttlMs: number,
  ) {}

  /** Fed by the plugin's `onDeviceAuthRequest` hook. */
  recordRequest(clientId: string, scope: string | undefined): void {
    const values = { clientId, scope: scope ?? null, requestedAt: new Date().toISOString() }
    this.db
      .insert(deviceRequest)
      .values(values)
      .onConflictDoUpdate({ target: deviceRequest.clientId, set: values })
      .run()
  }

  /**
   * Forgets the requests whose code is worth nothing any more.
   *
   * Nothing erased them: a machine whose code expired, or which was refused,
   * stayed in the queue until somebody paired it — and a reinstalled room comes
   * back under a new identity, so one more row. In development, where every fresh
   * `DATA_DIR` produces one, the queue ended up hiding the one request that
   * mattered.
   *
   * @returns Number of requests forgotten, for the log.
   */
  purgeExpired(): number {
    const limit = new Date(Date.now() - this.ttlMs).toISOString()
    // The timestamps are all ISO 8601 UTC: lexicographic order is chronological
    // order, and SQLite has no date type to compare.
    return this.db.delete(deviceRequest).where(lt(deviceRequest.requestedAt, limit)).run().changes
  }

  /** Forgets one specific request — machine refused, or already dealt with. */
  forget(clientId: string): void {
    this.db.delete(deviceRequest).where(eq(deviceRequest.clientId, clientId)).run()
  }

  /**
   * Requests not yet attached to a room.
   *
   * The purge happens here rather than on a timer: it is the only call that looks
   * at the queue, the console polls it every ten seconds, and an expired request
   * nobody consults bothers nobody.
   */
  pending() {
    this.purgeExpired()
    return this.db
      .select({
        clientId: deviceRequest.clientId,
        scope: deviceRequest.scope,
        requestedAt: deviceRequest.requestedAt,
      })
      .from(deviceRequest)
      .leftJoin(roomDevice, eq(roomDevice.clientId, deviceRequest.clientId))
      .where(isNull(roomDevice.clientId))
      .orderBy(asc(deviceRequest.requestedAt))
      .all()
  }

  bind(input: {
    clientId: string
    roomId: string
    label?: string
    approvedByUserId: string
  }): void {
    const values = {
      clientId: input.clientId,
      roomId: input.roomId,
      label: input.label ?? null,
      approvedByUserId: input.approvedByUserId,
      approvedAt: new Date().toISOString(),
      revokedAt: null,
    }
    this.db
      .insert(roomDevice)
      .values(values)
      .onConflictDoUpdate({ target: roomDevice.clientId, set: values })
      .run()
    this.db.delete(deviceRequest).where(eq(deviceRequest.clientId, input.clientId)).run()
  }

  /**
   * Issues a machine token, in exchange for a valid pairing.
   *
   * This is the pivot of the rights model: the Better Auth session proves an
   * operator approved this machine, and stops there. This token carries a room's
   * rights — sync, commands, reporting, lifecycle of *its* talks — and nothing
   * more.
   *
   * The token is returned only once; only its fingerprint is kept.
   */
  issueToken(clientId: string): string | null {
    const roomId = this.roomFor(clientId)
    if (roomId == null) return null

    const token = `rt_${randomBytes(32).toString('base64url')}`
    this.db
      .update(roomDevice)
      .set({ tokenHash: hashToken(token), tokenIssuedAt: new Date().toISOString() })
      .where(eq(roomDevice.clientId, clientId))
      .run()
    return token
  }

  /**
   * Resolves a machine from its token.
   *
   * Comparison on the fingerprint: the clear token exists nowhere on the hub
   * side, so a database leak does not allow a room to be impersonated.
   */
  fromToken(token: string): { clientId: string; roomId: string } | null {
    if (!token.startsWith('rt_')) return null
    const row = this.db
      .select()
      .from(roomDevice)
      .where(and(eq(roomDevice.tokenHash, hashToken(token)), isNull(roomDevice.revokedAt)))
      .get()
    return row == null ? null : { clientId: row.clientId, roomId: row.roomId }
  }

  /** Room served by a machine, or `null` if unknown or revoked. */
  roomFor(clientId: string): string | null {
    const row = this.db
      .select({ roomId: roomDevice.roomId })
      .from(roomDevice)
      .where(and(eq(roomDevice.clientId, clientId), isNull(roomDevice.revokedAt)))
      .get()
    return row?.roomId ?? null
  }

  list() {
    return this.db.select().from(roomDevice).orderBy(asc(roomDevice.approvedAt)).all()
  }

  revoke(clientId: string): void {
    this.db
      .update(roomDevice)
      // The token goes with the revocation: leaving it in the database would make
      // the machine reusable if `revoked_at` were one day cleared by mistake.
      .set({ revokedAt: new Date().toISOString(), tokenHash: null })
      .where(eq(roomDevice.clientId, clientId))
      .run()
  }

  touch(clientId: string): void {
    this.db
      .update(roomDevice)
      .set({ lastSeenAt: new Date().toISOString() })
      .where(eq(roomDevice.clientId, clientId))
      .run()
  }

  isKnownClient(clientId: string): boolean {
    // ULID: a format imposed on the client, filters the noise before writing to
    // the database.
    return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(clientId)
  }
}

/** SHA-256: enough for a random 32-byte secret, with no needless cost. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
