/// <reference lib="dom" />
// The DOM lib is declared here only: adding it to the tsconfig would let the
// server code call `document` without anything objecting.
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flattenLayersInHtml } from '@cloudnord/ui'
import { renderProjectorPage } from '../src/core/display-page.js'
import type { DisplayPayload } from '../src/core/display-server.js'

/**
 * The room screen's behaviour in a real DOM.
 *
 * A day's program is two to three times the screen's height, and nobody can
 * scroll a video projector: what matters is therefore *which* row the page brings
 * to the centre.
 */
const session = (id: string, hour: string, title: string, kind = 'talk') => ({
  id,
  title,
  kind,
  startsAt: `2026-10-30T${hour}:00.000Z`,
  endsAt: `2026-10-30T${hour}:45.000Z`,
  startsAtMs: Date.parse(`2026-10-30T${hour}:00Z`),
  endsAtMs: Date.parse(`2026-10-30T${hour}:45Z`),
  speakers: [],
})

/** A real day: longer than the screen, which is the whole point. */
const SESSIONS = [
  session('s-0', '07:30', 'Accueil', 'break'),
  session('s-1', '08:00', 'Keynote'),
  session('s-2', '09:00', 'IA for OPS'),
  session('s-3', '10:00', 'HoneySwamp'),
  session('s-4', '11:00', 'Blind ops'),
  session('s-5', '12:00', 'Déjeuner', 'break'),
  session('s-6', '13:00', 'Houston'),
]

const STATE = {
  state: {
    mode: 'programme',
    message: null,
    sceneRole: 'HOLD',
    connectivity: 'ONLINE',
    roomId: 'track-1',
    contentHash: 'h',
    currentSession: SESSIONS[3],
    nextSession: SESSIONS[4],
    outboxDepth: 0,
    serverTimeOffsetMs: Date.parse('2026-10-30T10:20:00Z') - Date.now(),
    recording: false,
    streaming: false,
    comments: [],
    sessionStates: {},
  },
  roomName: 'Track #1',
  event: null,
  // What the hub decided and pushed at sync: it is from there that the page takes
  // its title and the name it writes in the waiting loop. Nothing is compiled
  // into the room's binary.
  eventIdentity: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
  timezone: 'Europe/Paris',
  sessions: SESSIONS,
  sponsorTiers: [],
  wall: null,
  feedback: null,
  diagnostics: null,
  pairing: null,
} as unknown as DisplayPayload

/** What the page asked to bring on screen, and how. */
let centred: { element: Element; options: unknown } | null

/**
 * The `setInterval`s the page sets, replayed by hand.
 *
 * The loop advances on the page's one-second tick, and the countdown updates
 * itself there: replaying it ourselves avoids waiting a real minute per test, and
 * the clock offset must **persist** from one call to the next — the page compares
 * against `Date.now()`, and resetting it between two advances would make time go
 * backwards.
 */
const TIMERS: (() => void)[] = []
const REAL_NOW = Date.now
const REAL_INTERVAL = globalThis.setInterval
let offset = 0

function advance(seconds: number): void {
  for (let pass = 0; pass < seconds; pass += 1) {
    offset += 1_000
    for (const timer of TIMERS) timer()
  }
}

/**
 * The state stream, simulated.
 *
 * happy-dom does not supply `EventSource`, so the page simply skipped its
 * real-time branch: nothing checked the merging of the deltas, which is however
 * the path by which **every** change arrives during a break. The stub opens it,
 * and makes it possible to push a delta to the second.
 */
type SimulatedStream = { deltas: (payload: Record<string, unknown>) => void }
let stream: SimulatedStream | null = null

const REAL_EVENTSOURCE = globalThis.EventSource

function stubStream(): void {
  stream = null
  globalThis.EventSource = class {
    private listeners: Record<string, (event: { data: string }) => void> = {}
    constructor() {
      stream = { deltas: (payload) => this.listeners.delta?.({ data: JSON.stringify(payload) }) }
    }
    addEventListener(name: string, fn: (event: { data: string }) => void): void {
      this.listeners[name] = fn
    }
    close(): void {}
  } as unknown as typeof EventSource
}

function stubTimers(): void {
  TIMERS.length = 0
  offset = 0
  stubStream()
  Date.now = () => REAL_NOW.call(Date) + offset
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    // Only the one-second tick interests us: it is the one that advances the
    // loop. The others are neutralized — a test preview has no business living
    // its own life in the background.
    if (ms === 1000) TIMERS.push(fn)
    return REAL_INTERVAL(() => {}, 1_000_000) as unknown as number
  }) as typeof setInterval
}

// Given back to the rest of the file: those two replacements are global, and
// leaving them in place would make the other tests depend on the execution order.
function restoreTimers(): void {
  Date.now = REAL_NOW
  globalThis.setInterval = REAL_INTERVAL
  globalThis.EventSource = REAL_EVENTSOURCE
}

/**
 * The timers the page actually started, to be switched off after the test.
 *
 * The projected page sets its own `setInterval`s — the waiting loop, among
 * others. Outside the blocks that neutralize the clock, those are real timers,
 * and nothing stopped them: they kept beating after happy-dom had torn the
 * document down, and fell over a `document is not defined` no test caught. The
 * suite then came out red one run in three, without any test having failed — the
 * worse of the two, since it ends up masking a real failure.
 */
const REAL_TIMERS: number[] = []

function mountScreen(payload: DisplayPayload = STATE): void {
  centred = null
  document.documentElement.innerHTML = flattenLayersInHtml(
    renderProjectorPage({ initialPayload: payload }),
  )
  // happy-dom computes no layout: we observe the intent, which is the only thing
  // the page decides by itself.
  Element.prototype.scrollIntoView = function (options?: unknown) {
    centred = { element: this as Element, options }
  }

  /*
   * We wrap whatever is in place, whichever it is: depending on the block, that
   * is the real `setInterval` or the one `stubTimers` substituted. Keeping the
   * identifiers is enough in both cases.
   */
  const installed = globalThis.setInterval
  globalThis.setInterval = ((fn: () => void, ms?: number, ...args: unknown[]) => {
    const id = (installed as (...a: unknown[]) => unknown)(fn, ms, ...args)
    REAL_TIMERS.push(id as number)
    return id
  }) as typeof setInterval

  try {
    for (const script of document.querySelectorAll('script:not([type])')) {
      // eslint-disable-next-line no-new-func
      new Function(script.textContent ?? '')()
    }
  } finally {
    globalThis.setInterval = installed
  }
}

const content = () => document.getElementById('content')!

/**
 * The layer currently being displayed.
 *
 * During a transition, the leaving page is still in the document: aiming at the
 * live layer is the only way to say what the room is reading, rather than what it
 * is finishing leaving.
 */
const alive = () => content().querySelector('.layer:not(.leaving)')!

beforeEach(() => {
  mountScreen()
})

afterEach(() => {
  for (const id of REAL_TIMERS.splice(0)) clearInterval(id)
})

/**
 * The shared slot, announced on the room's screen.
 *
 * The styling switches to the waiting loop during a break, which does not say
 * *why*: an attendee who came in halfway does not know whether they missed the
 * talk or everyone is at lunch.
 */
describe('break badge', () => {
  const badge = () => document.getElementById('break-badge')!

  it('says nothing during a talk', () => {
    expect(badge().hidden).toBe(true)
  })

  it('announces the running break', () => {
    mountScreen({
      ...STATE,
      state: {
        ...STATE.state,
        breakBadge: { state: 'en-cours', title: 'Déjeuner', startsAt: '2026-10-30T11:15:00.000Z' },
      },
    } as unknown as DisplayPayload)

    expect(badge().hidden).toBe(false)
    expect(badge().textContent).toBe('Break')
  })

  it('announces it a quarter of an hour ahead, while the talk is still finishing', () => {
    mountScreen({
      ...STATE,
      state: {
        ...STATE.state,
        breakBadge: { state: 'a-venir', title: 'Déjeuner', startsAt: '2026-10-30T11:15:00.000Z' },
      },
    } as unknown as DisplayPayload)

    expect(badge().textContent).toBe('Break à venir')
    // "Upcoming" draws the eye; "running" is content to exist.
    expect(badge().style.color).toBeTruthy()
  })
})

describe('projected program', () => {
  it('brings the running talk to the centre of the screen', () => {
    // Without this, the room would be looking at breakfast at four in the
    // afternoon.
    const anchor = content().querySelector('.anchor')!

    expect(anchor.textContent).toContain('HoneySwamp')
    expect(centred?.element).toBe(anchor)
    expect(centred?.options).toEqual({ block: 'center' })
  })

  it('aims at the next one between two talks', () => {
    // `currentSession` is empty at that moment — and that is precisely when one
    // looks for the next one's time.
    mountScreen({
      ...STATE,
      state: { ...STATE.state, currentSession: null, nextSession: SESSIONS[4] },
    } as unknown as DisplayPayload)

    expect(content().querySelector('.anchor')?.textContent).toContain('Blind ops')
  })

  it('designates only one', () => {
    expect(content().querySelectorAll('.anchor').length).toBe(1)
  })

  it('still displays the whole day', () => {
    // The anchor positions, it does not filter: what precedes and what follows
    // stay readable on either side.
    expect(content().querySelectorAll('article').length).toBe(SESSIONS.length)
  })

  it('asks for nothing when the day is over', () => {
    mountScreen({
      ...STATE,
      state: { ...STATE.state, currentSession: null, nextSession: null },
    } as unknown as DisplayPayload)

    expect(content().querySelector('.anchor')).toBeNull()
    expect(centred).toBeNull()
  })

  it('does not look for an anchor in the other modes', () => {
    mountScreen({
      ...STATE,
      state: { ...STATE.state, mode: 'sponsors' },
    } as unknown as DisplayPayload)

    expect(centred).toBeNull()
  })
})

/**
 * The OpenFeedback QR code.
 *
 * Built offline: OpenFeedback reuses the session identifiers of the upstream
 * export — all 27 match — so the address is derived from the already cached
 * program, with no API key and no network call on the day.
 */
describe('the "rate the talk" screen', () => {
  const WITH_QR = {
    ...STATE,
    state: { ...STATE.state, mode: 'feedback' },
    feedback: {
      url: 'https://openfeedback.io/cloud-nord-2026/2026-10-30/s-3',
      qrSvg: '<svg id="qr"></svg>',
    },
  } as unknown as DisplayPayload

  it('displays the QR code and the talk\'s title', () => {
    mountScreen(WITH_QR)

    expect(content().querySelector('#qr')).toBeTruthy()
    expect(content().textContent).toContain('HoneySwamp')
    expect(content().textContent).toContain('Scannez')
  })

  it('says so rather than showing an empty frame', () => {
    // Outside a talk there is nothing to rate — and a dead QR code scanned by two
    // hundred people costs more than a screen that announces it.
    mountScreen({
      ...WITH_QR,
      feedback: null,
    } as unknown as DisplayPayload)

    expect(content().textContent).toContain('Aucune conférence à noter')
    expect(content().querySelector('#qr')).toBeNull()
  })
})

/**
 * A projected question.
 *
 * The same data as on both overlays — one selection, three surfaces. The overlays
 * only reach those watching the capture or the live scene; this mode puts it in
 * front of the whole room.
 */
describe('the "audience question" screen', () => {
  const withQuestion = (question: unknown) =>
    ({
      ...STATE,
      state: { ...STATE.state, mode: 'question', question },
    }) as unknown as DisplayPayload

  it('projects the question chosen in the control app', () => {
    mountScreen(withQuestion({ text: 'Comment gérez-vous les faux positifs ?', author: 'Camille', sessionId: 's-3' }))

    expect(content().textContent).toContain('Question du public')
    expect(content().textContent).toContain('faux positifs')
    expect(content().textContent).toContain('Camille')
  })

  it('does not take the console banner for a question', () => {
    // The two long shared a field: "we resume in 5 minutes" was then projected in
    // large type under the heading "Question du public".
    mountScreen({
      ...STATE,
      state: {
        ...STATE.state,
        mode: 'question',
        question: null,
        liveMessage: { text: 'Reprise dans 5 minutes', level: 'info', expiresAtMs: null },
      },
    } as unknown as DisplayPayload)

    expect(content().textContent).not.toContain('Reprise dans 5 minutes')
    expect(content().textContent).toContain('Aucune question affichée')
  })

  it('says so when no question is chosen', () => {
    mountScreen(withQuestion(null))

    expect(content().textContent).toContain('Aucune question affichée')
  })
})

/**
 * The partners page.
 *
 * Two rules govern it. The first tier paid the most: it occupies the top of the
 * screen alone. And a sponsor that took several packs appears **only once** — the
 * upstream export gives it one identifier per tier, so the same logo came back
 * three times identically, which reads as a display defect.
 */
describe('partners page', () => {
  // The identifiers differ from one tier to the next, as in the real export; so
  // does the site's trailing slash. That is exactly what the deduplication has to
  // absorb.
  const TIERS = [
    {
      id: 't0', name: 'Gold', order: 0,
      sponsors: [{ id: 'g1', name: 'HoppR', website: 'https://www.hoppr.tech/', logoUrl: null }],
    },
    {
      id: 't1', name: 'Digital', order: 1,
      sponsors: [
        { id: 'd1', name: 'ape factory', website: 'https://www.apefactory.com', logoUrl: null },
        { id: 'd2', name: 'Davidson', website: 'https://www.davidson.fr/', logoUrl: null },
      ],
    },
    {
      id: 't2', name: 'Pack Inclusivité', order: 2,
      sponsors: [{ id: 'p1', name: 'ape factory', website: 'https://www.apefactory.com/', logoUrl: null }],
    },
  ]

  const withPartners = (tiers: unknown = TIERS) =>
    ({ ...STATE, state: { ...STATE.state, mode: 'sponsors' }, sponsorTiers: tiers }) as unknown as DisplayPayload

  it('gives the top of the screen to the first tier', () => {
    mountScreen(withPartners())

    expect(alive().textContent).toContain('Gold')
    expect(alive().textContent).toContain('HoppR')
  })

  it('shows only once the one that took several packs', () => {
    mountScreen(withPartners())

    const text = alive().textContent ?? ''
    expect(text.match(/ape factory/g)?.length).toBe(1)
  })

  it('says which ones it took', () => {
    mountScreen(withPartners())

    expect(alive().textContent).toContain('Digital · Pack Inclusivité')
    expect(alive().textContent).toContain('Et sur tous les fronts')
  })

  it('does not promise several fronts when nobody took two', () => {
    // The label is a claim: with no multi-pack sponsor, it would be lying.
    mountScreen(withPartners(TIERS.slice(0, 2).map((tier) => ({
      ...tier,
      sponsors: tier.sponsors.slice(0, 1),
    }))))

    expect(alive().textContent).toContain('Et aussi')
    expect(alive().textContent).not.toContain('Et sur tous les fronts')
  })

  it('shrinks to the band when there is only one tier', () => {
    mountScreen(withPartners(TIERS.slice(0, 1)))

    const text = alive().textContent ?? ''
    expect(text).toContain('HoppR')
    expect(text).not.toContain('Et aussi')
    expect(text).not.toContain('Et sur tous les fronts')
  })

  it('offers its logos for cropping', () => {
    // The hook for the cropping, and nothing more: the crop itself needs a
    // canvas, which happy-dom does not have. What this test holds is that the
    // page does not throw for all that and that the logos stay identifiable.
    mountScreen(withPartners([
      {
        id: 't0', name: 'Gold', order: 0,
        sponsors: [{ id: 'g1', name: 'HoppR', website: null, logoUrl: '/assets/abc123' }],
      },
    ]))

    expect(alive().querySelectorAll('img[data-logo]').length).toBe(1)
  })

  it('says so when there is no partner at all', () => {
    mountScreen(withPartners([]))

    expect(alive().textContent).toContain('Merci à nos partenaires')
  })
})

/**
 * The resume countdown.
 *
 * It lives to the second, and that is precisely what forbade animating it: the
 * page rewrote the whole block on every tick, which reset everything that could
 * have moved. Structure and values are now separated.
 */
describe('countdown', () => {
  beforeEach(stubTimers)
  afterEach(restoreTimers)

  const inCountdown = () =>
    ({ ...STATE, state: { ...STATE.state, mode: 'countdown' } }) as unknown as DisplayPayload

  it('updates the digits without rebuilding the block', () => {
    mountScreen(inCountdown())
    const seconds = alive().querySelector('.cd-sec')!
    const before = seconds.textContent

    advance(2)

    // The same node, with another value: it is the condition for an animation
    // placed on it to survive from one second to the next.
    expect(alive().querySelector('.cd-sec')).toBe(seconds)
    expect(seconds.textContent).not.toBe(before)
  })

  it('announces the talk we resume on', () => {
    mountScreen(inCountdown())

    expect(alive().textContent).toContain('Blind ops')
  })

  it('says so when the day is over', () => {
    mountScreen({
      ...STATE,
      state: { ...STATE.state, mode: 'countdown', nextSession: null },
    } as unknown as DisplayPayload)

    expect(alive().textContent).toContain('Fin des interventions')
  })
})

/**
 * The waiting loop.
 *
 * What we leave running during the breaks. Two rules govern it: pages with no
 * content are **skipped** — ten seconds of a deserted frame in front of the room
 * read as a failure — and coming back into the loop restarts from the beginning,
 * rather than landing in the middle of the program.
 */
describe('waiting loop', () => {
  const OTHERS = [
    {
      roomId: 'track-2',
      name: 'Track #2',
      session: { id: 's-12', title: 'Au-dessus de la mêlée', startsAt: '2026-10-30T11:00:00.000Z', speakers: ['Camille'] },
      running: false,
    },
    {
      roomId: 'hands-on',
      name: 'Hands on',
      session: { id: 's-31', title: 'Atelier Kubernetes', startsAt: '2026-10-30T10:00:00.000Z', speakers: [] },
      running: true,
    },
  ]

  const SOCIAL = [
    { network: 'Bluesky', handle: '@cloudnord.fr', url: 'https://bsky.app/profile/cloudnord.fr' },
  ]

  const SPONSORS = [{ id: 't1', name: 'Gold', order: 1, sponsors: [{ id: 's1', name: 'Clever Cloud', website: null, logoUrl: null }] }]

  const inLoop = (patch: Record<string, unknown> = {}) =>
    ({
      ...STATE,
      state: { ...STATE.state, mode: 'loop' },
      sponsorTiers: SPONSORS,
      otherRooms: OTHERS,
      socialLinks: SOCIAL,
      ...patch,
    }) as unknown as DisplayPayload

  beforeEach(stubTimers)
  afterEach(restoreTimers)

  it('opens on the sponsors', () => {
    mountScreen(inLoop())

    expect(content().textContent).toContain('Nos partenaires')
    expect(content().textContent).toContain('Clever Cloud')
  })

  it('chains the pages by itself', () => {
    mountScreen(inLoop())

    // Sponsors 12 s, then the program.
    advance(13)
    expect(alive().textContent).toContain('Programme de la salle')

    // Then the other rooms, then the social accounts.
    advance(16)
    expect(alive().textContent).toContain('Pendant ce temps')
    advance(13)
    expect(alive().textContent).toContain('Suivez Cloud Nord')
  })

  it('carries the hashtag in clear, with X\'s button loaded or not', () => {
    /*
     * The button's script lives at `platform.x.com`: a room cut off from the
     * Internet will never have it, and that is the case this page is built for.
     * What is read from the back of the room — the hashtag in large type — must
     * therefore depend on nothing.
     */
    mountScreen(inLoop())
    advance(13 + 16 + 13)

    expect(alive().textContent).toContain('#CloudNord')
    // The official anchor is indeed placed: it is the one `widgets.js` replaces
    // with its iframe when it manages to load.
    const button = alive().querySelector('a.twitter-hashtag-button')
    expect(button?.getAttribute('href')).toContain('button_hashtag=CloudNord')
    expect(button?.getAttribute('data-related')).toBe('@Cloud_Nord')
  })

  it('does not open the social page on the hashtag card alone', () => {
    // The loop's rule does not change: a page with no content is skipped. The
    // hashtag accompanies the accounts, it does not make a page on its own.
    mountScreen(inLoop({ socialLinks: [] }))
    advance(13 + 16 + 13)

    expect(alive().textContent).not.toContain('#CloudNord')
  })

  it('comes back to the beginning after the last screen', () => {
    mountScreen(inLoop())
    advance(13 + 16 + 13 + 11)

    expect(alive().textContent).toContain('Nos partenaires')
  })

  it('skips the pages with nothing to show', () => {
    // With no sponsors and no social accounts, the loop must not stop twelve
    // seconds on an empty frame: it shrinks to what exists.
    mountScreen(inLoop({ sponsorTiers: [], socialLinks: [] }))

    expect(alive().textContent).toContain('Programme de la salle')
    advance(16)
    expect(alive().textContent).toContain('Pendant ce temps')
    advance(13)
    expect(alive().textContent).toContain('Programme de la salle')
  })

  it('says what is going on next door, and at what time', () => {
    mountScreen(inLoop())
    advance(13 + 16)

    const text = alive().textContent ?? ''
    expect(text).toContain('Track #2')
    expect(text).toContain('Au-dessus de la mêlée')
    // 11:00 UTC = 12:00 in Paris, in the event's timezone.
    expect(text).toContain('12:00')
    // A room whose talk has already started does not announce a past time.
    expect(text).toContain('en ce moment')
  })

  it('shows the handle, not the URL', () => {
    // It is the handle one retypes on one's phone from the back of the room; a
    // URL is not something one copies out.
    mountScreen(inLoop())
    advance(13 + 16 + 13)

    expect(alive().textContent).toContain('@cloudnord.fr')
    expect(alive().textContent).not.toContain('https://')
  })

  /**
   * The page transition.
   *
   * Both pages coexist for the length of the switch: the leaving one goes off
   * while the new one comes in. Without it the screen *jumps*, and a jump in
   * front of the room reads as a refresh, not as a continuation.
   *
   * happy-dom finishes no animation, so `animationend` never arrives: what these
   * tests observe is exactly the intermediate state a browser goes through.
   */
  it('crosses the leaving page with the arriving one', () => {
    mountScreen(inLoop())
    advance(13)

    expect(content().querySelectorAll('.layer').length).toBe(2)
    expect(content().querySelector('.leaving')?.textContent).toContain('Nos partenaires')
    expect(alive().textContent).toContain('Programme de la salle')
  })

  it('never stacks two dead layers', () => {
    // The next rewrite carries the previous one away: that is what guarantees
    // three switches do not leave three ghost pages superimposed.
    mountScreen(inLoop())
    advance(13 + 16 + 13)

    expect(content().querySelectorAll('.leaving').length).toBe(1)
  })

  it('aligns the gauge on the displayed page\'s duration', () => {
    // It is the gauge that says *when* it is going to turn: a wrong duration is a
    // marker that lies, worse than no marker at all.
    mountScreen(inLoop())
    const sponsors = content().querySelector('.dot.active') as HTMLElement

    expect(sponsors.style.getPropertyValue('--duration')).toBe('12000ms')

    advance(13)
    const program = alive().querySelector('.dot.active') as HTMLElement
    expect(program.style.getPropertyValue('--duration')).toBe('15000ms')
  })

  /**
   * A page that appears or disappears mid-loop.
   *
   * The index designates a page, not a position in the list of those that have
   * content. Without that, a sync that adds a page — or a last talk ending in
   * another room — shifted everything: the screen changed in the middle of a page,
   * keeping the previous one's deadline, and with no transition since the position
   * itself had not moved.
   *
   * It is a break-time case: exactly when the loop runs in front of the room.
   */
  it('does not change page when another one appears', () => {
    mountScreen(inLoop({ otherRooms: [] }))
    // Sponsors 12 s, program 15 s, then the social accounts — "other rooms" being
    // skipped for want of content.
    advance(13)
    advance(16)
    expect(alive().textContent).toContain('Suivez Cloud Nord')

    // The other rooms come back: the page exists again, but that is no reason to
    // interrupt the one being read.
    stream!.deltas({ otherRooms: OTHERS })

    expect(alive().textContent).toContain('Suivez Cloud Nord')
    expect(alive().textContent).not.toContain('Pendant ce temps')
  })

  it('gives its own duration to the adopted page when its own empties', () => {
    mountScreen(inLoop())
    // Sponsors 12 s, program 15 s: at 28 s we are on "other rooms", displayed for
    // one second, and which must last twelve seconds.
    advance(13)
    advance(15)
    expect(alive().textContent).toContain('Pendant ce temps')

    // The last talk next door ends: the page has nothing left to show. The social
    // accounts take over — with their own ten seconds, not the remainder of the
    // twelve of the page that vanished.
    stream!.deltas({ otherRooms: [] })
    expect(alive().textContent).toContain('Suivez Cloud Nord')

    advance(9)
    expect(alive().textContent).toContain('Suivez Cloud Nord')
    advance(1)
    expect(alive().textContent).toContain('Nos partenaires')
  })

  it('stays workable on a room never synchronized', () => {
    // No program, no sponsors, no social accounts: rather than a black screen, it
    // at least says which event this is.
    mountScreen(inLoop({ sponsorTiers: [], socialLinks: [], otherRooms: [], sessions: [] }))

    expect(content().textContent).toContain('partenaires')
    // And it does not start blinking for want of a page to display.
    advance(30)
    expect(content().textContent).toContain('partenaires')
  })
})

/**
 * The greying of past slots follows the **effective** end.
 *
 * The screen derived it in its own way — `endsAtMs ?? startsAtMs` — and a talk the
 * export bounds only by its duration was greyed out from its start time: the room
 * read "past" on the talk that was being given. It now inlines the same state
 * machine as the control app.
 */
describe('past slots, in the projected program', () => {
  /** The program row carrying this title. */
  const row = (title: string) =>
    [...content().querySelectorAll('article')].find((a) => a.textContent?.includes(title))!

  const greyed = (title: string) => row(title).className.includes('opacity-35')

  it('greys out what is finished, not what is running', () => {
    // The clock is at 10:20: HoneySwamp (10:00–10:45) is being given.
    mountScreen()
    expect(greyed('IA for OPS')).toBe(true)
    expect(greyed('HoneySwamp')).toBe(false)
    expect(greyed('Blind ops')).toBe(false)
  })

  it('holds on a slot bounded only by its duration', () => {
    const byDuration = SESSIONS.map((slot) =>
      slot.id === 's-3'
        ? { ...slot, endsAt: null, endsAtMs: null, durationMinutes: 45 }
        : slot,
    )
    mountScreen({ ...STATE, sessions: byDuration } as unknown as DisplayPayload)

    // 10:20, the talk runs until 10:45: it must not read as past.
    expect(greyed('HoneySwamp')).toBe(false)
    expect(greyed('IA for OPS')).toBe(true)
  })

  it('does not grey out a slot that nothing closes', () => {
    // No end time, no duration, and a next one that does not exist: nobody knows
    // when it finishes, and greying it out would be claiming it is past.
    const open = [
      SESSIONS[0]!,
      { ...SESSIONS[1]!, id: 's-ouvert', title: 'Atelier libre', endsAt: null, endsAtMs: null },
    ]
    mountScreen({ ...STATE, sessions: open } as unknown as DisplayPayload)

    expect(greyed('Atelier libre')).toBe(false)
  })
})
