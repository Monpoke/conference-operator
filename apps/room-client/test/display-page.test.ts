/// <reference lib="dom" />
// The DOM lib is declared here only: adding it to the tsconfig would let the
// server code call `document` without anything objecting.
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flattenLayersInHtml } from '@conference-operator/ui'
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
      stream = {
        deltas: (payload) => this.listeners.patch?.({ data: JSON.stringify({ set: payload, merge: {} }) }),
      }
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
 * The heights a real video projector would give.
 *
 * happy-dom lays nothing out: every measurement comes back at zero, and the page
 * — which is written for that — leaves the list where it is. Supplying the two
 * heights it reads is the only way to observe what it does with a day longer than
 * the screen.
 */
const LAYOUT: { target: object; name: string; descriptor: PropertyDescriptor }[] = []

/**
 * The prototype that really carries the measurement.
 *
 * `clientHeight` and `scrollHeight` do not live on the same one, and redefining
 * the wrong one changes nothing: the real accessor, further down the chain, keeps
 * answering zero.
 */
function owner(name: string): object {
  let target: object | null = HTMLElement.prototype
  while (target && !Object.getOwnPropertyDescriptor(target, name)) target = Object.getPrototypeOf(target)
  return target ?? HTMLElement.prototype
}

function measure(name: string, height: (element: Element) => number): void {
  const target = owner(name)
  LAYOUT.push({
    target,
    name,
    descriptor: Object.getOwnPropertyDescriptor(target, name) ?? { value: 0, configurable: true },
  })
  Object.defineProperty(target, name, {
    configurable: true,
    get(this: Element) {
      return height(this)
    },
  })
}

function stubLayout({ frame, list }: { frame: number; list: number }): void {
  measure('clientHeight', (element) => (element.classList.contains('scroller') ? frame : 0))
  measure('scrollHeight', (element) =>
    element.parentElement?.classList.contains('scroller') ? list : 0)
}

function restoreLayout(): void {
  for (const { target, name, descriptor } of LAYOUT.splice(0)) {
    Object.defineProperty(target, name, descriptor)
  }
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

/** The page marker, which lives in the scene's frame and not in the pages. */
const pager = () => document.getElementById('pager')!
const active = () => pager().querySelector('.dot.active') as HTMLElement

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

  it('walks the whole day rather than stopping at the running slot', () => {
    /*
     * The defect this covers: the screen placed the running talk at the centre
     * and stopped there, so a day longer than the screen was cut off — the room
     * read a program that ended in the middle of the afternoon.
     *
     * happy-dom lays nothing out: the heights are supplied, which is exactly what
     * a real projector would supply. What is checked is the journey the page
     * describes from them — the only thing it decides by itself.
     */
    stubLayout({ frame: 400, list: 1_200 })
    try {
      mountScreen()
      const list = content().querySelector('.scroller')!.firstElementChild as HTMLElement

      expect(list.classList.contains('cycling')).toBe(true)
      // The end of the day is one of the stops, the start of it is the other.
      expect(list.style.getPropertyValue('--end')).toBe('-800px')
      expect(Number.parseInt(list.style.animationDuration, 10)).toBeGreaterThan(0)
    } finally {
      restoreLayout()
    }
  })

  it('stays still when the day fits on the screen', () => {
    // Nothing to travel: a list that moved anyway would be movement for its own
    // sake in front of the room.
    expect(content().querySelector('.scroller')!.firstElementChild!.classList.contains('cycling'))
      .toBe(false)
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
 * The agenda: the same day, in two columns.
 *
 * A second layout for the program, kept alongside the first rather than
 * replacing it — the two are compared on the room's own video projector. It must
 * therefore show exactly the same day, with the same rules, and differ only in
 * form.
 */
describe('agenda screen', () => {
  const inAgenda = (patch: Record<string, unknown> = {}) =>
    ({
      ...STATE,
      state: { ...STATE.state, mode: 'agenda', ...(patch.state as object ?? {}) },
      ...patch,
    }) as unknown as DisplayPayload

  beforeEach(() => {
    mountScreen(inAgenda())
  })

  it('shows the whole day, hour and speakers included', () => {
    // The whole point of the layout: nothing waits for a scroll to be read.
    expect(content().querySelectorAll('article').length).toBe(SESSIONS.length)
    expect(content().textContent).toContain('Accueil')
    expect(content().textContent).toContain('Houston')
    expect(content().textContent).toContain('Agenda')
    expect(content().textContent).toContain('Track #1')
  })

  it('flows in columns rather than scrolling', () => {
    expect(content().querySelector('.agenda-flow')).toBeTruthy()
    expect(content().querySelector('.scroller')).toBeNull()
  })

  it('marks the running talk and greys out what is past', () => {
    // The same three states as the scrolled program: comparing the two screens
    // must compare the layouts, and nothing else.
    const running = content().querySelector('.agenda-running')!
    expect(running.textContent).toContain('HoneySwamp')

    /*
     * Through a filter, not through opacity: the entrance animation ends on
     * `opacity: 1` and keeps it, which erased every utility placed on the same
     * element — the room saw the whole day at the same weight.
     */
    const articles = [...content().querySelectorAll('article')]
    expect(articles[1]!.className).toContain('past')
    expect(articles.at(-1)!.className).not.toContain('past')
  })

  it('says so rather than showing an empty frame', () => {
    mountScreen(inAgenda({ sessions: [] }))

    expect(content().textContent).toContain('Programme indisponible')
  })
})

/**
 * The OpenFeedback QR code.
 *
 * Built offline: OpenFeedback reuses the session identifiers of the upstream
 * export — all 27 match — so the address is derived from the already cached
 * program, with no API key and no network call on the day.
 */
/**
 * The keyboard, on a screen that is set up and then left alone.
 *
 * Whoever plugs the projector in needs the browser's frame gone in one gesture,
 * and needs it back just as fast. The Electron room has its "Écrans" menu; a page
 * opened in a plain browser had nothing.
 */
describe('full screen on F', () => {
  let asked: string[]
  let element: Element | null

  beforeEach(() => {
    asked = []
    element = null
    const root = document.documentElement as unknown as Record<string, unknown>
    root.requestFullscreen = () => { asked.push('enter'); return Promise.resolve() }
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => element,
    })
    ;(document as unknown as Record<string, unknown>).exitFullscreen = () => {
      asked.push('exit')
      return Promise.resolve()
    }
  })

  const press = (key: string, modifiers: Record<string, boolean> = {}): void => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ...modifiers }))
  }

  /**
   * What was asked for, without counting how many times.
   *
   * Every mount replays the page's scripts in the same window, so the suite ends
   * up with one listener per screen mounted before this one — a bench artefact:
   * a real page loads once. What the key does is what matters here, not how many
   * copies of the page heard it.
   */
  const actions = (): string[] => [...new Set(asked)]

  it('goes full screen', () => {
    press('f')

    expect(actions()).toEqual(['enter'])
  })

  it('comes back from it, on the same key', () => {
    element = document.documentElement
    press('f')

    expect(actions()).toEqual(['exit'])
  })

  it('does not mind a caps lock left on', () => {
    press('F')

    expect(actions()).toEqual(['enter'])
  })

  it('leaves Ctrl-F to the browser', () => {
    // Taking the browser's search would be taking something that is not ours.
    press('f', { ctrlKey: true })

    expect(actions()).toEqual([])
  })
})

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

  it('gives the first tier bigger logos than the others', () => {
    // The rank is read from ten metres away, before any name: what the top tier
    // bought is that surface.
    mountScreen(withPartners([
      { ...TIERS[0], sponsors: [{ ...TIERS[0]!.sponsors[0], logoUrl: '/assets/gold' }] },
      { ...TIERS[1], sponsors: [{ ...TIERS[1]!.sponsors[0], logoUrl: '/assets/other' }] },
    ]))

    const [gold, other] = [...alive().querySelectorAll('img[data-logo]')]
      .map((img) => Number((img as HTMLElement).dataset.height))

    expect(gold).toBeGreaterThan(other!)
    // And the fallback height is written inline: a preview rendered without a
    // browser never runs the sizing, and would show logos with no height at all.
    expect(alive().querySelector('img[data-logo]')?.getAttribute('style'))
      .toContain('height:' + gold + 'vmin')
  })

  it('puts a banner and a square at the same surface', () => {
    // Aligned on their height, the banner covered five times the square: the
    // square then reads as small, whereas both were given the same room.
    mountScreen(withPartners([{
      id: 't0', name: 'Gold', order: 0,
      sponsors: [
        { id: 'g1', name: 'Banner', website: null, logoUrl: '/assets/banner' },
        { id: 'g2', name: 'Square', website: null, logoUrl: '/assets/square' },
      ],
    }]))

    const logos = [...alive().querySelectorAll('img[data-logo]')] as HTMLImageElement[]
    const area = (img: HTMLImageElement, width: number, height: number) => {
      // happy-dom has neither canvas nor loader: the natural dimensions are
      // declared, and the load is announced by hand.
      Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true })
      Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true })
      img.dispatchEvent(new Event('load'))
      const rendered = Number.parseFloat(img.style.height)
      return rendered * rendered * (width / height)
    }

    const banner = area(logos[0]!, 500, 100)
    const square = area(logos[1]!, 200, 200)

    // Not to the pixel: the range that keeps a banner from becoming a thread
    // stops short of full equality. A sixth is under what the eye separates.
    expect(Math.abs(banner - square) / square).toBeLessThan(0.16)
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

  // Two parameters on purpose: the `&` between them goes through the html
  // escaping, and an address that came back cut in half would frame nothing.
  const WALLS_IO = 'https://my.walls.io/cloud-nord?token=b58a8dc&lang=fr'

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

    // Sponsors 12 s, then the day — shown as the agenda, the screen one crosses.
    advance(13)
    expect(alive().querySelector('.agenda')).not.toBeNull()

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

  it('shows the whole day rather than a screenful of it', () => {
    /*
     * What the loop used to do: slide the program by one screenful per pass, so
     * the room saw a fragment of the day and had to wait for the loop to come
     * round for the rest. The agenda answers it in one screen — reduced until it
     * fits, never cut.
     *
     * happy-dom lays nothing out, so the reduction itself cannot be observed
     * here; what is checked is that the whole day is on the page, from the first
     * slot to the last.
     */
    mountScreen(inLoop())
    advance(13)

    const text = alive().textContent ?? ''
    expect(alive().querySelectorAll('.agenda-item').length).toBe(SESSIONS.length)
    expect(text).toContain('Accueil')
    expect(text).toContain('Houston')
    // And no scrolling frame: the loop no longer carries a sliding list at all.
    expect(alive().querySelector('.scroller')).toBeNull()
  })

  it('applies the screen\'s own behaviour, and not the loop\'s idea of it', () => {
    /*
     * The defect this covers: the loop rendered the screens but ran its own
     * after-render code, keyed on the state's mode — which says `loop`. The
     * screens therefore behaved in the loop differently from the way they behave
     * when the console calls them up, and the day was the visible victim.
     *
     * `--agenda-scale` is the proof that fitAgenda() ran on this page: it is set
     * from the script, never from the html.
     */
    mountScreen(inLoop())
    advance(13)

    const flow = alive().querySelector('.agenda') as HTMLElement
    expect(flow.style.getPropertyValue('--agenda-scale')).not.toBe('')
  })

  it('comes back to the beginning after the last screen', () => {
    mountScreen(inLoop())
    advance(13 + 16 + 13 + 11)

    expect(alive().textContent).toContain('Nos partenaires')
  })

  it('shows the social wall when the hub has given an address', () => {
    // Last page of the loop, and the only one whose content is drawn by somebody
    // else: what is checked here is that the frame is aimed at the configured
    // address — the wall itself lives at walls.io.
    mountScreen(inLoop({ wallsIoUrl: WALLS_IO }))
    advance(13 + 16 + 13 + 11)

    const frame = alive().querySelector('iframe')
    expect(frame?.getAttribute('src')).toBe(WALLS_IO)
  })

  it('does not open the social page with no address configured', () => {
    // The loop's rule, applied to a screen that would have failed loudly: with no
    // address, framing a 404 in front of the room is worse than not stopping.
    mountScreen(inLoop())
    advance(13 + 16 + 13 + 11)

    expect(alive().querySelector('iframe')).toBeNull()
    // And it came back to the sponsors rather than waiting on an empty page.
    expect(alive().textContent).toContain('Nos partenaires')
  })

  it('skips a screen the hub has withdrawn', () => {
    /*
     * The setting is about what is *offered*, and the loop offers: withdrawing
     * the sponsors on the hub and still seeing them come round every twelve
     * seconds in front of the room would make the setting look broken.
     */
    mountScreen(inLoop({ screensDisabled: ['sponsors'] }))

    expect(alive().textContent).not.toContain('Clever Cloud')
    expect(alive().querySelector('.agenda')).not.toBeNull()
  })

  it('skips the pages with nothing to show', () => {
    // With no sponsors and no social accounts, the loop must not stop twelve
    // seconds on an empty frame: it shrinks to what exists.
    mountScreen(inLoop({ sponsorTiers: [], socialLinks: [] }))

    expect(alive().querySelector('.agenda')).not.toBeNull()
    advance(16)
    expect(alive().textContent).toContain('Pendant ce temps')
    advance(13)
    expect(alive().querySelector('.agenda')).not.toBeNull()
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
    expect(alive().querySelector('.agenda')).not.toBeNull()
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

    expect(active().style.getPropertyValue('--duration')).toBe('12000ms')

    advance(13)
    expect(active().style.getPropertyValue('--duration')).toBe('15000ms')
  })

  it('holds the marker still while the pages slide behind it', () => {
    /*
     * The defect this covers: the marker was rendered inside the page, so it left
     * with it and came back with the next one. The one thing on screen whose job
     * is to say "it turns, and here is when" was also the one thing that
     * disappeared at every turn.
     *
     * Outside the layers, it therefore survives the transition that carries the
     * page away — including the moment when two layers coexist.
     */
    mountScreen(inLoop())
    advance(13)

    expect(content().querySelectorAll('.layer').length).toBe(2)
    // Nothing of the marker inside the pages, neither the leaving one nor the new.
    expect(content().querySelector('.dot')).toBeNull()
    expect(pager().hidden).toBe(false)
    expect(pager().querySelectorAll('.dot').length).toBe(4)
  })

  it('takes the marker away where nothing turns', () => {
    // A marker in front of a screen one sets and leaves would announce a change
    // that never comes.
    mountScreen()

    expect(pager().hidden).toBe(true)
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

  /*
   * Through a filter, not through opacity: the entrance animation ends on
   * `opacity: 1` and keeps it — `both` — so a utility placed on the same element
   * was erased as soon as the row settled, and the room saw the whole day at the
   * same weight.
   */
  const greyed = (title: string) => row(title).className.includes('past')

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
      { ...SESSIONS[1]!, id: 's-open', title: 'Atelier libre', endsAt: null, endsAtMs: null },
    ]
    mountScreen({ ...STATE, sessions: open } as unknown as DisplayPayload)

    expect(greyed('Atelier libre')).toBe(false)
  })
})

describe('social wall', () => {
  const onWall = (patch: Record<string, unknown> = {}) =>
    ({ ...STATE, state: { ...STATE.state, mode: 'wallsio' }, ...patch }) as unknown as DisplayPayload

  it('frames the address the hub configured', () => {
    mountScreen(onWall({ wallsIoUrl: 'https://my.walls.io/cloud-nord?token=b58a8dc&lang=fr' }))

    const frame = content().querySelector('iframe')
    expect(frame?.getAttribute('src')).toBe('https://my.walls.io/cloud-nord?token=b58a8dc&lang=fr')
  })

  it('says so rather than framing nothing', () => {
    /*
     * The screen can be called up from the console before anybody has filled the
     * address in on the hub. An empty frame would read as a wall that is down; the
     * sentence says where to go and fix it.
     */
    mountScreen(onWall())

    expect(content().querySelector('iframe')).toBeNull()
    expect(content().textContent).toContain('Aucun mur configuré')
  })
})
