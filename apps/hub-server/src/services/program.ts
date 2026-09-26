import { createHash } from 'node:crypto'
import { asc, desc, eq } from 'drizzle-orm'
import {
  applySharedBreaks,
  normalizeProgram,
  PROGRAM_MODEL_VERSION,
  programSchema,
  type Program,
  type SessionKind,
} from '@conference-operator/program'
import { programSnapshot, sessionFeedback, sessionOverride, sessionSlot } from '@conference-operator/db/hub'
import type { HubDatabase } from '../db.js'

export interface Snapshot {
  contentHash: string
  program: Program
  importedAt: string
  /**
   * Decisions **actually applied**, by slot identifier: the kind served, where it
   * differs from the export's.
   *
   * The program above already carries them — nobody has to replay them. This
   * record only exists for the console, which has to tell a decided kind from an
   * imported one: it is the console that took the decision, and it is there that
   * it gets removed.
   */
  overrides: Record<string, SessionKind>
  /**
   * Swaps **actually applied**: moved talk → export slot it now occupies.
   *
   * Same reason as `overrides`: the program already carries the new places, and
   * this record only tells the console which talks were moved, and from where.
   */
  moves: Record<string, string>
}

/** Fingerprint of the *raw* content: two identical imports create one version. */
export function hashProgramSource(rawText: string): string {
  return createHash('sha256').update(rawText).digest('hex').slice(0, 32)
}

/**
 * The fingerprint served to the rooms: the raw content's, and the model version.
 *
 * The raw content alone would not move when the normalization does — a room
 * whose cache predates `roomSpan` would keep reading every slot as one room wide,
 * and never learn otherwise. See `PROGRAM_MODEL_VERSION`.
 */
export const servedHash = (contentHash: string): string => `${contentHash}.m${PROGRAM_MODEL_VERSION}`

export class ProgramService {
  constructor(private readonly db: HubDatabase) {
    this.renormalize()
  }

  /**
   * Normalizes every stored snapshot again, from the raw export kept beside it.
   *
   * A snapshot normalized by an older version lacks what the model has gained
   * since — the grid width of the shared breaks, for one — and reimporting the
   * same export would not help: an identical content reuses its snapshot as is.
   * Deterministic, so a hub already up to date writes nothing.
   */
  private renormalize(): void {
    const rows = this.db
      .select({ contentHash: programSnapshot.contentHash, rawJson: programSnapshot.rawJson, programJson: programSnapshot.programJson })
      .from(programSnapshot)
      .all()
    for (const row of rows) {
      try {
        const programJson = JSON.stringify(normalizeProgram(JSON.parse(row.rawJson)))
        if (programJson === row.programJson) continue
        this.db.update(programSnapshot).set({ programJson }).where(eq(programSnapshot.contentHash, row.contentHash)).run()
      } catch {
        // An export the current normalizer refuses keeps its old normalization:
        // better an older model than no program at all.
      }
    }
  }

  /**
   * Event name of the active snapshot, or `null` with no imported program.
   *
   * Deliberately bypasses `programSchema.parse`: it is the one read of the
   * program that happens on every page render and every `sync`, and revalidating
   * 70 kB of zod to extract a string would be paid for on the supervision loop.
   * Memoized by `contentHash` — an import changes the hash, so the cache falls by
   * itself.
   */
  activeEventName(): string | null {
    const row = this.db
      .select({
        contentHash: programSnapshot.contentHash,
        programJson: programSnapshot.programJson,
      })
      .from(programSnapshot)
      .where(eq(programSnapshot.active, true))
      .get()
    if (row == null) return null

    if (this.nameCache?.contentHash !== row.contentHash) {
      let name: string | null = null
      try {
        const raw = (JSON.parse(row.programJson) as Program).event?.name
        name = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
      } catch {
        // An unreadable snapshot must not stop the console from opening: that is
        // precisely where we will go and look at what is wrong.
        name = null
      }
      this.nameCache = { contentHash: row.contentHash, name }
    }
    return this.nameCache.name
  }

  private nameCache: { contentHash: string; name: string | null } | null = null

  /**
   * Fetches the upstream export, normalizes it and records it as the active
   * snapshot.
   *
   * The raw JSON is kept next to the normalized model: if the normalizer gains a
   * fix after the import, we replay it without depending on the network again —
   * which matters on the day, when the source may be unreachable.
   */
  async importFrom(sourceUrl: string, fetchImpl: typeof fetch = fetch): Promise<Snapshot> {
    const response = await fetchImpl(sourceUrl)
    if (!response.ok) {
      throw new Error(`Import du programme impossible : HTTP ${response.status} sur ${sourceUrl}`)
    }
    const rawText = await response.text()
    return this.importFromText(rawText, sourceUrl)
  }

  importFromText(rawText: string, sourceUrl: string): Snapshot {
    const contentHash = hashProgramSource(rawText)
    const existing = this.db
      .select()
      .from(programSnapshot)
      .where(eq(programSnapshot.contentHash, contentHash))
      .get()

    if (existing != null) {
      this.activate(contentHash)
      return {
        contentHash: servedHash(contentHash),
        program: programSchema.parse(JSON.parse(existing.programJson)),
        importedAt: existing.importedAt,
        // An import describes the **imported version**, not the served program:
        // the day's decisions are read in `active()`, which applies them.
        overrides: {},
        moves: {},
      }
    }

    const program = normalizeProgram(JSON.parse(rawText))
    const importedAt = new Date().toISOString()

    this.db
      .insert(programSnapshot)
      .values({
        contentHash,
        sourceUrl,
        rawJson: rawText,
        programJson: JSON.stringify(program),
        sessionCount: program.sessions.length,
        issueCount: program.issues.length,
        importedAt,
        active: false,
      })
      .run()
    this.activate(contentHash)

    return { contentHash: servedHash(contentHash), program, importedAt, overrides: {}, moves: {} }
  }

  /**
   * Switches the active snapshot. A failed import rolls back in one call.
   *
   * Takes the snapshot's own fingerprint, as the console lists it, or the one
   * served to the rooms — the model version and the decisions stripped off.
   */
  activate(served: string): void {
    const contentHash = served.replace(/\.m\d+(~.*)?$/, '')
    this.db.transaction((tx) => {
      tx.update(programSnapshot).set({ active: false }).run()
      tx.update(programSnapshot)
        .set({ active: true })
        .where(eq(programSnapshot.contentHash, contentHash))
        .run()
    })
  }

  /**
   * The program as the hub **serves** it, the day's decisions included.
   *
   * A single point of reading, by design: the room, the wall, the console,
   * supervision and the notifications all go through here. Applying the overrides
   * further along — in the room, for instance, which already receives them at
   * `sync` — would let each surface decide on its own, and the console's status
   * dot would say "talk" while the screen said "break".
   *
   * An override that says what the export **already** says is ignored, and does
   * not count in the fingerprint. That is what makes the mechanism safe on a
   * reimport: the day the export finally announces the keynote's speaker, the
   * "this is a talk" decision becomes moot, and the served program becomes exactly
   * the snapshot's again — same bytes, same fingerprint, no re-download in the
   * rooms.
   *
   * Shared breaks are projected **after** the decisions, and for that reason:
   * declaring a slot a "break" here must make it appear in the free rooms at the
   * same moment, and giving it back to "talk" must remove it. The other way round
   * — projecting first — would have frozen the projection on what the export said.
   * None of it is stored: it is a derivative of the served program, recomputed on
   * every read and therefore outside the fingerprint, which its two sources — the
   * snapshot and the decisions — already cover.
   */
  active(): Snapshot | null {
    const row = this.db
      .select()
      .from(programSnapshot)
      .where(eq(programSnapshot.active, true))
      .get()
    if (row == null) return null

    const program = programSchema.parse(JSON.parse(row.programJson))
    const decisions = new Map(
      this.db
        .select()
        .from(sessionOverride)
        .orderBy(asc(sessionOverride.sessionId))
        .all()
        .filter((override) => override.status === 'talk' || override.status === 'break')
        .map((override) => [override.sessionId, override.status as SessionKind]),
    )
    /**
     * The OpenFeedback identifiers corrected by hand.
     *
     * Applied here, in the same place as the kind decisions, and for the same
     * reason: the room draws its QR codes offline from this program, and the
     * console reads its own from the same one. Putting the correction elsewhere
     * would make the same truth live in two places, and it is the address
     * projected in front of the audience that would end up being the wrong one.
     */
    const corrections = new Map(
      this.db
        .select()
        .from(sessionFeedback)
        .orderBy(asc(sessionFeedback.sessionId))
        .all()
        .map((row) => [row.sessionId, row.feedbackId]),
    )

    /**
     * The swapped slots: which export slot each moved talk now occupies.
     *
     * Read against the **export**, never the served program: a talk takes its
     * donor's slot as the export gives it, so two chained swaps compose instead of
     * compounding. A row whose talk or donor the export no longer holds — a
     * reimport took it away — is ignored: the talk stays where the export puts it,
     * rather than going nowhere.
     */
    const exported = new Map(program.sessions.map((session) => [session.id, session]))
    const moves = new Map(
      this.db
        .select()
        .from(sessionSlot)
        .orderBy(asc(sessionSlot.sessionId))
        .all()
        .filter((move) => move.slotOf !== move.sessionId)
        .filter((move) => exported.has(move.sessionId) && exported.has(move.slotOf))
        .map((move) => [move.sessionId, move.slotOf]),
    )

    if (decisions.size === 0 && corrections.size === 0 && moves.size === 0) {
      return {
        contentHash: servedHash(row.contentHash),
        program: applySharedBreaks(program),
        importedAt: row.importedAt,
        overrides: {},
        moves: {},
      }
    }

    const appliedKinds: Record<string, SessionKind> = {}
    /** What really contradicts the export: the rest does not count. */
    const appliedIds: Record<string, string> = {}
    const appliedSlots: Record<string, string> = {}
    const sessions = program.sessions.map((exportedSession) => {
      const donor = exported.get(moves.get(exportedSession.id) ?? '')
      let session = exportedSession
      if (donor != null) {
        appliedSlots[session.id] = donor.id
        session = {
          ...session,
          roomId: donor.roomId,
          roomSpan: donor.roomSpan,
          startsAt: donor.startsAt,
          endsAt: donor.endsAt,
          startsAtMs: donor.startsAtMs,
          endsAtMs: donor.endsAtMs,
          durationMinutes: donor.durationMinutes,
        }
      }
      const wanted = decisions.get(session.id)
      const corrected = corrections.get(session.id)
      // A correction that repeats the export's identifier is moot, exactly like a
      // decision that repeats its kind: the served program must stay byte for
      // byte the snapshot's, otherwise the rooms re-download for nothing.
      const identifier = corrected == null || corrected === session.id ? null : corrected
      const kind = wanted == null || wanted === session.kind ? null : wanted
      if (kind == null && identifier == null) return session
      if (kind != null) appliedKinds[session.id] = kind
      if (identifier != null) appliedIds[session.id] = identifier
      return {
        ...session,
        ...(kind == null ? {} : { kind }),
        ...(identifier == null ? {} : { feedbackId: identifier }),
      }
    })

    if (
      Object.keys(appliedKinds).length === 0 &&
      Object.keys(appliedIds).length === 0 &&
      Object.keys(appliedSlots).length === 0
    ) {
      return {
        contentHash: servedHash(row.contentHash),
        program: applySharedBreaks(program),
        importedAt: row.importedAt,
        overrides: {},
        moves: {},
      }
    }

    /**
     * Sorted again, the way the normalizer does: a swapped talk has changed hours,
     * and everything downstream — the room's current slot, the effective end
     * taken from the next one — reads the list in order. And only then the shared
     * breaks, so that a room freed by a swap inherits the break next door.
     */
    const served = Object.keys(appliedSlots).length === 0
      ? sessions
      : [...sessions].sort((a, b) => a.startsAtMs - b.startsAtMs || a.id.localeCompare(b.id))

    return {
      /**
       * A fingerprint that moves with the decisions.
       *
       * The rooms only re-download the program if the fingerprint changed.
       * Keeping the snapshot's would leave a room on its cache, titling on air a
       * lunch break we have just declared as such — and with nothing to flag it.
       * The corrected identifiers enter it on the same footing: a correction the
       * rooms would not re-download would leave the projected QR code on the old
       * address, the very one we have just declared wrong. A swap too: a room
       * left on its cache would title the talk that is no longer there.
       */
      contentHash: `${servedHash(row.contentHash)}~${fingerprintOf(appliedKinds, appliedIds, appliedSlots)}`,
      program: applySharedBreaks({ ...program, sessions: served }),
      importedAt: row.importedAt,
      overrides: appliedKinds,
      moves: appliedSlots,
    }
  }

  list() {
    return this.db
      .select({
        contentHash: programSnapshot.contentHash,
        importedAt: programSnapshot.importedAt,
        active: programSnapshot.active,
        sessionCount: programSnapshot.sessionCount,
        issueCount: programSnapshot.issueCount,
      })
      .from(programSnapshot)
      .orderBy(desc(programSnapshot.importedAt))
      .all()
  }
}

/**
 * Short fingerprint of a set of overrides, to derive the served program's. Sorted:
 * two identical sets applied in a different order must give the same fingerprint,
 * otherwise the rooms would re-download on a change that is not one.
 */
function fingerprintOf(
  appliedKinds: Record<string, SessionKind>,
  appliedIds: Record<string, string> = {},
  appliedSlots: Record<string, string> = {},
): string {
  const sorted = (entries: Record<string, string>, prefix: string) =>
    Object.entries(entries)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([sessionId, value]) => `${prefix}${sessionId}:${value}`)
  /*
   * Every family is prefixed.
   *
   * With no prefix, a decision and a correction carrying the same (slot, value)
   * pair would give the same string — unlikely, but a fingerprint that confuses
   * two different states is a bug you would only discover in the room, on a cache
   * that refuses to refresh.
   */
  const joined = [
    ...sorted(appliedKinds, 'k:'),
    ...sorted(appliedIds, 'f:'),
    ...sorted(appliedSlots, 's:'),
  ].join(',')
  return createHash('sha256').update(joined).digest('hex').slice(0, 8)
}
