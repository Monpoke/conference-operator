/// <reference lib="dom" />
// The DOM lib is declared here only: adding it to the tsconfig would let the
// server code call `document` without anything objecting.
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { flattenLayersInHtml } from '@cloudnord/ui'
import { renderOverlayPage } from '../src/core/overlay-page.js'
import type { DisplayPayload } from '../src/core/display-server.js'

/**
 * The capture overlay.
 *
 * What is in this page is **burned into the master**: it is a source of OBS-B's
 * scene, so everything it displays goes into the VOD and into the live stream.
 * That is the only constraint that counts here.
 */
const TALK = {
  id: 'ses-1',
  title: 'HoneySwamp: Active Defense to Ruin Attackers',
  kind: 'talk',
  startsAt: '2026-10-30T10:00:00.000Z',
  endsAt: '2026-10-30T10:50:00.000Z',
  startsAtMs: Date.parse('2026-10-30T10:00:00Z'),
  endsAtMs: Date.parse('2026-10-30T10:50:00Z'),
  speakers: [{ name: 'Steven LE ROUX', company: 'Clever Cloud' }],
  category: null,
}

const STATE = {
  state: {
    mode: 'sponsors',
    currentSession: TALK,
    nextSession: null,
    recording: false,
    streaming: false,
    serverTimeOffsetMs: 0,
    comments: [],
    sessionStates: {},
  },
  event: null,
} as unknown as DisplayPayload

function mountOverlay(payload: DisplayPayload = STATE): void {
  document.documentElement.innerHTML = flattenLayersInHtml(
    renderOverlayPage({ initialPayload: payload }),
  )
  for (const script of document.querySelectorAll('script:not([type])')) {
    // eslint-disable-next-line no-new-func
    new Function(script.textContent ?? '')()
  }
}

describe('capture overlay', () => {
  it('titles the running talk', () => {
    mountOverlay()

    expect(document.body.dataset.lowerThird).toBe('visible')
    expect(document.getElementById('title')?.textContent).toContain('HoneySwamp')
    expect(document.getElementById('people')?.textContent).toContain('Clever Cloud')
  })

  it('does not title a break', () => {
    // A slot with no speaker has nothing to title — and the lower third would
    // stay on screen for the whole lunch.
    mountOverlay({
      ...STATE,
      state: { ...STATE.state, currentSession: { ...TALK, kind: 'break', title: 'Déjeuner' } },
    } as unknown as DisplayPayload)

    expect(document.body.dataset.lowerThird).toBe('hidden')
  })

  it('titles with no empty line when nobody is announced yet', () => {
    /**
     * The case has existed since a slot can be declared a talk by hand: an
     * opening keynote whose speaker is not announced yet carries a title and no
     * name. An empty line would keep its margin under the title and would read,
     * in the live stream as in the VOD, as a name that failed to load.
     */
    mountOverlay({
      ...STATE,
      state: {
        ...STATE.state,
        currentSession: { ...TALK, title: "Keynote d'ouverture", speakers: [] },
      },
    } as unknown as DisplayPayload)

    expect(document.body.dataset.lowerThird).toBe('visible')
    expect(document.getElementById('title')?.textContent).toContain('Keynote')
    expect(document.getElementById('people')?.hidden).toBe(true)
  })

  it('does not report the recording, even mid-take', () => {
    // A red dot here would be engraved in the delivered VOD. The take indicator
    // lives in the control app, in the "Captation" panel.
    mountOverlay({
      ...STATE,
      state: { ...STATE.state, recording: true },
    } as unknown as DisplayPayload)

    expect(document.getElementById('rec')).toBeNull()
    expect(document.body.dataset.rec).toBeUndefined()
  })
})

/**
 * An audience question in the master.
 *
 * It **does** have its place in the VOD: a capture where the speaker answers a
 * question one has never read is incomprehensible. The console's banner, on the
 * other hand, does not — it speaks to the room of right now. The two long shared
 * a single field, which made it impossible to show one without risking the other.
 */
describe('audience question on the capture', () => {
  const withState = (state: Record<string, unknown>) =>
    ({ ...STATE, state: { ...STATE.state, ...state } }) as unknown as DisplayPayload

  it('burns in the question put on air', () => {
    mountOverlay(withState({ question: { text: 'Et les faux positifs ?', author: 'Camille', sessionId: 'ses-1' } }))

    expect(document.body.dataset.question).toBe('visible')
    expect(document.getElementById('question-text')?.textContent).toBe('Et les faux positifs ?')
    expect(document.getElementById('question-author')?.textContent).toBe('Camille')
  })

  it('burns in nothing with no question on air', () => {
    // An empty frame engraved in the whole VOD would be worse than nothing.
    mountOverlay(withState({ question: null }))

    expect(document.body.dataset.question).toBe('hidden')
  })

  it('never lets the console banner through', () => {
    // "We resume in 5 minutes" engraved in a talk's VOD: that is exactly what
    // separating the two channels avoids.
    mountOverlay(withState({
      question: null,
      liveMessage: { text: 'Reprise dans 5 minutes', level: 'urgent', expiresAtMs: null },
    }))

    expect(document.body.dataset.question).toBe('hidden')
    // Nothing is *rendered*: the complete state does travel this far, as for the
    // other fields, but this page only draws the question.
    expect(document.getElementById('question-text')?.textContent).toBe('')
    expect(document.getElementById('title')?.textContent).not.toContain('Reprise')
  })

  it('stays visible outside a titleable talk', () => {
    // The lower third leaves through an early return on a slot with no speaker:
    // the question, for its part, must not stay frozen on the previous one.
    mountOverlay(withState({
      currentSession: null,
      question: { text: 'Et les faux positifs ?', author: null, sessionId: 'ses-1' },
    }))

    expect(document.body.dataset.lowerThird).toBe('hidden')
    expect(document.body.dataset.question).toBe('visible')
  })
})
