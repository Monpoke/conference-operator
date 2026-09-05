import { and, eq, isNull, or } from 'drizzle-orm'
import {
  hubSettingsSchema,
  sessionStateSchema,
  sessionStateViewSchema,
  type HubSettings,
  type HubSettingsInput,
  type SessionState,
  type SessionStateView,
  type SessionStatus,
} from '@conference-operator/contract'
import {
  isDecisionApplicable,
  shouldAutoEnd,
  effectiveEndInProgram,
  transitionRefusal,
  statusAfter,
  type SessionAction,
} from '@conference-operator/room-state'
import { hubSetting, sessionState } from '@conference-operator/db/hub'
import type { Program } from '@conference-operator/program'
import type { HubDatabase } from '../db.js'

const SETTINGS_KEY = 'hub'

/**
 * The hub's settings.
 *
 * Read on every use rather than cached: they get changed during the event, and a
 * value ten seconds out of date on an automatic-closing rule would be confusing
 * for whoever has just changed it.
 */
export class SettingsService {
  constructor(private readonly db: HubDatabase) {}

  get(): HubSettings {
    const row = this.db.select().from(hubSetting).where(eq(hubSetting.key, SETTINGS_KEY)).get()
    if (row == null) return hubSettingsSchema.parse({})
    const parsed = hubSettingsSchema.safeParse(JSON.parse(row.valueJson))
    // Corrupted settings: we fall back on the defaults rather than fail
    // everything that depends on them.
    return parsed.success ? parsed.data : hubSettingsSchema.parse({})
  }

  update(patch: Partial<HubSettingsInput>): HubSettings {
    const current = this.get()
    /**
     * The VOD policy merges field by field, not as a block.
     *
     * Everywhere else, "the value sent is the value": `socialLinks` is a list, and
     * sending only one element really does mean only one is left. A policy, no —
     * it is a settings panel, and a form only sends what it carries. Merged flat,
     * it went back through its default values: correcting the throughput ceiling
     * during the event set `actif` back to false and the part size back to eight
     * megabytes along the way, with nothing to say so. A setting that undoes
     * itself is worse than a missing setting.
     */
    const vodPolitique =
      patch.vodPolitique == null
        ? current.vodPolitique
        : { ...current.vodPolitique, ...patch.vodPolitique }

    const next = hubSettingsSchema.parse({ ...current, ...patch, vodPolitique })
    const values = {
      key: SETTINGS_KEY,
      valueJson: JSON.stringify(next),
      updatedAt: new Date().toISOString(),
    }
    this.db
      .insert(hubSetting)
      .values(values)
      .onConflictDoUpdate({ target: hubSetting.key, set: values })
      .run()
    return next
  }
}

/**
 * A gesture refused by the lifecycle.
 *
 * A domain error, and not an `ORPCError`: the service is tested and called
 * without going through the transport, and it is the router that knows which
 * HTTP code to tell whom. The message, on the other hand, is already one an
 * operator can read — it comes from the table shared with the control app.
 */
export class TransitionRefused extends Error {
  constructor(
    readonly from: SessionStatus,
    readonly action: SessionAction,
    message: string,
  ) {
    super(message)
    this.name = 'TransitionRefused'
  }
}

export interface SweepResult {
  /** Sessions closed by the scheduling rule during this pass. */
  ended: SessionState[]
}

/**
 * Talk lifecycle.
 *
 * Two paths lead to the same state: an operator's decision, or the scheduling
 * rule. The second exists because nobody thinks of pressing "End" when a talk
 * overruns and the room is applauding.
 */
export class SessionStateService {
  constructor(
    private readonly db: HubDatabase,
    private readonly settings: SettingsService,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * States enriched with the program.
   *
   * The title and the scheduled times are resolved here: the console does not
   * hold the program, and an opaque identifier cannot be read.
   *
   * The remaining time too, and for a stronger reason: computing it in the
   * browser meant subtracting it from the machine's time, whereas the
   * authoritative time is the hub's — which may be simulated. So the console
   * showed "+6010 min" on a perfectly on-time talk as soon as the clock was moved
   * from the Development menu.
   */
  views(roomId: string | null, program: Program | null): SessionStateView[] {
    const byId = new Map((program?.sessions ?? []).map((session) => [session.id, session]))
    const roomNames = new Map((program?.rooms ?? []).map((room) => [room.id, room.name]))
    const now = this.now()

    return this.states(roomId).map((state) => {
      const session = byId.get(state.sessionId)
      return sessionStateViewSchema.parse({
        ...state,
        title: session?.title ?? null,
        roomName: state.roomId == null ? null : (roomNames.get(state.roomId) ?? state.roomId),
        scheduledStartsAt: session?.startsAt ?? null,
        scheduledEndsAt: session?.endsAt ?? null,
        // `null` on a slot with an unknown end, which we do not want to show as
        // "0 min".
        remainingMs: session?.endsAtMs == null ? null : session.endsAtMs - now,
      })
    })
  }

  states(roomId: string | null): SessionState[] {
    return this.db
      .select()
      .from(sessionState)
      .where(
        roomId == null
          ? undefined
          : or(eq(sessionState.roomId, roomId), isNull(sessionState.roomId)),
      )
      .all()
      .map(toState)
      .filter((state) => this.applicable(state))
  }

  get(sessionId: string): SessionState | null {
    const row = this.db
      .select()
      .from(sessionState)
      .where(eq(sessionState.sessionId, sessionId))
      .get()
    if (row == null) return null
    const state = toState(row)
    return this.applicable(state) ? state : null
  }

  /**
   * A decision taken *after* the hub's instant does not apply.
   *
   * It belongs to a day that has not happened yet — which only occurs in
   * development, when the clock is wound back from the console. The 09:50 talk
   * launched during an 11:00 rehearsal stayed "running" when going back to 08:38:
   * the control app showed "running" and two hours of countdown on a talk nobody
   * had started.
   *
   * We filter on read rather than delete the row: winding the clock forward again
   * must find the day exactly where it was left. Under a real clock nothing
   * changes — no decision is dated in the future.
   *
   * An unreadable date stays applicable: a state we cannot place in time is a
   * data problem, not a reason to make it disappear.
   */
  private applicable(state: SessionState): boolean {
    const decided = state.status === 'ended' ? state.endedAt : state.startedAt
    return isDecisionApplicable(decided == null ? null : Date.parse(decided), this.now())
  }

  start(sessionId: string, roomId: string | null, decidedBy: string): SessionState {
    return this.write(sessionId, roomId, 'start', decidedBy)
  }

  end(sessionId: string, roomId: string | null, decidedBy: string): SessionState {
    return this.write(sessionId, roomId, 'end', decidedBy)
  }

  /** Brings a talk back to "upcoming" — to correct a slip. */
  reset(sessionId: string): void {
    this.db.delete(sessionState).where(eq(sessionState.sessionId, sessionId)).run()
  }

  /**
   * Applies a gesture, if the lifecycle allows it from the observed state.
   *
   * The service takes an **action** and not a status: it is the shared table that
   * says what the action produces, and it is the one that refuses. Without that
   * mandatory step, the control app greyed out "End" on a talk that had not been
   * launched while this procedure accepted it — we wrote `ended` on a talk that
   * had not happened, and the history lied without anything breaking.
   */
  private write(
    sessionId: string,
    roomId: string | null,
    action: SessionAction,
    decidedBy: string,
  ): SessionState {
    const now = new Date(this.now()).toISOString()
    const existing = this.get(sessionId)
    const from = existing?.status ?? 'scheduled'

    const status = statusAfter(from, action)
    if (status == null) {
      throw new TransitionRefused(from, action, transitionRefusal(from, action) ?? 'Geste refusé')
    }

    const values = {
      sessionId,
      roomId,
      status,
      // We keep the real start time: rewriting it at closing time would lose the
      // talk's effective duration.
      startedAt: status === 'running' ? now : (existing?.startedAt ?? null),
      endedAt: status === 'ended' ? now : null,
      decidedBy,
      updatedAt: now,
    }

    this.db
      .insert(sessionState)
      .values(values)
      .onConflictDoUpdate({ target: sessionState.sessionId, set: values })
      .run()

    return sessionStateSchema.parse(values)
  }

  /**
   * Closes the talks whose slot is over.
   *
   * Only acts on what is explicitly **running**: a session never started stays
   * "upcoming" rather than being declared ended. Claiming a talk took place when
   * nobody launched it would be a lie in the history, and would skew the VOD.
   */
  sweep(program: Program | null): SweepResult {
    const settings = this.settings.get()
    if (!settings.autoEndEnabled || program == null) return { ended: [] }

    const setting = { enabled: true, graceMinutes: settings.autoEndGraceMinutes }
    const now = this.now()
    const ended: SessionState[] = []

    for (const state of this.states(null)) {
      /**
       * The rule lives in `@conference-operator/room-state`, and the end it reads is the
       * overrun's: explicit time, else duration, else start of the next slot. The
       * two rules used to speak of different times, and a room could stay in
       * overrun all day without this sweep ever seeing it.
       */
      const end = effectiveEndInProgram(program, state.sessionId)
      if (!shouldAutoEnd(end, state.status, now, setting)) continue
      ended.push(this.end(state.sessionId, state.roomId, 'auto'))
    }
    return { ended }
  }
}

function toState(row: typeof sessionState.$inferSelect): SessionState {
  return sessionStateSchema.parse({
    sessionId: row.sessionId,
    roomId: row.roomId,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    decidedBy: row.decidedBy,
  })
}
