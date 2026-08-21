import { EventEmitter, on } from 'node:events'
import { and, asc, desc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  commentSchema,
  questionSchema,
  type Comment,
  type CommentSource,
  type Question,
} from '@cloudnord/contract'
import { comment, question, questionVote } from '@cloudnord/db/hub'
import type { HubDatabase } from '../db.js'

const CHANNEL = 'wall'

export interface PostInput {
  source: CommentSource
  author: string
  text: string
  roomId?: string | null
  sessionId?: string | null
  /** Identifiant du post chez la source, pour dédupliquer les relivraisons. */
  externalId?: string | null
  authorHandle?: string | null
}

/**
 * Mur de commentaires et modération.
 *
 * Toutes les sources — formulaire, Bluesky, Mastodon, X — convergent vers la
 * même file `pending`. Rien n'atteint un écran de salle sans passer par une
 * décision humaine : c'est projeté devant le public.
 */
export class WallService {
  private readonly emitter = new EventEmitter()
  /**
   * Instantané des messages approuvés, tenu en mémoire.
   *
   * Le mur public est la seule charge non bornée du hub (quelques centaines de
   * mobiles quand le QR est à l'écran). On ne le sert donc pas par requête SQL :
   * on recalcule à l'écriture, on lit depuis la mémoire.
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
   * Dépose un message. Toujours en `pending`.
   *
   * Retourne le message existant si la source l'a déjà livré : un firehose
   * peut relivrer, et un polling recouvre toujours la fenêtre précédente.
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

  /** Approuve ou rejette. Un message approuvé part immédiatement vers les écrans. */
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

  /** Derniers messages approuvés, servis depuis la mémoire. */
  approved(roomId?: string | null): Comment[] {
    if (roomId == null) return [...this.approvedSnapshot]
    // Un message sans salle s'affiche partout ; un message ciblé, dans sa salle.
    return this.approvedSnapshot.filter((entry) => entry.roomId == null || entry.roomId === roomId)
  }

  /**
   * Flux des messages approuvés : rattrapage puis temps réel.
   *
   * Même mécanique que les commandes — le `seq` sert d'identifiant d'événement,
   * la reprise passe par `lastEventId`.
   */
  async *stream(
    roomId: string | null,
    sinceSeq: number,
    signal?: AbortSignal,
  ): AsyncGenerator<{ seq: number; comment: Comment }> {
    // S'abonner avant de lire le backlog, sinon un message approuvé entre les
    // deux tomberait dans un trou.
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
 * Questions au speaker, votables.
 *
 * Le vote est borné par `deviceId` plutôt que par un compte : demander une
 * inscription à un public de conférence, pour voter une question, garantirait
 * que personne ne vote.
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

  /** Un vote par appareil. Un second appel est sans effet, pas une erreur. */
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

  /** Triées par votes : c'est l'ordre dans lequel le speaker doit les voir. */
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
