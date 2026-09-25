import { createHash } from 'node:crypto'
import { EventEmitter, on } from 'node:events'
import { and, asc, desc, eq, gt, isNull, notInArray, or, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  commentSchema,
  hubPostInputSchema,
  imageRefSchema,
  isoDateTimeSchema,
  questionSchema,
  type Comment,
  type CommentSource,
  type HubPostInput,
  type Question,
  type WallSnapshot,
} from '@conference-operator/contract'
import { comment, question, questionVote } from '@conference-operator/db/hub'
import type { HubDatabase } from '../db.js'

const CHANNEL = 'wall'
const SCREEN_CHANGED = 'screen'

/**
 * The sources whose posts arrive approved.
 *
 * walls.io moderates upstream — that is what it is paid for, and a second queue
 * here would mean moderating the same post twice. The hub keeps the last word:
 * it can still hide one.
 */
const TRUSTED_SOURCES: ReadonlySet<CommentSource> = new Set(['wallsio'])

/**
 * The sources the audience writes from, shown by the operator's wall mode.
 *
 * walls.io and the partners' posts are the social wall's, in the loop: the full
 * screen wall stays the room talking to the room.
 */
const LOOP_ONLY_SOURCES: CommentSource[] = ['wallsio', 'hub']

/** The social wall's bounds: every featured post up to a point, then the latest. */
const SCREEN_FEATURED_MAX = 20
const SCREEN_LATEST_MAX = 60

export interface PostInput {
  source: CommentSource
  author: string
  text: string
  roomId?: string | null
  sessionId?: string | null
  /** The post's identifier at the source, to deduplicate redeliveries. */
  externalId?: string | null
  authorHandle?: string | null
  authorSubtitle?: string | null
  avatar?: string | null
  image?: string | null
  permalink?: string | null
  network?: string | null
  postedAt?: string | null
  /** What the source says of it now — read for the trusted sources only. */
  active?: boolean
  pinned?: boolean
}

/**
 * What posting did: a new message, one already held, one its source changed
 * (text, image, pin), deactivated or brought back.
 */
export type PostOutcome = 'created' | 'known' | 'updated' | 'deactivated' | 'reactivated'

/**
 * Comment wall and moderation.
 *
 * Every source — form, Bluesky, Mastodon, X — converges on the same `pending`
 * queue. Nothing reaches a room screen without going through a human decision:
 * it is projected in front of the audience. walls.io is the exception, because
 * that human decision is taken there (`TRUSTED_SOURCES`).
 *
 * Two views come out of it. The audience's wall — the operator's full screen
 * mode and the phones — flows message by message (`stream`). The social wall of
 * the loop is a snapshot with a revision (`screen`): it loses posts as well as
 * gains them, and a room only needs the latest state.
 */
export class WallService {
  private readonly emitter = new EventEmitter()
  /**
   * In-memory snapshot of the approved messages.
   *
   * The public wall is the hub's only unbounded load (a few hundred phones when
   * the QR code is on screen). So we do not serve it with a SQL query: we
   * recompute on write, and read from memory.
   */
  private approvedSnapshot: Comment[] = []
  /** The social wall as the rooms fetch it — from memory, for the same reason. */
  private screenSnapshot: WallSnapshot = { revision: '', posts: [] }

  constructor(
    private readonly db: HubDatabase,
    private readonly snapshotSize = 50,
  ) {
    this.emitter.setMaxListeners(256)
    this.refreshSnapshot()
    this.screenSnapshot = this.computeScreen()
  }

  /**
   * Posts a message. Always as `pending`.
   *
   * Returns the existing message if the source has already delivered it: a
   * firehose can redeliver, and polling always overlaps the previous window.
   */
  post(input: PostInput): Comment {
    return this.ingest(input).comment
  }

  /**
   * `post`, saying what it did — what the ingestor logs: a poll that brought
   * three new posts and hid one reads differently from one that re-read the
   * same fifty.
   */
  ingest(input: PostInput): { comment: Comment; outcome: PostOutcome } {
    const trusted = TRUSTED_SOURCES.has(input.source)
    if (input.externalId != null) {
      const existing = this.db
        .select()
        .from(comment)
        .where(and(eq(comment.source, input.source), eq(comment.externalId, input.externalId)))
        .get()
      if (existing != null) {
        if (!trusted) return { comment: toComment(existing), outcome: 'known' }
        return this.refreshFromSource(existing, input)
      }
    }

    const row = this.db
      .insert(comment)
      .values({
        id: ulid(),
        source: input.source,
        author: input.author.trim().slice(0, 80),
        authorHandle: input.authorHandle ?? null,
        externalId: input.externalId ?? null,
        text: input.text.trim().slice(0, trusted ? 1500 : 500),
        status: trusted ? 'approved' : 'pending',
        roomId: input.roomId ?? null,
        sessionId: input.sessionId ?? null,
        ...(trusted
          ? { moderatedAt: new Date().toISOString(), moderatedBy: input.source, ...sourceFields(input) }
          : {}),
      })
      .returning()
      .get()

    return { comment: toComment(row), outcome: 'created' }
  }

  /**
   * What a trusted source says of a post it already gave: its text, its image,
   * whether it is still active or pinned there. Never `status` — the hub's
   * decision, which a later answer from walls.io must not undo.
   *
   * Does not publish: the ingestor publishes once per poll, after the images are
   * in (`publishScreen`).
   */
  private refreshFromSource(
    existing: typeof comment.$inferSelect,
    input: PostInput,
  ): { comment: Comment; outcome: PostOutcome } {
    const next = sourceFields(input)
    const text = input.text.trim().slice(0, 1500)
    const unchanged =
      existing.text === text &&
      existing.image === next.image &&
      existing.avatar === next.avatar &&
      existing.sourceActive === next.sourceActive &&
      existing.sourcePinned === next.sourcePinned
    if (unchanged) return { comment: toComment(existing), outcome: 'known' }
    const row = this.db
      .update(comment)
      .set({ ...next, text, updatedAt: new Date().toISOString() })
      .where(eq(comment.seq, existing.seq))
      .returning()
      .get()
    const outcome: PostOutcome =
      existing.sourceActive && !next.sourceActive
        ? 'deactivated'
        : !existing.sourceActive && next.sourceActive
          ? 'reactivated'
          : 'updated'
    return { comment: toComment(row!), outcome }
  }

  /**
   * Writes a post from the console, approved: a partner's, or one of the event.
   *
   * An `id` edits one written here before; any other post keeps its text — the
   * console puts it forward or hides it, it does not rewrite what someone said.
   */
  saveHubPost(raw: HubPostInput, by: string, externalId: string | null = null): Comment | null {
    const input = hubPostInputSchema.parse(raw)
    const values = {
      author: input.author,
      authorSubtitle: input.authorSubtitle || null,
      avatar: input.avatar,
      text: input.text,
      image: input.image,
      network: input.network || null,
      permalink: input.permalink,
      featured: input.featured,
      sponsorName: input.sponsor?.name ?? null,
      sponsorLogo: input.sponsor?.logo ?? null,
      updatedAt: new Date().toISOString(),
    }
    let row: typeof comment.$inferSelect | undefined
    if (input.id != null) {
      row = this.db
        .update(comment)
        .set(values)
        .where(and(eq(comment.id, input.id), eq(comment.source, 'hub')))
        .returning()
        .get()
      if (row == null) return null
    } else {
      if (externalId != null) {
        const existing = this.db
          .select()
          .from(comment)
          .where(and(eq(comment.source, 'hub'), eq(comment.externalId, externalId)))
          .get()
        if (existing != null) return toComment(existing)
      }
      row = this.db
        .insert(comment)
        .values({
          ...values,
          id: ulid(),
          source: 'hub',
          externalId,
          status: 'approved',
          moderatedAt: values.updatedAt,
          moderatedBy: by,
        })
        .returning()
        .get()
    }
    this.publishScreen()
    return toComment(row!)
  }

  /** Puts a post forward, or back in line. A walls.io pin keeps it forward regardless. */
  setFeatured(id: string, featured: boolean): Comment | null {
    const row = this.db
      .update(comment)
      .set({ featured, updatedAt: new Date().toISOString() })
      .where(eq(comment.id, id))
      .returning()
      .get()
    if (row == null) return null
    this.publishScreen()
    return toComment(row)
  }

  /** The social wall as the rooms fetch it: from memory. */
  screen(): WallSnapshot {
    return this.screenSnapshot
  }

  /** What the social wall will be at the next `publishScreen` — to fetch its images first. */
  nextScreen(): WallSnapshot {
    return this.computeScreen()
  }

  /** Posts from walls.io currently on the wall — the console's count. */
  countOnScreen(source: CommentSource): number {
    return this.screenSnapshot.posts.filter((post) => post.source === source).length
  }

  /**
   * Recomputes the social wall, and tells the listeners when its revision moved.
   *
   * Called by every gesture that changes it, and by the ingestor once per poll —
   * after the images are downloaded, so that a room told about a post can fetch
   * its photo straight away.
   */
  publishScreen(): WallSnapshot {
    const next = this.computeScreen()
    const moved = next.revision !== this.screenSnapshot.revision
    this.screenSnapshot = next
    if (moved) this.emitter.emit(SCREEN_CHANGED, next)
    return next
  }

  /** Called with each new revision of the social wall. Returns the unsubscribe. */
  onScreenChanged(listener: (snapshot: WallSnapshot) => void): () => void {
    this.emitter.on(SCREEN_CHANGED, listener)
    return () => this.emitter.off(SCREEN_CHANGED, listener)
  }

  private computeScreen(): WallSnapshot {
    const onScreen = and(eq(comment.status, 'approved'), eq(comment.sourceActive, true))
    const isFeatured = or(
      eq(comment.featured, true),
      eq(comment.sourcePinned, true),
      sql`${comment.sponsorName} is not null`,
    )
    const featured = this.db
      .select()
      .from(comment)
      .where(and(onScreen, isFeatured))
      .orderBy(desc(comment.seq))
      .limit(SCREEN_FEATURED_MAX)
      .all()
    const latest = this.db
      .select()
      .from(comment)
      .where(
        and(
          onScreen,
          featured.length > 0 ? notInArray(comment.seq, featured.map((row) => row.seq)) : undefined,
        ),
      )
      .orderBy(desc(comment.seq))
      .limit(SCREEN_LATEST_MAX)
      .all()
    const posts = [...featured, ...latest].map(toComment)
    const revision = createHash('sha256')
      .update(
        [...featured, ...latest]
          .map((row) => `${row.id}:${row.updatedAt ?? row.createdAt}:${row.featured ? 1 : 0}`)
          .join('|'),
      )
      .digest('hex')
      .slice(0, 16)
    return { revision, posts }
  }

  pending(source?: CommentSource): Comment[] {
    const rows = this.db
      .select()
      .from(comment)
      .where(
        source == null
          ? eq(comment.status, 'pending')
          : and(eq(comment.status, 'pending'), eq(comment.source, source)),
      )
      .orderBy(asc(comment.seq))
      .limit(200)
      .all()
    return rows.map(toComment)
  }

  /**
   * Approves or rejects. An approved message leaves for the screens immediately;
   * a rejected one leaves them — a post already on the social wall included.
   */
  moderate(id: string, decision: 'approve' | 'reject', moderatedBy: string): Comment | null {
    const row = this.db
      .update(comment)
      .set({
        status: decision === 'approve' ? 'approved' : 'rejected',
        moderatedAt: new Date().toISOString(),
        moderatedBy,
      })
      .where(eq(comment.id, id))
      .returning()
      .get()

    if (row == null) return null
    const approved = toComment(row)
    this.refreshSnapshot()
    if (decision === 'approve' && !LOOP_ONLY_SOURCES.includes(approved.source)) {
      this.emitter.emit(CHANNEL, { seq: row.seq, comment: approved })
    }
    this.publishScreen()
    return approved
  }

  /** Latest approved messages, served from memory. */
  approved(roomId?: string | null): Comment[] {
    if (roomId == null) return [...this.approvedSnapshot]
    // A message with no room shows everywhere; a targeted one, in its room.
    return this.approvedSnapshot.filter((entry) => entry.roomId == null || entry.roomId === roomId)
  }

  /**
   * Flow of approved messages: catch-up then real time.
   *
   * The same mechanics as the commands — the `seq` acts as the event identifier,
   * resumption goes through `lastEventId`.
   */
  async *stream(
    roomId: string | null,
    sinceSeq: number,
    signal?: AbortSignal,
  ): AsyncGenerator<{ seq: number; comment: Comment }> {
    // Subscribe before reading the backlog, otherwise a message approved between
    // the two would fall into a gap.
    const live = on(this.emitter, CHANNEL, { signal })

    let lastSeq = sinceSeq
    for (const entry of this.backlog(roomId, sinceSeq)) {
      lastSeq = entry.seq
      yield entry
    }

    try {
      for await (const [event] of live) {
        const entry = event as { seq: number; comment: Comment }
        if (entry.seq <= lastSeq) continue
        if (roomId != null && entry.comment.roomId != null && entry.comment.roomId !== roomId) continue
        lastSeq = entry.seq
        yield entry
      }
    } catch (cause) {
      if ((cause as Error)?.name !== 'AbortError') throw cause
    }
  }

  private backlog(roomId: string | null, sinceSeq: number): { seq: number; comment: Comment }[] {
    return this.db
      .select()
      .from(comment)
      .where(
        and(
          eq(comment.status, 'approved'),
          notInArray(comment.source, LOOP_ONLY_SOURCES),
          gt(comment.seq, sinceSeq),
          roomId == null ? undefined : or(isNull(comment.roomId), eq(comment.roomId, roomId)),
        ),
      )
      .orderBy(asc(comment.seq))
      .limit(this.snapshotSize)
      .all()
      .map((row) => ({ seq: row.seq, comment: toComment(row) }))
  }

  private refreshSnapshot(): void {
    this.approvedSnapshot = this.db
      .select()
      .from(comment)
      .where(and(eq(comment.status, 'approved'), notInArray(comment.source, LOOP_ONLY_SOURCES)))
      .orderBy(desc(comment.seq))
      .limit(this.snapshotSize)
      .all()
      .map(toComment)
      .reverse()
  }
}

/**
 * Questions to the speaker, votable.
 *
 * The vote is bounded by `deviceId` rather than by an account: asking a
 * conference audience to sign up in order to vote on a question would guarantee
 * that nobody votes.
 */
export class QuestionService {
  constructor(private readonly db: HubDatabase) {}

  post(input: { roomId: string; sessionId: string | null; author: string | null; text: string }): Question {
    const row = this.db
      .insert(question)
      .values({
        id: ulid(),
        roomId: input.roomId,
        sessionId: input.sessionId,
        author: input.author?.trim().slice(0, 80) ?? null,
        text: input.text.trim().slice(0, 300),
      })
      .returning()
      .get()
    return toQuestion(row)
  }

  /** One vote per device. A second call is a no-op, not an error. */
  vote(id: string, deviceId: string): number {
    return this.db.transaction((tx) => {
      const inserted = tx
        .insert(questionVote)
        .values({ questionId: id, deviceId })
        .onConflictDoNothing()
        .returning()
        .all()

      if (inserted.length === 0) {
        return tx.select().from(question).where(eq(question.id, id)).get()?.votes ?? 0
      }

      const row = tx
        .update(question)
        .set({ votes: sql`${question.votes} + 1` })
        .where(eq(question.id, id))
        .returning({ votes: question.votes })
        .get()
      return row?.votes ?? 0
    })
  }

  /** Sorted by votes: that is the order the speaker must see them in. */
  list(roomId: string, sessionId: string | null): Question[] {
    return this.db
      .select()
      .from(question)
      .where(
        sessionId == null
          ? eq(question.roomId, roomId)
          : and(eq(question.roomId, roomId), eq(question.sessionId, sessionId)),
      )
      .orderBy(desc(question.votes), asc(question.createdAt))
      .limit(100)
      .all()
      .map(toQuestion)
  }

  setStatus(id: string, status: 'open' | 'asked' | 'answered'): void {
    this.db.update(question).set({ status }).where(eq(question.id, id)).run()
  }
}

function toComment(row: typeof comment.$inferSelect): Comment {
  return commentSchema.parse({
    id: row.id,
    source: row.source,
    author: row.author,
    authorHandle: row.authorHandle,
    text: row.text,
    status: row.status,
    roomId: row.roomId,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    authorSubtitle: row.authorSubtitle,
    avatar: row.avatar,
    image: row.image,
    permalink: row.permalink,
    network: row.network,
    postedAt: row.postedAt,
    featured: row.featured || row.sourcePinned || row.sponsorName != null,
    pinned: row.sourcePinned,
    sponsor: row.sponsorName == null ? null : { name: row.sponsorName, logo: row.sponsorLogo },
  })
}

/**
 * The columns a trusted source owns — never `status`, never `featured`.
 *
 * Checked on the way in rather than trusted: a stored value the contract refuses
 * would fail every read of the wall, not just this post's.
 */
function sourceFields(input: PostInput) {
  const valid = <T>(schema: { safeParse: (v: unknown) => { success: boolean } }, value: T | null | undefined) =>
    value != null && schema.safeParse(value).success ? value : null
  return {
    authorSubtitle: input.authorSubtitle?.slice(0, 120) ?? null,
    avatar: valid(imageRefSchema, input.avatar),
    image: valid(imageRefSchema, input.image),
    permalink: input.permalink != null && input.permalink.length <= 600 ? input.permalink : null,
    network: input.network?.slice(0, 30) ?? null,
    postedAt: valid(isoDateTimeSchema, input.postedAt),
    sourceActive: input.active ?? true,
    sourcePinned: input.pinned ?? false,
  }
}

function toQuestion(row: typeof question.$inferSelect): Question {
  return questionSchema.parse({
    id: row.id,
    roomId: row.roomId,
    sessionId: row.sessionId,
    author: row.author,
    text: row.text,
    votes: row.votes,
    status: row.status,
    createdAt: row.createdAt,
  })
}
