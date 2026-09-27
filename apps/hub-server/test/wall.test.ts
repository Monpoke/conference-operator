import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { comment, question } from '@conference-operator/db/hub'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { IngestService } from '../src/services/ingest.js'
import { QuestionService, WallService } from '../src/services/wall.js'
import { RateLimiter } from '../src/services/rate-limit.js'
import { RoomService } from '../src/services/rooms.js'
import { testSecrets } from './helpers/secrets.js'

const TRACK_1 = 'track-1-teilhard-de-chardin'

let db: HubDatabase
let wall: WallService
let questions: QuestionService

beforeEach(() => {
  db = openHubDatabase(':memory:').orm
  new RoomService(db, testSecrets).upsert({
    id: TRACK_1,
    name: 'Track #1',
    trackId: TRACK_1,
    obs: {
      A: { url: 'ws://127.0.0.1:4455', password: null },
      B: { url: 'ws://127.0.0.1:4456', password: null },
    },
    sceneRoles: { A: {}, B: {} },
  })
  wall = new WallService(db)
  questions = new QuestionService(db)
})

describe('comment wall', () => {
  it('keeps every message awaiting moderation', () => {
    const posted = wall.post({ source: 'form', author: 'Alice', text: 'Super talk !' })
    // Nothing reaches a room screen without a human decision: it is projected in
    // front of the audience.
    expect(posted.status).toBe('pending')
    expect(wall.approved()).toEqual([])
    expect(wall.pending()).toHaveLength(1)
  })

  it('broadcasts a message as soon as it is approved', () => {
    const posted = wall.post({ source: 'form', author: 'Alice', text: 'Super talk !' })
    wall.moderate(posted.id, 'approve', 'regie@cloudnord.fr')

    expect(wall.approved().map((c) => c.text)).toEqual(['Super talk !'])
    expect(wall.pending()).toEqual([])
  })

  it('never displays a rejected message', () => {
    const posted = wall.post({ source: 'form', author: 'Trolls', text: 'inapproprié' })
    wall.moderate(posted.id, 'reject', 'regie@cloudnord.fr')

    expect(wall.approved()).toEqual([])
    expect(wall.pending()).toEqual([])
  })

  it('deduplicates redeliveries from the social sources', () => {
    const first = wall.post({
      source: 'bluesky',
      author: 'lucasfontaine',
      text: '#CloudNord ça commence',
      externalId: 'at://did:plc:abc/app.bsky.feed.post/1',
    })
    // A firehose redelivers, a poll overlaps the previous window: both arrive, and
    // the wall must not display the same post twice.
    const second = wall.post({
      source: 'bluesky',
      author: 'lucasfontaine',
      text: '#CloudNord ça commence',
      externalId: 'at://did:plc:abc/app.bsky.feed.post/1',
    })

    expect(second.id).toBe(first.id)
    expect(wall.pending()).toHaveLength(1)
  })

  it('lets the same identifier coexist on two sources', () => {
    wall.post({ source: 'bluesky', author: 'a', text: 'x', externalId: '42' })
    wall.post({ source: 'mastodon', author: 'a', text: 'x', externalId: '42' })
    expect(wall.pending()).toHaveLength(2)
  })

  it('filters by room without hiding the general messages', () => {
    const general = wall.post({ source: 'form', author: 'A', text: 'bonjour à tous' })
    const targeted = wall.post({ source: 'form', author: 'B', text: 'salle 1', roomId: TRACK_1 })
    wall.moderate(general.id, 'approve', 'op')
    wall.moderate(targeted.id, 'approve', 'op')

    expect(wall.approved(TRACK_1).map((c) => c.text)).toEqual(['bonjour à tous', 'salle 1'])
    expect(wall.approved('track-2').map((c) => c.text)).toEqual(['bonjour à tous'])
  })

  it('resumes the stream after the last message seen', async () => {
    const first = wall.post({ source: 'form', author: 'A', text: 'un' })
    wall.moderate(first.id, 'approve', 'op')
    const second = wall.post({ source: 'form', author: 'B', text: 'deux' })
    wall.moderate(second.id, 'approve', 'op')

    const controller = new AbortController()
    const seen: string[] = []
    for await (const entry of wall.stream(TRACK_1, 0, controller.signal)) {
      seen.push(entry.comment.text)
      if (seen.length === 2) controller.abort()
    }
    expect(seen).toEqual(['un', 'deux'])

    // Resuming after the first: only the second must come back.
    const rest: string[] = []
    const seq2 = new AbortController()
    for await (const entry of wall.stream(TRACK_1, 1, seq2.signal)) {
      rest.push(entry.comment.text)
      seq2.abort()
    }
    expect(rest).toEqual(['deux'])
  })
})

describe('questions to the speaker', () => {
  it('ranks by number of votes', () => {
    const a = questions.post({ roomId: TRACK_1, sessionId: 'ses-1', author: 'A', text: 'Question A' })
    const b = questions.post({ roomId: TRACK_1, sessionId: 'ses-1', author: 'B', text: 'Question B' })

    questions.vote(b.id, 'device-1')
    questions.vote(b.id, 'device-2')
    questions.vote(a.id, 'device-1')

    // It is the order in which the speaker must see them.
    expect(questions.list(TRACK_1, 'ses-1').map((q) => q.text)).toEqual(['Question B', 'Question A'])
  })

  it('counts only one vote per device', () => {
    const q = questions.post({ roomId: TRACK_1, sessionId: null, author: null, text: 'Q' })

    expect(questions.vote(q.id, 'device-1')).toBe(1)
    // A second call has no effect, and is not an error: a slipping finger is more
    // frequent than fraud.
    expect(questions.vote(q.id, 'device-1')).toBe(1)
    expect(questions.vote(q.id, 'device-2')).toBe(2)
  })

  it('isolates the questions by session', () => {
    questions.post({ roomId: TRACK_1, sessionId: 'ses-1', author: null, text: 'A' })
    questions.post({ roomId: TRACK_1, sessionId: 'ses-2', author: null, text: 'B' })

    expect(questions.list(TRACK_1, 'ses-1').map((q) => q.text)).toEqual(['A'])
    expect(questions.list(TRACK_1, null)).toHaveLength(2)
  })
})

/**
 * A stored row the contract refuses.
 *
 * The incident: an image built from an older commit started on a base where a
 * newer one had written `wallsio` and `hub` posts. Its enum did not know them, the
 * strict parse threw in the constructor, and the whole hub stopped — rooms and
 * console with it — for want of reading one wall post.
 */
describe('unreadable rows', () => {
  /** Approves a real post, then gives it a source this code does not know. */
  function corruptApproved(): string {
    const posted = wall.post({ source: 'form', author: 'Alice', text: 'Du futur' })
    wall.moderate(posted.id, 'approve', 'regie@example.org')
    db.update(comment).set({ source: 'linkedin' }).where(eq(comment.id, posted.id)).run()
    return posted.id
  }

  it('does not stop the hub from starting', () => {
    const bad = corruptApproved()
    const good = wall.post({ source: 'form', author: 'Bob', text: 'Lisible' })
    wall.moderate(good.id, 'approve', 'regie@example.org')
    const warnings: string[] = []

    const restarted = new WallService(db, 50, (_table, id) => warnings.push(id))

    expect(restarted.approved().map((entry) => entry.id)).toEqual([good.id])
    expect(restarted.screen().posts.map((entry) => entry.id)).toEqual([good.id])
    expect(warnings).toEqual([bad])
  })

  it('reports a bad row once, not on every read', () => {
    // The screen snapshot is recomputed on every write: a warning per read would
    // bury the log under one line.
    const bad = corruptApproved()
    const warnings: string[] = []
    const restarted = new WallService(db, 50, (_table, id) => warnings.push(id))

    restarted.post({ source: 'form', author: 'Carole', text: 'Encore' })
    restarted.pending()
    restarted.screen()

    expect(warnings).toEqual([bad])
  })

  it('says which field is wrong', () => {
    corruptApproved()
    const reasons: string[] = []

    new WallService(db, 50, (_table, _id, why) => reasons.push(why))

    expect(reasons[0]).toContain('source')
  })

  it('keeps the other questions of a session', () => {
    const kept = questions.post({ roomId: TRACK_1, sessionId: null, author: null, text: 'Et après ?' })
    const broken = questions.post({ roomId: TRACK_1, sessionId: null, author: null, text: 'Hors contrat' })
    db.update(question).set({ status: 'archived' }).where(eq(question.id, broken.id)).run()
    const warnings: string[] = []

    const list = new QuestionService(db, (table, id) => warnings.push(`${table}:${id}`)).list(TRACK_1, null)

    expect(list.map((entry) => entry.id)).toEqual([kept.id])
    expect(warnings).toEqual([`question:${broken.id}`])
  })
})

describe('rate limiting', () => {
  it('lets a normal burst through then slows down', () => {
    let now = 0
    const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 0.1, now: () => now })

    // Five messages in a row: an enthusiastic attendee, not a robot.
    for (let i = 0; i < 5; i += 1) expect(limiter.take('mobile-1')).toBe(true)
    expect(limiter.take('mobile-1')).toBe(false)

    now += 10_000
    expect(limiter.take('mobile-1')).toBe(true)
  })

  it('counts each poster separately', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0 })
    expect(limiter.take('mobile-1')).toBe(true)
    // A whole audience often shares the same IP: blocking one must not block the
    // others.
    expect(limiter.take('mobile-2')).toBe(true)
    expect(limiter.take('mobile-1')).toBe(false)
  })

  it('forgets inactive posters', () => {
    let now = 0
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0, now: () => now })
    limiter.take('mobile-1')
    expect(limiter.size).toBe(1)

    now += 20 * 60_000
    limiter.prune()
    expect(limiter.size).toBe(0)
  })
})

describe('moderation lists', () => {
  const approved = (text: string, author = 'Alice') => {
    const posted = wall.post({ source: 'form', author, text })
    wall.moderate(posted.id, 'approve', 'regie@cloudnord.fr')
    return posted
  }

  it('lists each view apart, and counts them all', () => {
    wall.post({ source: 'form', author: 'Alice', text: 'En attente' })
    approved('Publié')
    const rejected = wall.post({ source: 'form', author: 'Bob', text: 'Rejeté' })
    wall.moderate(rejected.id, 'reject', 'regie@cloudnord.fr')

    const list = wall.list({ view: 'approved' })
    expect(list.items.map((post) => post.text)).toEqual(['Publié'])
    expect(list.counts).toEqual({ pending: 1, approved: 1, rejected: 1 })
    expect(wall.list({ view: 'rejected' }).items.map((post) => post.text)).toEqual(['Rejeté'])
  })

  it('reads the queue oldest first, the published newest first', () => {
    wall.post({ source: 'form', author: 'A', text: 'premier' })
    wall.post({ source: 'form', author: 'A', text: 'second' })
    approved('ancien')
    approved('récent')

    expect(wall.list({ view: 'pending' }).items.map((post) => post.text)).toEqual(['premier', 'second'])
    expect(wall.list({ view: 'approved' }).items.map((post) => post.text)).toEqual(['récent', 'ancien'])
  })

  it('searches the text, the author and the partner, every word', () => {
    approved('Le café est servi', 'Alice')
    approved('Superbe keynote', 'Camille Dupont')
    wall.saveHubPost({ author: 'Équipe', text: 'Venez au stand', sponsor: { key: 'nova-atelier.test', name: 'NOVA Atelier' } }, 'regie')

    const texts = (q: string) => wall.list({ view: 'approved', q }).items.map((post) => post.text)
    expect(texts('café')).toEqual(['Le café est servi'])
    expect(texts('dupont')).toEqual(['Superbe keynote'])
    expect(texts('nova atelier')).toEqual(['Venez au stand'])
    expect(texts('keynote alice')).toEqual([])
    // The counts follow the search: the tabs say what it found in each.
    expect(wall.list({ view: 'pending', q: 'dupont' }).counts.approved).toBe(1)
  })

  it('takes a wildcard for a character', () => {
    approved('100% cloud')
    approved('1000 participants')

    expect(wall.list({ view: 'approved', q: '100%' }).items.map((post) => post.text)).toEqual(['100% cloud'])
    expect(wall.list({ view: 'approved', q: '_' }).items).toEqual([])
  })

  it('serves a page at a time, and the last one when asked beyond it', () => {
    for (let i = 0; i < 12; i++) wall.post({ source: 'form', author: 'A', text: `message ${i}` })

    const second = wall.list({ view: 'pending', page: 2, pageSize: 5 })
    expect(second.items.map((post) => post.text)).toEqual(['message 5', 'message 6', 'message 7', 'message 8', 'message 9'])
    expect(second.total).toBe(12)

    const beyond = wall.list({ view: 'pending', page: 9, pageSize: 5 })
    expect(beyond.page).toBe(3)
    expect(beyond.items.map((post) => post.text)).toEqual(['message 10', 'message 11'])
  })

  it('says which published posts the rooms hold', () => {
    const shown = approved('sur les écrans')
    const post = wall.list({ view: 'approved' }).items[0]!
    expect(post.id).toBe(shown.id)
    expect(post.onScreen).toBe(true)
  })

  it('keeps the partner a sponsored post is attached to', () => {
    const saved = wall.saveHubPost(
      { author: 'NOVA Atelier', text: 'Le café est servi', sponsor: { key: 'nova-atelier.test', name: 'NOVA Atelier' } },
      'regie',
    )
    expect(saved?.sponsor).toEqual({ key: 'nova-atelier.test', name: 'NOVA Atelier', logo: null })
    expect(wall.screen().posts[0]?.sponsor?.key).toBe('nova-atelier.test')
  })
})

describe('display counts', () => {
  const impressions = (id: string, seq: number, counts: Record<string, number>, occurredAt = '2026-10-30T09:00:00.000Z') => ({
    id,
    roomId: TRACK_1,
    seq,
    occurredAt,
    monotonicMs: seq * 1000,
    delivery: 'required',
    payload: { type: 'wall.impressions', counts },
  })

  it('adds what the rooms put on air, per post', () => {
    const ingest = new IngestService(db)
    const a = wall.saveHubPost({ author: 'A', text: 'a' }, 'regie')!
    const b = wall.saveHubPost({ author: 'B', text: 'b' }, 'regie')!

    ingest.push(TRACK_1, [impressions('01AAAAAAAAAAAAAAAAAAAAAAAA', 1, { [a.id]: 2, [b.id]: 1 })])
    ingest.push(TRACK_1, [
      impressions('01BBBBBBBBBBBBBBBBBBBBBBBB', 2, { [a.id]: 3 }, '2026-10-31T08:00:00.000Z'),
    ])

    const shown = wall.impressions([a.id, b.id])
    expect(shown.get(a.id)).toEqual({ count: 5, lastShownAt: '2026-10-31T08:00:00.000Z' })
    expect(shown.get(b.id)?.count).toBe(1)
    const listed = wall.list({ view: 'approved' }).items.find((post) => post.id === a.id)
    expect(listed?.impressions).toBe(5)
  })

  it('never counts a replayed batch twice', () => {
    const ingest = new IngestService(db)
    const a = wall.saveHubPost({ author: 'A', text: 'a' }, 'regie')!
    const batch = [impressions('01AAAAAAAAAAAAAAAAAAAAAAAA', 1, { [a.id]: 4 })]

    ingest.push(TRACK_1, batch)
    // The room lost the acknowledgement in an outage, and sends it again.
    const replay = ingest.push(TRACK_1, batch)

    expect(replay.duplicates).toEqual(['01AAAAAAAAAAAAAAAAAAAAAAAA'])
    expect(wall.impressions([a.id]).get(a.id)?.count).toBe(4)
  })

  it('counts nothing for a post never shown', () => {
    const a = wall.saveHubPost({ author: 'A', text: 'a' }, 'regie')!
    expect(wall.list({ view: 'approved' }).items[0]).toMatchObject({ id: a.id, impressions: 0, lastShownAt: null })
  })
})
