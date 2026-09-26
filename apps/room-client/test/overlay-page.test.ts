/// <reference lib="dom" />
// The DOM lib is declared here only: adding it to the tsconfig would let the
// server code call `document` without anything objecting.
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { flattenLayersInHtml } from '@conference-operator/ui'
import { renderOverlayPage } from '../src/core/overlay-page.js'
import type { DisplayPayload } from '../src/core/display-server.js'

/**
 * The capture overlay. Everything it displays ends up in the recording and the
 * live stream.
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
    // Started by the room: the card titles the talk on air, not the scheduled slot.
    onAirSession: TALK,
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

    expect(document.body.dataset.card).toBe('visible')
    expect(document.getElementById('title')?.textContent).toContain('HoneySwamp')
    expect(document.getElementById('people')?.textContent).toContain('Clever Cloud')
  })

  it('does not title a break', () => {
    // Otherwise the card would stay on screen for the whole lunch.
    mountOverlay({
      ...STATE,
      state: { ...STATE.state, onAirSession: { ...TALK, kind: 'break', title: 'Déjeuner' } },
    } as unknown as DisplayPayload)

    expect(document.body.dataset.card).toBe('hidden')
  })

  it('announces the talk Start will launch, before Start', () => {
    // The recording often starts with the talk: waiting for Start would open the
    // VOD on an empty frame, then fade the names in.
    mountOverlay({
      ...STATE,
      state: { ...STATE.state, currentSession: TALK, onAirSession: null, targetSession: TALK },
    } as unknown as DisplayPayload)

    expect(document.body.dataset.card).toBe('visible')
    expect(document.getElementById('title')?.textContent).toContain('HoneySwamp')
    expect(document.getElementById('people')?.textContent).toContain('Steven LE ROUX')
  })

  it('titles the talk on air over the one Start would launch', () => {
    // A forgotten End: the next slot is the target, but the speaker on stage is
    // still the one on air.
    const next = { ...TALK, id: 'ses-2', title: 'Kubernetes sans larmes', speakers: [{ name: 'Ada Martin' }] }
    mountOverlay({
      ...STATE,
      state: { ...STATE.state, onAirSession: TALK, targetSession: next },
    } as unknown as DisplayPayload)

    expect(document.getElementById('title')?.textContent).toContain('HoneySwamp')
  })

  it('announces nothing when Start would launch no talk', () => {
    for (const targetSession of [null, { ...TALK, kind: 'break', title: 'Déjeuner' }]) {
      mountOverlay({
        ...STATE,
        state: { ...STATE.state, onAirSession: null, targetSession },
      } as unknown as DisplayPayload)

      expect(document.body.dataset.card).toBe('hidden')
    }
  })

  it('keeps an overrunning talk until End, whatever the schedule says', () => {
    // The next slot has begun, but the room has not ended the first talk: its
    // speaker is still the one on stage.
    const next = { ...TALK, id: 'ses-2', title: 'Le talk suivant', speakers: [{ name: 'Alex Martin', company: null }] }
    mountOverlay({
      ...STATE,
      state: { ...STATE.state, currentSession: next, onAirSession: TALK },
    } as unknown as DisplayPayload)

    expect(document.getElementById('title')?.textContent).toContain('HoneySwamp')
    expect(document.getElementById('people')?.textContent).toContain('Steven LE ROUX')
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
        onAirSession: { ...TALK, title: "Keynote d'ouverture", speakers: [] },
      },
    } as unknown as DisplayPayload)

    expect(document.body.dataset.card).toBe('visible')
    expect(document.getElementById('title')?.textContent).toContain('Keynote')
    expect(document.getElementById('people')?.hidden).toBe(true)
    expect(document.getElementById('card-label')?.hidden).toBe(true)
  })

  it('gives every speaker their own line', () => {
    // Joined on one line, three names and their companies overflow a card that is
    // 370 pixels wide.
    mountOverlay({
      ...STATE,
      state: {
        ...STATE.state,
        onAirSession: {
          ...TALK,
          speakers: [{ name: 'Ada Lovelace', company: 'Analytical' }, { name: 'Alan Turing', company: null }],
        },
      },
    } as unknown as DisplayPayload)

    const names = [...document.querySelectorAll('#people .speaker-name')].map((n) => n.textContent)
    expect(names).toEqual(['Ada Lovelace', 'Alan Turing'])
    expect(document.querySelectorAll('#people .speaker-company')).toHaveLength(1)
    expect(document.getElementById('card-label')?.textContent).toBe('Speakers')
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
 * Audience question on the capture. It belongs in the VOD so the answer makes
 * sense; the console banner does not, and has its own field.
 */
/**
 * The frame around the slides and the webcam. Event, day, room and accounts all
 * come from the hub.
 */
describe('capture frame', () => {
  const FRAMED = {
    ...STATE,
    roomName: 'Salle 1',
    timezone: 'Europe/Paris',
    eventIdentity: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
    event: { startsAt: '2026-10-30T07:00:00.000Z', locationName: 'Lille', logoUrl: null },
    boucle: { barreBas: { hashtag: '#CloudNord2026' } },
    socialLinks: [],
  } as unknown as DisplayPayload

  it('dates the capture with the talk\'s day and the venue', () => {
    mountOverlay(FRAMED)

    expect(document.getElementById('date')?.textContent).toBe('30 octobre 2026 • Lille')
  })

  it('dates in the event\'s timezone, not the machine\'s', () => {
    // 23:30 UTC on the 29th is already the 30th in Lille.
    mountOverlay({
      ...FRAMED,
      state: { ...FRAMED.state, onAirSession: { ...TALK, startsAt: '2026-10-29T23:30:00.000Z' } },
    } as unknown as DisplayPayload)

    expect(document.getElementById('date')?.textContent).toContain('30 octobre')
  })

  it('names the room', () => {
    mountOverlay(FRAMED)

    expect(document.getElementById('room-name')?.textContent).toBe('Salle 1')
  })

  it('carries no hashtag, even with one set for the loop', () => {
    mountOverlay(FRAMED)

    expect(document.getElementById('footer')?.textContent).not.toContain('#')
  })

  it('keeps the website and LinkedIn from the conference\'s accounts', () => {
    // The loop's screens show every account, the capture only these two.
    mountOverlay({
      ...FRAMED,
      socialLinks: [
        { network: 'Bluesky', handle: '@cloudnord.fr', url: 'https://bsky.app/profile/cloudnord.fr' },
        { network: 'LinkedIn', handle: 'Cloud Nord', url: 'https://www.linkedin.com/company/cloud-nord' },
        { network: 'Site web', handle: 'cloudnord.fr', url: 'https://cloudnord.fr' },
      ],
    } as unknown as DisplayPayload)

    const items = [...document.querySelectorAll('#footer .social')].map((item) => item.textContent)
    expect(items).toEqual(['cloudnord.fr', 'LinkedInCloud Nord'])
    expect(document.getElementById('footer')?.textContent).not.toContain('Bluesky')
    expect(document.getElementById('footer')?.textContent).not.toContain('Cloud Nord 2026')
  })

  it('leaves out an account it does not find', () => {
    // No website entry: LinkedIn alone, without a stray separator.
    mountOverlay({
      ...FRAMED,
      socialLinks: [{ network: 'LinkedIn', handle: 'Cloud Nord', url: 'https://www.linkedin.com/company/cloud-nord' }],
    } as unknown as DisplayPayload)

    expect(document.getElementById('footer')?.textContent).toBe('LinkedInCloud Nord')
  })

  it('always names the conference at the top, logo or not', () => {
    // A logo alone does not say which conference a VOD comes from once it is cut
    // out of the event.
    mountOverlay(FRAMED)
    expect(document.getElementById('logo')?.hidden).toBe(true)
    expect(document.getElementById('event-name')?.textContent).toBe('Cloud Nord 2026')

    mountOverlay({ ...FRAMED, event: { ...(FRAMED.event as object), logoUrl: '/assets/logo.png' } } as unknown as DisplayPayload)
    expect(document.getElementById('logo')?.hidden).toBe(false)
    expect(document.getElementById('event-name')?.hidden).toBe(false)
    expect(document.getElementById('event-name')?.textContent).toBe('Cloud Nord 2026')
  })

  it('lets a logo that spells the name stand alone, when the console says so', () => {
    mountOverlay({
      ...FRAMED,
      boucle: { ...(FRAMED.boucle as object), logoUrl: '/assets/console.png', logoAvecNom: true },
    } as unknown as DisplayPayload)
    expect(document.getElementById('logo')?.hidden).toBe(false)
    expect(document.getElementById('event-name')?.hidden).toBe(true)

    // Without a logo to carry it, the name comes back.
    mountOverlay({ ...FRAMED, boucle: { ...(FRAMED.boucle as object), logoAvecNom: true } } as unknown as DisplayPayload)
    expect(document.getElementById('event-name')?.hidden).toBe(false)
  })

  it('wears the logo set in the console over the program\'s', () => {
    mountOverlay({
      ...FRAMED,
      event: { ...(FRAMED.event as object), logoUrl: '/assets/programme.png' },
      boucle: { ...(FRAMED.boucle as object), logoUrl: '/assets/console.png' },
    } as unknown as DisplayPayload)

    expect(document.getElementById('logo')?.getAttribute('src')).toBe('/assets/console.png')
  })

  it('leaves the slides and the webcam transparent', () => {
    // The decor is clipped by an even-odd path: the outer canvas, then one
    // rounded rectangle per hole. Without the holes, OBS would show only the decor.
    mountOverlay(FRAMED)

    const holes = document.getElementById('holesPath')?.getAttribute('d') ?? ''
    expect(holes.match(/Z/g)).toHaveLength(3)
  })
})

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
    // The card leaves through an early return on a slot with no speaker:
    // the question, for its part, must not stay frozen on the previous one.
    mountOverlay(withState({
      onAirSession: null,
      question: { text: 'Et les faux positifs ?', author: null, sessionId: 'ses-1' },
    }))

    expect(document.body.dataset.card).toBe('hidden')
    expect(document.body.dataset.question).toBe('visible')
  })
})
