/// <reference lib="dom" />
// The DOM lib is declared here only: adding it to the tsconfig would let the
// server code call `document` without anything objecting.
// @vitest-environment happy-dom
// @vitest-environment-options {"settings": {"disableIframePageLoading": true}}
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_BOUCLE, type Boucle, type WallCard } from '@conference-operator/contract'
import { agendaForRoom, normalizeProgram, sessionsForRoom, type Session } from '@conference-operator/program'
import { renderProjectorPage } from '../src/core/display-page.js'
import { buildBoucleView } from '../src/core/boucle-view.js'
import { planningsFor } from '@conference-operator/projector/server'
import type { DisplayPayload } from '../src/core/display-server.js'

/**
 * The room screen's behaviour in a real DOM.
 *
 * The page is the reference welcome loop: every scene mounted once, one live at
 * a time. The tests cut the transitions and the entry effects
 * (`window.__BOUCLE__`), which makes every switch immediate and every frame
 * stable; the one-second tick is replayed by hand.
 */
const program = normalizeProgram(
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', '..', 'packages', 'program', 'test', 'fixtures', 'cloudnord-2026.json'), 'utf8'),
  ),
)
const TRACK_1 = 'track-1-teilhard-de-chardin'
const TRACK_2 = 'track-2-mf-1092'
const AT = Date.parse('2026-10-30T10:20:00.000Z') // 11:20 in Paris, mid-talk
const SESSIONS = sessionsForRoom(program, TRACK_1)
const running = SESSIONS.find((s) => s.startsAtMs <= AT && (s.endsAtMs ?? 0) > AT)!
const next = SESSIONS.find((s) => s.startsAtMs > AT)!

const QR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

function boucle(settings: Partial<Boucle> = {}) {
  return buildBoucleView({
    boucle: { ...DEFAULT_BOUCLE, ...settings },
    program,
    openFeedbackProjectId: 'cloud-nord-2026',
    eventShortName: 'Cloud Nord',
    localize: (ref) => ref,
    qr: () => QR,
  })
}

function payload(overrides: Partial<DisplayPayload> = {}, state: Partial<DisplayPayload['state']> = {}): DisplayPayload {
  return {
    state: {
      mode: 'loop',
      message: null,
      liveMessage: null,
      question: null,
      sceneRole: 'HOLD',
      connectivity: 'ONLINE',
      roomId: TRACK_1,
      contentHash: 'h',
      currentSession: running,
      nextSession: next,
      targetSession: running,
      targetIsUpcoming: false,
      pinnedSessionId: null,
      breakBadge: null,
      outboxDepth: 0,
      serverTimeOffsetMs: AT - Date.now(),
      recording: false,
      streaming: false,
      audioInputs: [],
      comments: [],
      sessionStates: {},
      notifications: [],
      ...state,
    },
    roomName: 'Track #1',
    event: program.event,
    eventIdentity: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
    timezone: 'Europe/Paris',
    sessions: SESSIONS,
    sponsorTiers: program.sponsorTiers,
    wall: null,
    feedback: null,
    diagnostics: null,
    pairing: null,
    otherRooms: [],
    socialLinks: [],
    screensDisabled: [],
    boucle: boucle(),
    agenda: agendaForRoom(program, TRACK_1, { nowMs: AT }),
    plannings: [],
    socialWall: [],
    ...overrides,
  } as unknown as DisplayPayload
}

/**
 * The `setInterval`s the page sets, replayed by hand.
 *
 * The loop advances on the page's one-second tick: replaying it ourselves avoids
 * waiting a real minute per test, and the clock offset must **persist** from one
 * call to the next — the page compares against `Date.now()`.
 */
const TIMERS: (() => void)[] = []
const REAL_NOW = Date.now
const REAL_INTERVAL = globalThis.setInterval
const REAL_EVENTSOURCE = globalThis.EventSource
let offset = 0

function advance(seconds: number): void {
  for (let pass = 0; pass < seconds; pass += 1) {
    offset += 1_000
    for (const timer of TIMERS) timer()
  }
}

/** The state stream, simulated: happy-dom does not supply `EventSource`. */
let stream: { deltas: (payload: Record<string, unknown>) => void } | null = null

function stub(): void {
  TIMERS.length = 0
  offset = 0
  stream = null
  globalThis.EventSource = class {
    private listeners: Record<string, (event: { data: string }) => void> = {}
    constructor() {
      stream = {
        deltas: (set) => this.listeners.patch?.({ data: JSON.stringify({ set, merge: {} }) }),
      }
    }
    addEventListener(name: string, fn: (event: { data: string }) => void): void {
      this.listeners[name] = fn
    }
    close(): void {}
  } as unknown as typeof EventSource
  Date.now = () => REAL_NOW.call(Date) + offset
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    if (ms === 1000) TIMERS.push(fn)
    return REAL_INTERVAL(() => {}, 1_000_000) as unknown as number
  }) as typeof setInterval
}

function restore(): void {
  Date.now = REAL_NOW
  globalThis.setInterval = REAL_INTERVAL
  globalThis.EventSource = REAL_EVENTSOURCE
}

/** What the page asked to bring on screen, and how. */
let centred: { element: Element; options: unknown } | null = null

function mount(data: DisplayPayload = payload()): void {
  centred = null
  document.documentElement.innerHTML = renderProjectorPage({ initialPayload: data })
  Element.prototype.scrollIntoView = function (options?: unknown) {
    centred = { element: this as Element, options }
  }
  ;(window as unknown as { __BOUCLE__: unknown }).__BOUCLE__ = { transition: 'cut', effets: false, barreProgression: false }
  // `innerHTML` does not execute the scripts: they are replayed as the browser would.
  for (const script of document.querySelectorAll('script:not([type])')) {
    // eslint-disable-next-line no-new-func
    new Function(script.textContent ?? '')()
  }
}

/** Pushes a whole new state through the stream, as the room's server would. */
const push = (data: DisplayPayload) => stream!.deltas(data as unknown as Record<string, unknown>)

const live = () => document.querySelector<HTMLElement>('.scene.is-live')!
const scene = (id: string) => document.querySelector<HTMLElement>(`[data-scene="${id}"]`)!
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

beforeEach(stub)
afterEach(restore)

describe('the stage', () => {
  it('mounts every scene once, and shows one', () => {
    mount()
    expect(document.querySelectorAll('.scene').length).toBeGreaterThan(20)
    expect(document.querySelectorAll('.scene.is-live')).toHaveLength(1)
  })

  it('lifts the loading screen once the first state is drawn', () => {
    mount()
    expect(document.getElementById('chargement')).toBeNull()
  })

  it('takes its title from the event, not from the binary', () => {
    mount()
    expect(document.title).toBe('Cloud Nord 2026 — écran de salle')
  })

  it('shows the event logo from the loop settings, the program as fallback', () => {
    mount()
    const logo = document.getElementById('logo') as HTMLImageElement
    expect(logo.hidden).toBe(false)
    expect(logo.getAttribute('src')).toBe(program.event.logoUrl)
  })
})

describe('the welcome loop', () => {
  it('opens on the welcome', () => {
    mount()
    expect(live().dataset.scene).toBe('accueil')
    expect(text(scene('accueil').querySelector('.accueil-bienvenue'))).toBe('Bienvenue à')
  })

  it('chains the scenes by itself, each after its own duration', () => {
    mount()
    advance(9)
    expect(live().dataset.scene).toBe('accueil')
    advance(1)
    expect(live().dataset.scene).toBe('agenda')
    advance(20)
    // The breakfast announcement of the reference, offered by APE Factory.
    expect(live().dataset.scene).toBe('annonce-1')
    expect(text(scene('annonce-1').querySelector('[data-titre]'))).toBe('Petit déjeuner')
  })

  it('holds each scene for the duration the hub set for its kind', () => {
    mount(payload({ boucle: boucle({ durees: { accueil: 4, agenda: 30 } }) }))
    advance(4)
    expect(live().dataset.scene).toBe('agenda')
    advance(29)
    expect(live().dataset.scene).toBe('agenda')
    advance(1)
    expect(live().dataset.scene).toBe('annonce-1')
  })

  it('holds a sponsor page for its own duration, the others for the common one', () => {
    const pages = [
      { titre: '', duree: 3, rangs: [{ taille: 1, logos: [{ sponsor: 'Zenika', nom: 'Zenika', logo: null, echelle: 0.7 }] }] },
      { titre: 'Deux', duree: null, rangs: [{ taille: 1, logos: [{ sponsor: 'MTG', nom: 'MTG', logo: null, echelle: 0.7 }] }] },
    ]
    mount(payload({ boucle: boucle({ sponsorPages: pages, annonces: [] }) }))
    advance(10 + 20 + 6)
    expect(live().dataset.scene).toBe('sponsors-1')
    advance(3)
    expect(live().dataset.scene).toBe('sponsors-2')
    advance(7)
    expect(live().dataset.scene).toBe('sponsors-2')
    advance(1)
    expect(live().dataset.scene).not.toBe('sponsors-2')
  })

  it('shows the other rooms\' days after this one\'s, each for its own time', () => {
    const plannings = planningsFor(program, TRACK_1, { ...DEFAULT_BOUCLE, plannings: { 'hands-on': { afficher: true, duree: 5 } } }, AT)
    mount(payload({ plannings }))
    advance(10 + 20)
    expect(live().dataset.scene).toBe('planning-1')
    expect(text(live().querySelector('[data-titre]'))).toBe('Track #2 - MF 1092')
    expect(live().querySelector<HTMLElement>('[data-ici]')!.hidden).toBe(true)
    advance(15)
    expect(live().dataset.scene).toBe('planning-2')
    advance(5)
    expect(live().dataset.scene).toBe('annonce-1')
  })

  it('leaves this room\'s own sessions out of the other rooms\' days, breaks aside', () => {
    const early = Date.parse('2026-10-30T07:00:00Z')
    const plannings = planningsFor(program, TRACK_1, DEFAULT_BOUCLE, early)
    const track2 = plannings.find((p) => p.roomId === TRACK_2)!
    const titles = track2.agenda.map((e) => e.title)
    // The keynote happens here, in Track #1: it is on this room's agenda, not Track #2's.
    expect(titles).not.toContain("Keynote d'ouverture")
    expect(titles).toContain('Déjeuner')
  })

  it('turns, on the global screen, through every room\'s day and announces the next talk anywhere', () => {
    const early = Date.parse('2026-10-30T07:40:00Z')
    mount(payload(
      {
        roomName: null,
        agenda: [],
        plannings: planningsFor(program, null, DEFAULT_BOUCLE, early),
      },
      { roomId: null, serverTimeOffsetMs: early - Date.now() },
    ))
    advance(10)
    expect(live().dataset.scene).toBe('planning-1')
    expect(text(live().querySelector('[data-titre]'))).toBe('Track #1 - Teilhard de Chardin')
    // The keynote, next anywhere, with the room it happens in.
    expect(text(document.querySelector('[data-bb-titre]'))).toBe("Keynote d'ouverture")
    expect(text(document.querySelector('[data-bb-salle]'))).toBe('Track #1 - Teilhard de Chardin')
    expect(text(scene('salles').querySelector('[data-titre]'))).toBe('En ce moment dans les salles')
  })

  it('skips « Pendant ce temps » where the other rooms\' days are shown', () => {
    const otherRooms = [{
      roomId: TRACK_2, name: 'Track #2', running: true,
      session: { id: 's', title: 'Un talk', startsAt: '2026-10-30T10:00:00Z', speakers: [] },
    }]
    const etat = () => (window as unknown as { boucle: { etat: () => { scenes: { scene: string; jouable: boolean }[] } } })
      .boucle.etat().scenes.find((s) => s.scene === 'salles')!.jouable
    mount(payload({ otherRooms, plannings: [] }))
    expect(etat()).toBe(true)
    mount(payload({ otherRooms, plannings: planningsFor(program, TRACK_1, DEFAULT_BOUCLE, AT) }))
    expect(etat()).toBe(false)
  })

  it('keeps the phones message off the global screen', () => {
    const etat = () => (window as unknown as { boucle: { etat: () => { scenes: { scene: string; jouable: boolean }[] } } })
      .boucle.etat().scenes.find((s) => s.scene === 'message-silence')!.jouable
    mount()
    expect(etat()).toBe(true)
    mount(payload({ roomName: null, agenda: [] }, { roomId: null }))
    expect(etat()).toBe(false)
  })

  it('withdraws the agenda\'s reminder on its own, or with the agenda', () => {
    const jouable = (scene: string) => (window as unknown as { boucle: { etat: () => { scenes: { scene: string; jouable: boolean }[] } } })
      .boucle.etat().scenes.find((s) => s.scene === scene)!.jouable
    mount(payload({ screensDisabled: ['agenda-reminder'] }))
    expect(jouable('agenda')).toBe(true)
    expect(jouable('agenda-rappel')).toBe(false)
    mount(payload({ screensDisabled: ['agenda'] }))
    expect(jouable('agenda-rappel')).toBe(false)
  })

  it('says « Vous êtes ici » on this room\'s own day only', () => {
    mount()
    expect(scene('agenda').querySelector<HTMLElement>('[data-ici]')!.hidden).toBe(false)
    expect(scene('agenda-rappel').querySelector<HTMLElement>('[data-ici]')!.hidden).toBe(false)
  })

  it('skips the other rooms\' days when the hub withdrew them', () => {
    mount(payload({ plannings: planningsFor(program, TRACK_1, DEFAULT_BOUCLE, AT), screensDisabled: ['other-agendas'] }))
    advance(10 + 20)
    expect(live().dataset.scene).toBe('annonce-1')
  })

  it('skips the slots with nothing to show', () => {
    mount()
    advance(10 + 20 + 8)
    // Three empty announcement slots, straight to the thanks.
    expect(live().dataset.scene).toBe('merci')
  })

  it('skips a scene the hub has withdrawn', () => {
    mount(payload({ screensDisabled: ['agenda', 'announcements'] }))
    advance(10)
    expect(live().dataset.scene).toBe('merci')
  })

  it('skips the social wall while nobody has written anything', () => {
    mount()
    const ids = (window as unknown as { boucle: { etat: () => { scenes: { scene: string; jouable: boolean }[] } } })
      .boucle.etat().scenes
    expect(ids.find((s) => s.scene === 'wallsio')?.jouable).toBe(false)
    expect(ids.find((s) => s.scene === 'sponsors-1')?.jouable).toBe(true)
  })

  it('comes back to the welcome after the last scene', () => {
    mount()
    for (let i = 0; i < 400 && live().dataset.scene !== 'feedbacks'; i += 1) advance(1)
    expect(live().dataset.scene).toBe('feedbacks')
    advance(10)
    expect(live().dataset.scene).toBe('accueil')
  })

  it('restarts at the welcome when the operator gives the screen back', () => {
    mount()
    advance(10)
    expect(live().dataset.scene).toBe('agenda')
    push(payload({}, { mode: 'programme' }))
    expect(live().dataset.scene).toBe('programme')
    push(payload({}, { mode: 'loop' }))
    expect(live().dataset.scene).toBe('accueil')
  })

  it('never rebuilds the scene on screen: the change waits for it to leave', () => {
    mount()
    advance(10)
    expect(live().dataset.scene).toBe('agenda')
    const before = text(scene('agenda').querySelector('[data-titre]'))
    push(payload({ roomName: 'Salle renommée' }))
    expect(text(scene('agenda').querySelector('[data-titre]'))).toBe(before)
    advance(20)
    expect(text(scene('agenda').querySelector('[data-titre]'))).toBe('Salle renommée')
  })

  it('rebuilds a scene that is off screen straight away', () => {
    mount()
    const messages = { ...DEFAULT_BOUCLE.messages, bienvenue: { texte: 'Salut !', sousTitre: '', effet: 'claque' as const } }
    push(payload({ boucle: boucle({ messages }) }))
    expect(text(scene('message-bienvenue').querySelector('[data-texte-message]'))).toBe('Salut !')
  })

  it('writes the signature on the scenes that carry it', () => {
    mount()
    expect(text(scene('merci').querySelector('.signature'))).toBe('Cloud Nord')
    expect(scene('agenda').querySelector('.signature')).toBeNull()
  })
})

describe('agenda', () => {
  it('shows the room, its day and its speakers', () => {
    mount(payload({}, { mode: 'agenda' }))
    expect(live().dataset.scene).toBe('agenda')
    expect(text(live().querySelector('[data-titre]'))).toBe('Track #1')
    expect(text(live())).toContain('HoneySwamp')
    expect(text(live())).toContain('Steven LE ROUX (Clever Cloud)')
  })

  it('lets finished sessions go, and marks the running one', () => {
    mount(payload({}, { mode: 'agenda' }))
    const rows = [...live().querySelectorAll('.seance')]
    expect(text(rows[0]!)).toContain('HoneySwamp')
    expect(rows[0]!.classList.contains('est-encours')).toBe(true)
    expect(text(live())).not.toContain('IA for OPS')
  })

  it('keeps the whole day when the setting says so', () => {
    const agenda = { masquerTerminees: false }
    mount(payload({ boucle: boucle({ agenda }) }, { mode: 'agenda' }))
    expect(text(live())).toContain('IA for OPS')
    expect(live().querySelector('.seance.est-passee')).not.toBeNull()
  })

  it('keeps the opening keynote off the screens of the rooms that do not host it', () => {
    const early = Date.parse('2026-10-30T07:00:00Z')
    mount(payload(
      { roomName: 'Track #2', agenda: agendaForRoom(program, TRACK_2, { nowMs: early }) },
      { mode: 'agenda', serverTimeOffsetMs: early - Date.now() },
    ))
    expect(text(live())).not.toContain("Keynote d'ouverture")
  })

  it('writes the shared breaks as breaks, the keynote as a talk', () => {
    const agenda = { masquerTerminees: false }
    mount(payload({ boucle: boucle({ agenda }) }, { mode: 'agenda' }))
    const rows = [...live().querySelectorAll('.seance')]
    const pause = (title: string) => rows.find((row) => text(row).includes(title))!.classList.contains('est-pause')
    for (const title of ['Accueil et petit déjeuner', 'Pause croissants', 'Déjeuner', 'Pause café', 'Apéro Networking']) {
      expect(pause(title), title).toBe(true)
    }
    expect(pause("Keynote d'ouverture")).toBe(false)
  })

  it('shows one clock: the band\'s, or the scene\'s when the band is off', () => {
    mount(payload({}, { mode: 'agenda' }))
    expect(document.body.classList.contains('sans-barre-bas')).toBe(false)
    const barreBas = { ...DEFAULT_BOUCLE.barreBas, afficher: false }
    mount(payload({ boucle: boucle({ barreBas }) }, { mode: 'agenda' }))
    expect(document.body.classList.contains('sans-barre-bas')).toBe(true)
  })

  it('says so rather than showing an empty frame', () => {
    mount(payload({ agenda: [] }, { mode: 'agenda' }))
    expect(live().querySelector<HTMLElement>('.vide')!.hidden).toBe(false)
  })
})

describe('bottom band', () => {
  it('announces the room\'s next talk and the time', () => {
    mount()
    expect(text(document.querySelector('[data-bb-titre]'))).toBe(next.title)
    expect(text(document.querySelector('[data-bb-hashtag]'))).toBe('#CloudNord2026')
    expect(text(document.querySelector('[data-bb-horloge]'))).toBe('11:20')
  })

  it('leaves when the setting takes it away', () => {
    const barreBas = { ...DEFAULT_BOUCLE.barreBas, afficher: false }
    mount(payload({ boucle: boucle({ barreBas }) }))
    expect(document.getElementById('barre-bas')!.hidden).toBe(true)
  })
})

describe('break badge', () => {
  it('says nothing during a talk', () => {
    mount()
    expect(document.getElementById('break-badge')!.hidden).toBe(true)
  })

  it('announces the running break', () => {
    mount(payload({}, { breakBadge: { state: 'en-cours', title: 'Déjeuner', startsAt: '2026-10-30T11:15:00Z' } }))
    const badge = document.getElementById('break-badge')!
    expect(badge.hidden).toBe(false)
    expect(badge.textContent).toBe('Pause')
  })

  it('announces it ahead, while the talk is still finishing', () => {
    mount(payload({}, { breakBadge: { state: 'a-venir', title: 'Déjeuner', startsAt: '2026-10-30T11:15:00Z' } }))
    const badge = document.getElementById('break-badge')!
    expect(badge.textContent).toBe('Pause à venir')
    expect(badge.classList.contains('a-venir')).toBe(true)
  })
})

describe('projected program', () => {
  const programme = (state: Partial<DisplayPayload['state']> = {}) => mount(payload({}, { mode: 'programme', ...state }))

  it('still displays the whole day', () => {
    programme()
    expect(live().querySelectorAll('.seance')).toHaveLength(SESSIONS.length)
  })

  it('brings the running talk to the centre of the screen', () => {
    programme()
    expect(text(centred?.element ?? null)).toContain('HoneySwamp')
    expect(live().querySelectorAll('.anchor')).toHaveLength(1)
  })

  it('aims at the next one between two talks', () => {
    programme({ currentSession: null })
    expect(text(live().querySelector('.anchor'))).toContain(next.title)
  })

  it('greys out what is finished, not what is running', () => {
    programme()
    const rows = [...live().querySelectorAll('.seance')]
    const past = rows.filter((row) => row.classList.contains('est-passee')).map(text)
    expect(past.some((row) => row.includes('IA for OPS'))).toBe(true)
    expect(past.some((row) => row.includes('HoneySwamp'))).toBe(false)
  })

  it('holds on a slot bounded only by its duration', () => {
    const bounded: Session[] = SESSIONS.map((s) =>
      s.id === running.id ? { ...s, endsAt: null, endsAtMs: null, durationMinutes: 50 } : s)
    mount(payload({ sessions: bounded }, { mode: 'programme' }))
    const row = [...live().querySelectorAll('.seance')].find((r) => text(r).includes('HoneySwamp'))!
    expect(row.classList.contains('est-passee')).toBe(false)
  })

  it('does not grey out a slot that nothing closes', () => {
    const last = SESSIONS[SESSIONS.length - 1]!
    const open: Session[] = SESSIONS.map((s) =>
      s.id === last.id ? { ...s, endsAt: null, endsAtMs: null, durationMinutes: null } : s)
    mount(payload({ sessions: open }, { mode: 'programme', serverTimeOffsetMs: Date.parse('2026-10-30T23:00:00Z') - Date.now() }))
    const row = [...live().querySelectorAll('.seance')].at(-1)!
    expect(row.classList.contains('est-passee')).toBe(false)
  })
})

describe('countdown', () => {
  const countdown = () => mount(payload({}, { mode: 'countdown', currentSession: null }))

  it('announces the talk we resume on', () => {
    countdown()
    expect(text(live().querySelector('.decompte-reprise'))).toBe(`Reprise — ${next.title}`)
  })

  it('updates the digits without rebuilding the block', () => {
    countdown()
    const digits = live().querySelector('.decompte-chiffres')!
    advance(1)
    const first = text(digits)
    advance(1)
    expect(live().querySelector('.decompte-chiffres')).toBe(digits)
    expect(text(digits)).not.toBe(first)
    expect(text(digits)).toMatch(/^\d\d:\d\d$/)
  })

  it('says so when the day is over', () => {
    mount(payload({}, { mode: 'countdown', currentSession: null, nextSession: null }))
    expect(text(live().querySelector('.decompte-titre'))).toBe('Fin des interventions')
  })
})

describe('the "rate the talk" screen', () => {
  it('displays the QR code and the talk\'s title', () => {
    mount(payload({ feedback: { url: 'https://openfeedback.io/x', qrSvg: QR } }, { mode: 'feedback' }))
    expect(live().querySelector('.qr svg')).not.toBeNull()
    expect(text(live().querySelector('.avis-talk'))).toContain('HoneySwamp')
  })

  it('says so rather than showing an empty frame', () => {
    mount(payload({}, { mode: 'feedback' }))
    expect(live().querySelector<HTMLElement>('.vide')!.hidden).toBe(false)
  })
})

describe('the "audience question" screen', () => {
  it('projects the question chosen in the control app', () => {
    mount(payload({}, { mode: 'question', question: { text: 'Et les faux positifs ?', author: 'Camille', sessionId: null } }))
    expect(text(live().querySelector('.question-texte'))).toBe('Et les faux positifs ?')
    expect(text(live().querySelector('.question-auteur'))).toBe('Camille')
  })

  it('follows a new question in place', () => {
    mount(payload({}, { mode: 'question', question: { text: 'Première', author: null, sessionId: null } }))
    push(payload({}, { mode: 'question', question: { text: 'Seconde', author: null, sessionId: null } }))
    expect(text(live().querySelector('.question-texte'))).toBe('Seconde')
  })

  it('does not take the console banner for a question', () => {
    mount(payload({}, {
      mode: 'question',
      liveMessage: { text: 'Reprise dans 5 minutes', level: 'info', expiresAtMs: null },
    }))
    expect(text(live())).not.toContain('Reprise dans 5 minutes')
    expect(live().querySelector<HTMLElement>('.vide')!.hidden).toBe(false)
  })
})

describe('the console message', () => {
  it('fills the stage, in red when urgent', () => {
    mount(payload({}, {
      mode: 'message',
      message: { text: 'Évacuation', level: 'urgent', expiresAtMs: null },
    }))
    expect(text(live().querySelector('.message-texte'))).toBe('Évacuation')
    expect(live().querySelector('.message')!.classList.contains('urgent')).toBe(true)
  })
})

describe('on air', () => {
  it('goes black and hands the room over to the video', () => {
    mount()
    push(payload({}, { mode: 'live' }))
    expect(document.body.dataset.mode).toBe('live')
    expect(live().dataset.scene).toBe('direct')
  })
})

describe('the social wall', () => {
  const card = (id: string, extra: Partial<WallCard> = {}): WallCard => ({
    id,
    source: 'wallsio',
    author: `Auteur ${id}`,
    authorSubtitle: null,
    avatarUrl: null,
    text: `Post ${id} #CloudNord2026`,
    imageUrl: null,
    network: 'Instagram',
    postedAt: new Date(AT - 10 * 60_000).toISOString(),
    featured: false,
    sponsor: null,
    ...extra,
  })
  const wall = [
    card('a', { featured: true }),
    card('p', { featured: true, source: 'hub', sponsor: { name: 'APE Factory', logoUrl: '/assets/logo' } }),
    card('b', { imageUrl: '/assets/photo-b' }),
    card('c', { source: 'form', network: 'Sur place' }),
  ]
  const noms = (el: Element) => [...el.querySelectorAll('.carte-nom')].map((n) => text(n))

  it('leads each page with a featured post, in its own column', () => {
    mount(payload({ socialWall: wall }, { mode: 'wallsio' }))
    const avant = live().querySelector('.mur-avant')!
    expect(noms(avant)).toEqual(['Auteur a'])
    expect(avant.querySelector('.carte')!.classList.contains('en-avant')).toBe(true)
    expect(live().querySelector<HTMLElement>('.vide')!.hidden).toBe(true)
  })

  it('says a partner is a partner', () => {
    mount(payload({ socialWall: [wall[1]!] }, { mode: 'wallsio' }))
    const partenaire = live().querySelector('.carte.partenaire')!
    expect(text(partenaire.querySelector('.badge-partenaire'))).toBe('Partenaire')
    expect(partenaire.querySelector('.carte-sponsor img')!.getAttribute('src')).toBe('/assets/logo')
  })

  it('draws with the room\'s images only, initials when there is none', () => {
    mount(payload({ socialWall: wall }, { mode: 'wallsio' }))
    for (const img of live().querySelectorAll('img')) expect(img.getAttribute('src')).toMatch(/^\/assets\//)
    expect(live().querySelector('.avatar')!.textContent).toBe('AA')
  })

  it('turns to the next featured post when held on screen', () => {
    mount(payload({ socialWall: wall }, { mode: 'wallsio' }))
    expect(noms(live().querySelector('.mur-avant')!)).toEqual(['Auteur a'])
    // The page's time (25 s), then the tick that redraws it.
    advance(27)
    expect(noms(live().querySelector('.mur-avant')!)).toEqual(['Auteur p'])
  })

  it('is played by the loop only when it has posts', () => {
    mount(payload({ socialWall: wall }))
    const etat = (window as unknown as { boucle: { etat: () => { scenes: { scene: string; jouable: boolean }[] } } }).boucle.etat()
    expect(etat.scenes.find((s) => s.scene === 'wallsio')?.jouable).toBe(true)
  })

  it('says so rather than showing an empty frame', () => {
    mount(payload({}, { mode: 'wallsio' }))
    expect(live().querySelector<HTMLElement>('.vide')!.hidden).toBe(false)
  })
})

describe('full screen on F', () => {
  let requested = 0
  let exited = 0
  const key = (init: KeyboardEventInit) => dispatchEvent(new KeyboardEvent('keydown', init))

  beforeEach(() => {
    requested = 0
    exited = 0
    mount()
    document.documentElement.requestFullscreen = (() => {
      requested += 1
      return Promise.resolve()
    }) as never
    document.exitFullscreen = (() => {
      exited += 1
      return Promise.resolve()
    }) as never
  })

  afterEach(() => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null })
  })

  it('goes full screen', () => {
    key({ key: 'f' })
    expect(requested).toBe(1)
  })

  it('comes back from it, on the same key', () => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.documentElement })
    key({ key: 'f' })
    expect(exited).toBe(1)
  })

  it('does not mind a caps lock left on', () => {
    key({ key: 'F' })
    expect(requested).toBe(1)
  })

  it('leaves Ctrl-F to the browser', () => {
    key({ key: 'f', ctrlKey: true })
    expect(requested).toBe(0)
  })
})

describe('keys of the control panel', () => {
  it('moves to the next scene on the right arrow, and pauses on space', () => {
    mount()
    dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    expect(live().dataset.scene).toBe('agenda')
    dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
    advance(60)
    expect(live().dataset.scene).toBe('agenda')
  })

  it('opens the panel on H', () => {
    mount()
    dispatchEvent(new KeyboardEvent('keydown', { key: 'h' }))
    expect(document.getElementById('hud')!.hidden).toBe(false)
    expect(document.querySelectorAll('#hud li').length).toBeGreaterThan(10)
  })
})
