import { EventEmitter, on } from 'node:events'
import { and, asc, desc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  commentSchema,
  questionSchema,
  type Comment,
  type CommentSource,
  type Question,
} from '@conference-operator/contract'
import { comment, question, questionVote } from '@conference-operator/db/hub'
import type { HubDatabase } from '../db.js'

const CHANNEL = 'wall'

export interface PostInput {
  source: CommentSource
  author: string
  text: string
  roomId?: string | null
  sessionId?: string | null
  /** The post's identifier at the source, to deduplicate redeliveries. */
  externalId?: string | null
  authorHandle?: string | null
}

/**
 * Comment wall and moderation.
 *
 * Every source — form, Bluesky, Mastodon, X — converges on the same `pending`
 * queue. Nothing reaches a room screen without going through a human decision:
 * it is projected in front of the audience.
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

  constructor(
    private readonly db: HubDatabase,
    private readonly snapshotSize = 50,
  ) {
    this.emitter.setMaxListeners(256)
    this.refreshSnapshot()
  }

  /**
   * Posts a message. Always as `pending`.
   *
   * Returns the existing message if the source has already delivered it: a
   * firehose can redeliver, and polling always overlaps the previous window.
   */
  post(input: PostInput): Comment {
    if (input.externalId != null) {
      const existing = this.db
        .select()
        .from(comment)
        .where(and(eq(comment.source, input.source), eq(comment.externalId, input.externalId)))
        .get()
      if (existing != null) return toComment(existing)
    }

    const row = this.db
      .insert(comment)
      .values({
        id: ulid(),
        source: input.source,
        author: input.author.trim().slice(0, 80),
        authorHandle: input.authorHandle ?? null,
        externalId: input.externalId ?? null,
        text: input.text.trim().slice(0, 500),
        status: 'pending',
        roomId: input.roomId ?? null,
        sessionId: input.sessionId ?? null,
      })
      .returning()
      .get()

    return toComment(row)
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

  /** Approves or rejects. An approved message leaves for the screens immediately. */
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
    if (decision === 'approve') {
      this.refreshSnapshot()
      this.emitter.emit(CHANNEL, { seq: row.seq, comment: approved })
    }
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
      .where(eq(comment.status, 'approved'))
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
  })
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
