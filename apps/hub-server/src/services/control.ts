import { eq } from 'drizzle-orm'
import {
  CONTROL_LOCK_TTL_MS,
  CONTROL_COMMAND_TTL,
  controlLockSchema,
  controlViewSchema,
  type CommandPayloadInput,
  type ControlCommand,
  type ControlLock,
  type ControlRoom,
  type ControlView,
  type SceneRole,
} from '@cloudnord/contract'
import {
  talkToControl,
  stateOfSlots,
  type SessionStatuses,
} from '@cloudnord/room-state'
import { DEFAULT_TIMEZONE, sessionsForRoom } from '@cloudnord/program'
import { regieLock } from '@cloudnord/db/hub'
import type { HubDatabase } from '../db.js'
import type { Services } from '../context.js'

/**
 * The mobile control lock, and the view it shows.
 *
 * Two things in one service because they are read in the same call: `view()` is
 * at once "where the room stands" and "I am still holding the room". A separate
 * heartbeat would be a second gesture you could forget to stop — and a lock that
 * outlives the page holding it.
 *
 * What the lock **does not** do: anything in the room. The operator in front of
 * the machine keeps every command, whatever happens to a phone that has wandered
 * off down a corridor. The lock only excludes mobile control apps from each
 * other.
 */

/** Refusal of a gesture, to be turned into `CONFLICT` by the router. */
export class LockHeld extends Error {
  constructor(readonly lock: ControlLock) {
    super(`${lock.holder} tient la régie de cette salle`)
    this.name = 'LockHeld'
  }
}

/** The targeted room does not exist. The router turns it into a `NOT_FOUND`. */
export class UnknownRoom extends Error {
  constructor(readonly roomId: string) {
    super(`Salle inconnue : ${roomId}`)
    this.name = 'UnknownRoom'
  }
}

export class ControlService {
  constructor(
    private readonly db: HubDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A room's live lock, or `null`.
   *
   * Expiry is computed here and nowhere else: the row can outlive its deadline
   * without that meaning anything. A sweep takes care of removing it and of
   * switching the badge off in the room, but it is not what is authoritative —
   * otherwise a dead lock would stay enforceable for the fifteen seconds
   * separating it from the next pass.
   */
  lock(roomId: string): ControlLock | null {
    const row = this.db.select().from(regieLock).where(eq(regieLock.roomId, roomId)).get()
    if (row == null) return null
    const expiresAtMs = Date.parse(row.lastSeenAt) + CONTROL_LOCK_TTL_MS
    if (expiresAtMs <= this.now()) return null
    return controlLockSchema.parse({
      roomId: row.roomId,
      holder: row.holder,
      holderId: row.holderId,
      heldSince: row.heldSince,
      lastSeenAt: row.lastSeenAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
    })
  }

  /**
   * Takes the room, or renews a hold.
   *
   * **It is the session that decides, not the account.** Two tabs of the same
   * person — the phone in a pocket, the tablet on the table — would otherwise
   * drive the same room each believing it was alone, which is exactly the
   * situation this lock exists to remove.
   *
   * Renewal **keeps `heldSince`**: it is since when that tab has held the room,
   * and it is what the other operator reads before deciding whether to take over.
   * Rewriting it on every heartbeat would show "for 1 second" all day long, which
   * answers nothing.
   *
   * A takeover, on the other hand, resets it: it is another hold.
   */
  hold(roomId: string, holder: string, holderId: string, force: boolean): ControlLock {
    const current = this.lock(roomId)
    if (current != null && current.holderId !== holderId && !force) throw new LockHeld(current)

    const now = new Date(this.now()).toISOString()
    const heldSince = current?.holderId === holderId ? current.heldSince : now
    const values = { roomId, holder, holderId, heldSince, lastSeenAt: now }
    this.db
      .insert(regieLock)
      .values(values)
      .onConflictDoUpdate({ target: regieLock.roomId, set: values })
      .run()

    return controlLockSchema.parse({
      ...values,
      expiresAt: new Date(this.now() + CONTROL_LOCK_TTL_MS).toISOString(),
    })
  }

  /**
   * Releases the room. No effect if the caller was not holding it.
   *
   * On the **session** again: a tab that closes must not release the room the
   * same person's other tab is driving.
   *
   * True only when something was actually released: that is what decides whether
   * a holder change must be broadcast to the room. Releasing a room you were not
   * holding must switch off nobody's badge.
   */
  release(roomId: string, holderId: string): boolean {
    const current = this.lock(roomId)
    if (current == null || current.holderId !== holderId) return false
    this.db.delete(regieLock).where(eq(regieLock.roomId, roomId)).run()
    return true
  }

  /**
   * Removes the expired locks and says which.
   *
   * Called by the supervision watch, whose rhythm this already is. The caller
   * broadcasts a `regie.hold {holder: null}` per released room: without that the
   * "driven remotely" badge would stay on in the room over a lock nobody holds
   * any more — and that is the kind of mention you end up not reading.
   */
  sweep(): string[] {
    const limit = this.now() - CONTROL_LOCK_TTL_MS
    const expired = this.db
      .select()
      .from(regieLock)
      .all()
      .filter((row) => Date.parse(row.lastSeenAt) <= limit)
      .map((row) => row.roomId)

    for (const roomId of expired) {
      this.db.delete(regieLock).where(eq(regieLock.roomId, roomId)).run()
    }
    return expired
  }
}

/**
 * The rooms and their locks, for the picker screen.
 *
 * Reuses `statuses()` rather than reading the rooms again: it is the same
 * connectivity and the same talk state the console paints, and two divergent
 * readings of the same room are exactly what this repository avoids everywhere
 * else.
 */
export function controlRooms(services: Services, at: number): ControlRoom[] {
  const snapshot = services.programs.active()
  return services.rooms.statuses().map((status) => ({
    roomId: status.roomId,
    name: status.name,
    conference:
      snapshot == null
        ? ('aucune' as const)
        : stateOfSlots(
            sessionsForRoom(snapshot.program, status.roomId),
            at,
            roomSessionStatuses(services, status.roomId),
          ),
    connectivity: status.connectivity,
    lock: services.regie.lock(status.roomId),
  }))
}

/**
 * Everything a mobile control app shows of a room.
 *
 * Recomposed on every call from what already exists — active program, lifecycle,
 * room configuration, last heartbeat. Nothing is stored in this shape, and that
 * is deliberate: a persisted snapshot would be a second version of the truth,
 * which would end up contradicting the console.
 *
 * **Everything that depends on time is computed here.** The hub's clock is
 * authoritative and may be simulated; in development the gap is measured in
 * weeks, and the browser only has its own.
 */
export function controlView(services: Services, roomId: string, at: number): ControlView {
  const room = services.rooms.get(roomId)
  if (room == null) throw new UnknownRoom(roomId)

  const status = services.rooms.statuses().find((row) => row.roomId === roomId)
  const snapshot = services.programs.active()
  const slots = snapshot == null ? [] : sessionsForRoom(snapshot.program, roomId)
  const statuses = roomSessionStatuses(services, roomId)
  const target = talkToControl(slots, at, statuses)

  return controlViewSchema.parse({
    roomId,
    roomName: room.name,
    event: services.identity.get(),
    timezone: snapshot?.program.timezone ?? DEFAULT_TIMEZONE,
    serverTime: new Date(at).toISOString(),
    simulatedClock: services.clock.simulated,

    connectivity: status?.connectivity ?? 'OFFLINE',
    lastSeenAt: status?.lastSeenAt ?? null,

    conference: stateOfSlots(slots, at, statuses),
    targetSession: target,
    /*
     * "Upcoming" is read from the schedule, exactly as in the room's control app.
     * Comparing with the current session announced as "upcoming" a talk in full
     * overrun — the precise moment it is on air.
     */
    targetIsUpcoming: target != null && target.startsAtMs > at,
    sessionStates: statuses,
    sessions: slots,

    sceneRole: status?.sceneRole ?? null,
    recording: status?.recording ?? false,
    streaming: status?.streaming ?? false,
    /*
     * `null` as long as the room has not said, and not "Loop" by default: the
     * screen grid would light a button on a guess, in a page whose whole rule is
     * that an active button describes a fact.
     */
    displayMode: status?.displayMode ?? null,

    /*
     * The mapped roles, not the full list of possible roles.
     *
     * A "Relay" button on a room that has none would show something nobody can
     * name, and would fail on the switch. The room's control app reads the same
     * thing from its configuration.
     */
    sceneRoles: Object.entries(room.sceneRoles.A)
      .filter(([, name]) => name != null && name !== '')
      .map(([role]) => role as SceneRole),
    relaySourceRoomId: room.relaySourceRoomId,
    promptRecordingOnStart: room.promptRecordingOnStart,
    promptRecordingOnStop: room.promptRecordingOnStop,
    sceneOnStart: room.sceneOnStart,

    lock: services.regie.lock(roomId),
  })
}

/**
 * The gesture itself, once the router has checked the lock.
 *
 * Two kinds, and `applied` separates them: the lifecycle is written on the hub —
 * settled on return —, a scene or a recording leaves on the downstream flow and
 * is only observed on the next view. Confusing them would make the mobile
 * control app believe a recording is running because a call answered 200, which
 * would empty the "Start" warning of its meaning.
 */
export function controlCommand(
  services: Services,
  roomId: string,
  action: ControlCommand,
  author: string,
): { applied: 'now' | 'queued' } {
  switch (action.type) {
    case 'session.start':
      services.sessions.start(action.sessionId, roomId, author)
      return { applied: 'now' }
    case 'session.end':
      services.sessions.end(action.sessionId, roomId, author)
      return { applied: 'now' }
    case 'session.reset':
      services.sessions.reset(action.sessionId)
      return { applied: 'now' }
    case 'scene.set':
      publish(services, roomId, { type: 'scene.force', role: action.role, requestedBy: author })
      return { applied: 'queued' }
    case 'display.set':
      /*
       * With no `sessionId`: remotely you choose a mode, not the talk to put in
       * it. The room applies the mode to whatever it is already driving, which is
       * also what its own control app does.
       */
      publish(services, roomId, { type: 'display.set', mode: action.mode })
      return { applied: 'queued' }
    case 'recording.set':
      publish(services, roomId, { type: 'recording.set', on: action.on, requestedBy: author })
      return { applied: 'queued' }
    case 'stream.set':
      publish(services, roomId, { type: 'stream.set', on: action.on, requestedBy: author })
      return { applied: 'queued' }
  }
}

/**
 * Publishes with the gesture's validity window.
 *
 * The windows live in the contract because both sides read them, and they are not
 * equal: a scene switch caught up ten minutes later puts the room on air over
 * nothing, where a capture can still recover from a one-minute outage.
 */
function publish(
  services: Services,
  roomId: string,
  payload: Extract<
    CommandPayloadInput,
    { type: 'scene.force' | 'display.set' | 'recording.set' | 'stream.set' }
  >,
): void {
  services.commands.publish(roomId, payload, CONTROL_COMMAND_TTL[payload.type])
}

function roomSessionStatuses(services: Services, roomId: string): SessionStatuses {
  return Object.fromEntries(
    services.sessions.states(roomId).map((state) => [state.sessionId, state.status]),
  )
}
