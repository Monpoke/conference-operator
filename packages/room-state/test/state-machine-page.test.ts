/// <reference lib="dom" />
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { renderStateMachinePage, type RoomPreview } from '../src/state-machine-page.js'

/**
 * The test bench, run in a real DOM.
 *
 * The page has no build step: without this level of testing only its syntax is
 * checked, and a button that does not react goes unnoticed until the moment you
 * were counting on it to understand a fault.
 *
 * The program here is deliberately tiny and hand-written: what we check is that
 * the page really calls the state machine and obeys it, not that the state
 * machine is right — that is the job of `state.test.ts`.
 */
const START = Date.parse('2026-10-30T09:00:00Z')
const MIN = 60_000

const ROOM: RoomPreview = {
  id: 'salle-1',
  name: 'Track #1',
  slots: [
    {
      id: 'accueil',
      title: 'Accueil',
      kind: 'break',
      startsAt: new Date(START).toISOString(),
      startsAtMs: START,
      endsAt: new Date(START + 30 * MIN).toISOString(),
      endsAtMs: START + 30 * MIN,
      durationMinutes: 30,
    },
    {
      id: 'talk',
      title: 'Un talk',
      kind: 'talk',
      startsAt: new Date(START + 30 * MIN).toISOString(),
      startsAtMs: START + 30 * MIN,
      endsAt: new Date(START + 80 * MIN).toISOString(),
      endsAtMs: START + 80 * MIN,
      durationMinutes: 50,
    },
  ],
}

const $ = (id: string) => document.getElementById(id)!
const word = () => $('word').textContent
const button = (id: string) => $(id) as HTMLButtonElement

/** Sets the simulated clock, in minutes after the start of the program. */
function at(minutes: number): void {
  const scrubber = $('scrubber') as HTMLInputElement
  // The scrubber covers the whole day, bounds included: we aim through the date
  // input, which is the only exact way to designate an instant.
  const field = $('clock') as HTMLInputElement
  const target = new Date(START + minutes * MIN)
  const local = new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Europe/Paris', hour12: false,
  }).format(target)
  field.value = local.replace(' ', 'T')
  field.dispatchEvent(new Event('change'))
  void scrubber
}

function mount(room: RoomPreview = ROOM): void {
  document.documentElement.innerHTML = renderStateMachinePage({
    rooms: [room],
    timezone: 'Europe/Paris',
    startAt: START,
  })
  for (const script of document.querySelectorAll('script:not([type])')) {
    // `innerHTML` does not execute <script> tags: we replay them by hand.
    new Function(script.textContent ?? '')()
  }
}

beforeEach(() => mount())

describe('state machine test bench', () => {
  it('opens on the state the machine reports, not on a hard-coded value', () => {
    // 09:00 UTC: the welcome slot is running, and a welcome slot is a break.
    expect(word()).toBe('rien dans la salle')
    expect($('dot').className).toContain('hors')
  })

  it('follows the simulated clock', () => {
    at(31)
    expect(word()).toBe('pas commencée')
    at(36)
    expect(word()).toBe('retard au démarrage')
  })

  it('starts and ends with the same gestures as the control app', () => {
    at(31)
    button('start').click()
    expect(word()).toBe('en cours')

    at(76)
    expect(word()).toBe('vers la fin')

    button('end').click()
    expect(word()).toBe('terminée en avance')
  })

  it('refuses what the table refuses, and says why', () => {
    at(31)
    expect(button('end').disabled).toBe(true)
    expect(button('end').title).toContain("n'a pas été lancée")

    button('start').click()
    expect(button('start').disabled).toBe(true)
    expect(button('start').title).toContain('déjà lancée')
  })

  it('shows the overrun, then the automatic close that lifts it', () => {
    at(31)
    button('start').click()

    // The slot ends at +80; past that time, the room overruns.
    at(82)
    expect(word()).toBe('dépassement')

    // Grace is five minutes: at +86, the scheduling rule has closed it.
    at(86)
    expect(word()).not.toBe('dépassement')
    expect($('log').textContent).toContain('clôture automatique')
  })

  it('keeps the overrun when the rule is switched off — that is what you came to see', () => {
    at(31)
    button('start').click()
    const enabled = $('auto-enabled') as HTMLInputElement
    enabled.checked = false
    enabled.dispatchEvent(new Event('change'))

    at(200)
    // The overrun wins over any later slot: the room does not return to a neutral
    // state on its own as long as nobody closes it.
    expect(word()).toBe('dépassement')
  })

  it('also closes on a derived end, with no explicit end time', () => {
    /**
     * The case that left a room red all day long.
     *
     * The scheduling rule required `endsAt` where the overrun made do with a
     * derived end: a slot whose export only gives a start time overran without
     * the sweep ever seeing it go by. Both now read the same end.
     */
    const noEnd = $('no-end') as HTMLInputElement
    noEnd.checked = true
    noEnd.dispatchEvent(new Event('change'))

    at(31)
    button('start').click()
    at(82)
    expect(word()).toBe('dépassement')

    at(86)
    expect(word()).not.toBe('dépassement')
    expect($('log').textContent).toContain('clôture automatique')
  })

  it('leaves open what no rule closes — and rightly so', () => {
    // Last slot of the day, with no end time and no duration: nobody knows when
    // it finishes. Closing it would mean inventing a time.
    mount({
      id: 'salle-ouverte',
      name: 'Salle ouverte',
      slots: [
        {
          id: 'sans-fin-du-tout',
          title: 'Atelier libre',
          kind: 'talk',
          startsAt: new Date(START).toISOString(),
          startsAtMs: START,
          endsAt: null,
          endsAtMs: null,
          durationMinutes: null,
        },
      ],
    })

    at(1)
    button('start').click()
    at(600)

    expect(word()).toBe('en cours')
    expect($('log').textContent).not.toContain('clôture automatique')
  })

  it('resets the day', () => {
    at(31)
    button('start').click()
    at(82)
    expect(word()).toBe('dépassement')

    button('replay').click()
    expect(word()).toBe('hors créneau')
    expect($('log').textContent).toContain('journée remise à zéro')
  })

  /**
   * The case of the keynote with no announced speaker.
   *
   * The normalizer has a single signal to decide on — a slot with no speaker is a
   * break — and it gets it wrong both ways. A keynote whose speaker is not
   * announced yet passes for lunch, and the room reads "rien dans la salle" at
   * the exact moment the audience is settling in. The state machine is not at
   * fault: it receives a break and says so. The fix is the slot override, and
   * that is what we check here.
   */
  describe('slot kind override', () => {
    const shownKind = () =>
      ($('slots').querySelector('[data-kind="accueil"]') as HTMLButtonElement).textContent

    it('reads a slot with no speaker as a break', () => {
      at(1)
      expect(word()).toBe('rien dans la salle')
      expect(shownKind()).toBe('break')
    })

    it('declares it a talk, and the room changes state', () => {
      at(1)
      ;($('slots').querySelector('[data-kind="accueil"]') as HTMLButtonElement).click()

      expect(shownKind()).toContain('talk')
      expect(word()).toBe('pas commencée')
      expect($('log').textContent).toContain('surcharge')
    })

    it('becomes a delay five minutes later, like a real talk', () => {
      ;($('slots').querySelector('[data-kind="accueil"]') as HTMLButtonElement).click()
      at(6)
      expect(word()).toBe('retard au démarrage')
    })

    it('goes back to the original kind on a second click', () => {
      const toggle = () =>
        ($('slots').querySelector('[data-kind="accueil"]') as HTMLButtonElement).click()
      at(1)
      toggle()
      toggle()
      expect(shownKind()).toBe('break')
      expect(word()).toBe('rien dans la salle')
    })

    it('survives "Rejouer la journée" — it is the program, not a decision', () => {
      at(1)
      ;($('slots').querySelector('[data-kind="accueil"]') as HTMLButtonElement).click()
      button('replay').click()
      at(1)
      expect(shownKind()).toContain('talk')
    })
  })

  /**
   * Winding the clock back undoes what had not happened yet.
   *
   * The bench used to keep its decisions undated: ending a talk at 09:05 then
   * going back to 08:59 left the room "ended" on a slot nobody had touched at
   * that hour. The hub has always filtered those decisions on read — it was the
   * page that did not, so it lied precisely where you came to consult it.
   */
  describe('clock wound back', () => {
    it('ignores a decision dated after the instant being looked at', () => {
      at(31)
      button('start').click()
      expect(word()).toBe('en cours')

      // The scheduling rule closes at +85 (end +80, grace 5).
      at(86)
      expect($('log').textContent).toContain('clôture automatique')

      // We go back before: neither the start nor the close has happened yet.
      at(40)
      expect(word()).toBe('retard au démarrage')
    })

    it('finds the day where it was left when winding forward again', () => {
      // We filter on read, we do not erase: that is what allows going back and
      // forth without rebuilding the day each time.
      at(31)
      button('start').click()
      at(86)
      at(40)
      at(86)

      expect(word()).toBe('hors créneau')
      expect($('log').textContent).toContain('clôture automatique')
    })

    it('undoes nothing under a clock that moves forward', () => {
      // Under a real clock no decision is dated in the future: the rule must
      // never be visible.
      at(31)
      button('start').click()
      at(35)
      expect(word()).toBe('en cours')
    })
  })

  it('draws the eight states, with the current one lit', () => {
    const nodes = $('diagram').querySelectorAll('.node')
    expect(nodes).toHaveLength(8)
    expect($('diagram').querySelectorAll('.node.lit')).toHaveLength(1)
  })
})
