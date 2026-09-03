/// <reference lib="dom" />
// The DOM lib is declared here only: adding it to the tsconfig would let the
// server code call `document` without anything objecting.
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForRender } from './helpers/wait-for-render.js'
import { flattenLayersInHtml } from '@cloudnord/ui'
import { renderWallPage } from '../src/pages/wall-page.js'

/**
 * The public wall, run inside a real DOM.
 *
 * It is the only page the audience uses, on their own phone: it has no build
 * step, and an error in its script leaves it mute without reporting anything.
 */
const ROOM = { id: 'track-1', name: 'Track #1' }

const TALK = {
  id: 'ses-1',
  title: 'HoneySwamp',
  speakers: ['Steven LE ROUX'],
  startsAt: '2026-10-30T10:00:00.000Z',
  endsAt: '2026-10-30T10:50:00.000Z',
}

let calls: { path: string; input: Record<string, unknown> }[]

/**
 * Mounts the wall against a simulated hub.
 *
 * `currentTalk` is what `rooms/current` returns; `questions` what
 * `questions/list` returns, whatever talk is asked for — that call's input is
 * precisely what we came to observe.
 */
function mountWall(
  currentTalk: { current: unknown; next: unknown },
  questions: unknown[] = [],
  recentWall: unknown[] = [],
): void {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = String(url).replace('/rpc/', '')
    calls.push({ path, input: JSON.parse(String(init.body)).json })
    const json = path === 'rooms/current' ? currentTalk
      : path === 'questions/list' ? questions
        : path === 'wall/recent' ? recentWall
          : {}
    return new Response(JSON.stringify({ json }), { status: 200 })
  }))

  document.documentElement.innerHTML = flattenLayersInHtml(
    renderWallPage({ roomId: ROOM.id, rooms: [ROOM] }),
  )
  for (const script of document.querySelectorAll('script:not([type])')) {
    // eslint-disable-next-line no-new-func
    new Function(script.textContent ?? '')()
  }
}

const $ = (id: string) => document.getElementById(id)!
const settle = waitForRender

beforeEach(() => {
  localStorage.clear()
})

/**
 * Questions bounded to the talk.
 *
 * At 4 pm the list still brought up those of the 10 am talk — the best voted
 * ones, so at the top — and the audience voted for questions nobody would ask any
 * more.
 */
describe('wall — questions of the running talk', () => {
  it('only asks for the questions of the running talk', async () => {
    mountWall({ current: TALK, next: null })
    await settle()
    $('tab-questions').click()
    await settle()

    expect(calls).toContainEqual({
      path: 'questions/list',
      input: { roomId: ROOM.id, sessionId: TALK.id },
    })
    // And never with `sessionId: null`, which means "the whole day" on the hub side.
    expect(calls.some((call) =>
      call.path === 'questions/list' && call.input.sessionId === null)).toBe(false)
  })

  it('attaches a posted question to that talk', async () => {
    mountWall({ current: TALK, next: null })
    await settle()
    ;($('question') as HTMLTextAreaElement).value = 'Et les faux positifs ?'
    $('form-question').dispatchEvent(new Event('submit'))
    await settle()

    expect(calls.find((call) => call.path === 'questions/post')?.input)
      .toMatchObject({ roomId: ROOM.id, sessionId: TALK.id })
  })

  it('aims at the upcoming talk between two talks', async () => {
    // A question asked during the break preceding a talk is aimed at it.
    // Attaching it to nothing would make it invisible to everyone — control app
    // included.
    mountWall({ current: null, next: TALK })
    await settle()
    $('tab-questions').click()
    await settle()

    expect(calls).toContainEqual({
      path: 'questions/list',
      input: { roomId: ROOM.id, sessionId: TALK.id },
    })
  })

  it('says so when no talk is announced', async () => {
    mountWall({ current: null, next: null })
    await settle()
    $('tab-questions').click()
    await settle()

    expect($('list-questions').textContent).toContain('Aucune conférence annoncée')
    expect(calls.some((call) => call.path === 'questions/list')).toBe(false)
  })

  it('names the talk when nobody has asked anything yet', async () => {
    // A bare "no question" would make it look as though the wall were broken.
    mountWall({ current: TALK, next: null }, [])
    await settle()
    $('tab-questions').click()
    await settle()

    expect($('list-questions').textContent).toContain('HoneySwamp')
  })
})

/**
 * The wall is shared by the event.
 *
 * A message from the audience is addressed to Cloud Nord, not to the room its
 * author happens to be in: limiting it to one room made it one more channel to
 * watch, and deprived the other two screens of what was being said there.
 */
describe('wall — shared by every room', () => {
  const MESSAGE = {
    id: 'c-1', source: 'form', author: 'Camille', authorHandle: null,
    text: 'Super talk, merci !', status: 'approved', roomId: null, sessionId: null,
    createdAt: '2026-10-30T10:05:00.000Z',
  }

  it('posts with no room, whichever one is selected', async () => {
    mountWall({ current: TALK, next: null })
    await settle()
    ;($('author') as HTMLInputElement).value = 'Camille'
    ;($('message') as HTMLTextAreaElement).value = 'Super talk'
    $('form-message').dispatchEvent(new Event('submit'))
    await settle()

    // On the hub side, a null room means "every room".
    expect(calls.find((call) => call.path === 'wall/post')?.input)
      .toMatchObject({ roomId: null, author: 'Camille' })
  })

  it('announces the scope before the form, not after', async () => {
    // It is the page's promise: you are not writing into a suggestion box.
    // Saying it under a button you have just pressed amounted to not saying it.
    mountWall({ current: TALK, next: null })
    await settle()

    expect($('view-wall').textContent).toContain('dans toutes les salles')
    // The real number of rooms, not a principle.
    expect($('scope').textContent).toContain('Projeté sur les écrans')
  })

  it('shows what is already on the screen', async () => {
    // Without this, dropping a message amounted to speaking into the void:
    // nothing showed that others were writing, nor that it ended up projected.
    mountWall({ current: TALK, next: null }, [], [MESSAGE])
    await settle()

    expect(calls.some((call) => call.path === 'wall/recent')).toBe(true)
    expect($('list-wall').textContent).toContain('Super talk, merci !')
    expect($('list-wall').textContent).toContain('Camille')
  })

  it('invites rather than leaving an empty frame', async () => {
    mountWall({ current: TALK, next: null }, [], [])
    await settle()

    expect($('list-wall').textContent).toContain('peut être le vôtre')
  })

  it('no longer leaves a room name at the top of the wall', async () => {
    // It made it look as though one was writing to that room.
    mountWall({ current: TALK, next: null })
    await settle()

    expect($('room').textContent).toContain('Questions')
  })
})
