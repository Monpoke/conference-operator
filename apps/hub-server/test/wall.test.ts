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

describe('mur de commentaires', () => {
  it('garde tout message en attente de modération', () => {
    const posted = wall.post({ source: 'form', author: 'Alice', text: 'Super talk !' })
    // Rien n'atteint un écran de salle sans décision humaine : c'est projeté
    // devant le public.
    expect(posted.status).toBe('pending')
    expect(wall.approved()).toEqual([])
    expect(wall.pending()).toHaveLength(1)
  })

  it('diffuse un message dès qu\'il est approuvé', () => {
    const posted = wall.post({ source: 'form', author: 'Alice', text: 'Super talk !' })
    wall.moderate(posted.id, 'approve', 'regie@cloudnord.fr')

    expect(wall.approved().map((c) => c.text)).toEqual(['Super talk !'])
    expect(wall.pending()).toEqual([])
  })

  it('n\'affiche jamais un message rejeté', () => {
    const posted = wall.post({ source: 'form', author: 'Trolls', text: 'inapproprié' })
    wall.moderate(posted.id, 'reject', 'regie@cloudnord.fr')

    expect(wall.approved()).toEqual([])
    expect(wall.pending()).toEqual([])
  })

  it('déduplique les relivraisons des sources sociales', () => {
    const premier = wall.post({
      source: 'bluesky',
      author: 'dadideo',
      text: '#CloudNord ça commence',
      externalId: 'at://did:plc:abc/app.bsky.feed.post/1',
    })
    // Un firehose relivre, un polling recouvre la fenêtre précédente : les deux
    // arrivent, et le mur ne doit pas afficher deux fois le même post.
    const second = wall.post({
      source: 'bluesky',
      author: 'dadideo',
      text: '#CloudNord ça commence',
      externalId: 'at://did:plc:abc/app.bsky.feed.post/1',
    })

    expect(second.id).toBe(premier.id)
    expect(wall.pending()).toHaveLength(1)
  })

  it('laisse coexister le même identifiant sur deux sources', () => {
    wall.post({ source: 'bluesky', author: 'a', text: 'x', externalId: '42' })
    wall.post({ source: 'mastodon', author: 'a', text: 'x', externalId: '42' })
    expect(wall.pending()).toHaveLength(2)
  })

  it('filtre par salle sans cacher les messages généraux', () => {
    const general = wall.post({ source: 'form', author: 'A', text: 'bonjour à tous' })
    const cible = wall.post({ source: 'form', author: 'B', text: 'salle 1', roomId: TRACK_1 })
    wall.moderate(general.id, 'approve', 'op')
    wall.moderate(cible.id, 'approve', 'op')

    expect(wall.approved(TRACK_1).map((c) => c.text)).toEqual(['bonjour à tous', 'salle 1'])
    expect(wall.approved('track-2').map((c) => c.text)).toEqual(['bonjour à tous'])
  })

  it('reprend le flux après le dernier message vu', async () => {
    const premier = wall.post({ source: 'form', author: 'A', text: 'un' })
    wall.moderate(premier.id, 'approve', 'op')
    const second = wall.post({ source: 'form', author: 'B', text: 'deux' })
    wall.moderate(second.id, 'approve', 'op')

    const controller = new AbortController()
    const vus: string[] = []
    for await (const entry of wall.stream(TRACK_1, 0, controller.signal)) {
      vus.push(entry.comment.text)
      if (vus.length === 2) controller.abort()
    }
    expect(vus).toEqual(['un', 'deux'])

    // Reprise après le premier : seul le second doit revenir.
    const suite: string[] = []
    const seq2 = new AbortController()
    for await (const entry of wall.stream(TRACK_1, 1, seq2.signal)) {
      suite.push(entry.comment.text)
      seq2.abort()
    }
    expect(suite).toEqual(['deux'])
  })
})

describe('questions au speaker', () => {
  it('classe par nombre de votes', () => {
    const a = questions.post({ roomId: TRACK_1, sessionId: 'ses-1', author: 'A', text: 'Question A' })
    const b = questions.post({ roomId: TRACK_1, sessionId: 'ses-1', author: 'B', text: 'Question B' })

    questions.vote(b.id, 'appareil-1')
    questions.vote(b.id, 'appareil-2')
    questions.vote(a.id, 'appareil-1')

    // C'est l'ordre dans lequel le speaker doit les voir.
    expect(questions.list(TRACK_1, 'ses-1').map((q) => q.text)).toEqual(['Question B', 'Question A'])
  })

  it('ne compte qu\'un vote par appareil', () => {
    const q = questions.post({ roomId: TRACK_1, sessionId: null, author: null, text: 'Q' })

    expect(questions.vote(q.id, 'appareil-1')).toBe(1)
    // Un second appel est sans effet, pas une erreur : le doigt qui glisse est
    // plus fréquent que la fraude.
    expect(questions.vote(q.id, 'appareil-1')).toBe(1)
    expect(questions.vote(q.id, 'appareil-2')).toBe(2)
  })

  it('isole les questions par session', () => {
    questions.post({ roomId: TRACK_1, sessionId: 'ses-1', author: null, text: 'A' })
    questions.post({ roomId: TRACK_1, sessionId: 'ses-2', author: null, text: 'B' })

    expect(questions.list(TRACK_1, 'ses-1').map((q) => q.text)).toEqual(['A'])
    expect(questions.list(TRACK_1, null)).toHaveLength(2)
  })
})

describe('limitation de débit', () => {
  it('laisse passer une rafale normale puis freine', () => {
    let now = 0
    const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 0.1, now: () => now })

    // Cinq messages d'affilée : un participant enthousiaste, pas un robot.
    for (let i = 0; i < 5; i += 1) expect(limiter.take('mobile-1')).toBe(true)
    expect(limiter.take('mobile-1')).toBe(false)

    now += 10_000
    expect(limiter.take('mobile-1')).toBe(true)
  })

  it('compte séparément chaque déposant', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0 })
    expect(limiter.take('mobile-1')).toBe(true)
    // Tout un public partage souvent la même IP : bloquer l'un ne doit pas
    // bloquer les autres.
    expect(limiter.take('mobile-2')).toBe(true)
    expect(limiter.take('mobile-1')).toBe(false)
  })

  it('oublie les déposants inactifs', () => {
    let now = 0
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0, now: () => now })
    limiter.take('mobile-1')
    expect(limiter.size).toBe(1)

    now += 20 * 60_000
    limiter.prune()
    expect(limiter.size).toBe(0)
  })
})
