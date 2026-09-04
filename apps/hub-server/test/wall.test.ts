import { beforeEach, describe, expect, it } from 'vitest'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { QuestionService, WallService } from '../src/services/wall.js'
import { RateLimiter } from '../src/services/rate-limit.js'
import { RoomService } from '../src/services/rooms.js'

const TRACK_1 = 'track-1-teilhard-de-chardin'

let db: HubDatabase
let wall: WallService
let questions: QuestionService

beforeEach(() => {
  db = openHubDatabase(':memory:').orm
  new RoomService(db).upsert({
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
      author: 'dadideo',
      text: '#CloudNord ça commence',
      externalId: 'at://did:plc:abc/app.bsky.feed.post/1',
    })
    // A firehose redelivers, a poll overlaps the previous window: both arrive, and
    // the wall must not display the same post twice.
    const second = wall.post({
      source: 'bluesky',
      author: 'dadideo',
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
