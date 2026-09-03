/// <reference lib="dom" />
// The DOM lib is declared here only: adding it to the tsconfig would let the
// server code call `document` without anything objecting.
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flattenLayersInHtml } from '@cloudnord/ui'
import { renderOverlayLivePage } from '../src/core/overlay-live-page.js'
import type { DisplayPayload } from '../src/core/display-server.js'

/**
 * The live scenes' banner.
 *
 * A transparent surface placed wherever a message should appear: it says nothing
 * about the talk, it carries what the console puts on air.
 */
const withMessage = (liveMessage: unknown): DisplayPayload =>
  ({ state: { liveMessage, question: null } }) as unknown as DisplayPayload

/** An audience question on air — the other channel, the one that goes into the VOD. */
const withQuestion = (question: unknown): DisplayPayload =>
  ({ state: { liveMessage: null, question } }) as unknown as DisplayPayload

/** The style is chosen in the OBS source's address, not at runtime. */
function setStyle(style: string | null): void {
  globalThis.history.replaceState(null, '', style == null ? '/display/overlay-live' : `/display/overlay-live?style=${style}`)
}

function mountBanner(payload: DisplayPayload): void {
  document.documentElement.innerHTML = flattenLayersInHtml(
    renderOverlayLivePage({ initialPayload: payload }),
  )
  for (const script of document.querySelectorAll('script:not([type])')) {
    // eslint-disable-next-line no-new-func
    new Function(script.textContent ?? '')()
  }
}

describe('live banner', () => {
  it('shows nothing when there is nothing to say', () => {
    // An empty frame permanently burned into the live stream would be worse than
    // nothing.
    mountBanner(withMessage(null))

    expect(document.body.dataset.banner).toBe('hidden')
  })

  it('displays the text put on air', () => {
    mountBanner(withMessage({ text: 'Reprise dans 5 minutes', level: 'info', expiresAtMs: null }))

    expect(document.body.dataset.banner).toBe('visible')
    expect(document.getElementById('text')?.textContent).toBe('Reprise dans 5 minutes')
  })

  it('carries the level, which decides its tint', () => {
    // A "microphone down" and a "ask your questions" do not read the same way
    // from the back of the room.
    mountBanner(withMessage({ text: 'Micro en panne', level: 'urgent', expiresAtMs: null }))

    expect(document.body.dataset.level).toBe('urgent')
  })

  it('keeps a genuinely transparent background', () => {
    // OBS composites this page over the video: an opaque background would hide
    // the whole talk.
    mountBanner(withMessage(null))

    const background = globalThis.getComputedStyle(document.body).backgroundColor
    expect(background === '' || background === 'transparent' || background === 'rgba(0, 0, 0, 0)').toBe(true)
  })
})

describe('two presentations', () => {
  afterEach(() => setStyle(null))

  it('banner by default, with no label', () => {
    // On a camera shot, one more label clutters for nothing.
    setStyle(null)
    mountBanner(withMessage({ text: 'Une question', level: 'info', expiresAtMs: null }))

    expect(document.body.dataset.style).toBe('bandeau')
    expect(globalThis.getComputedStyle(document.getElementById('label')!).display).toBe('none')
  })

  it('a card on request, with its label', () => {
    // Over slides, one does not know where that text comes from: it names itself.
    // The label announces a question; an operational message reads as it is, with
    // no heading that would lie about its nature.
    setStyle('encart')
    mountBanner(withQuestion({ text: 'Une question', author: null, sessionId: 's-3' }))

    expect(document.body.dataset.style).toBe('encart')
    expect(globalThis.getComputedStyle(document.getElementById('label')!).display).not.toBe('none')
    expect(document.getElementById('label')?.textContent).toContain('Question du public')
  })

  it('ignores an unknown style rather than displaying nothing', () => {
    setStyle('flamboyant')
    mountBanner(withMessage({ text: 'Une question', level: 'info', expiresAtMs: null }))

    expect(document.body.dataset.style).toBe('bandeau')
  })
})

/**
 * Moving from one question to the next.
 *
 * Replacing the text in place would give a jump: two questions of different
 * lengths substitute at once, and the viewer does not know whether it changed or
 * was always there.
 */
describe('changing question', () => {
  /** A fake stream: the page updates itself by SSE, so we supply one. */
  class FakeStream {
    static last: FakeStream | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    constructor() {
      FakeStream.last = this
    }
    addEventListener(): void {}
    emit(payload: unknown): void {
      this.onmessage?.({ data: JSON.stringify(payload) })
    }
  }

  beforeEach(() => {
    FakeStream.last = null
    vi.stubGlobal('EventSource', FakeStream)
  })

  it('comes straight in the first time', () => {
    // Nothing to take out: an empty exit would delay the display for nothing.
    mountBanner(withMessage({ text: 'Première', level: 'info', expiresAtMs: null }))

    expect(document.body.dataset.banner).toBe('visible')
    expect(document.getElementById('text')?.textContent).toBe('Première')
  })

  it('takes the old one out, then puts the new one in', async () => {
    mountBanner(withMessage({ text: 'Première', level: 'info', expiresAtMs: null }))

    FakeStream.last!.emit(withMessage({ text: 'Seconde', level: 'warning', expiresAtMs: null }))

    // First step: it goes out, and the old one is still what is written.
    expect(document.body.dataset.banner).toBe('hidden')
    expect(document.getElementById('text')?.textContent).toBe('Première')

    // Second step: the new one is set, then comes in.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(document.body.dataset.banner).toBe('visible')
    expect(document.getElementById('text')?.textContent).toBe('Seconde')
    expect(document.body.dataset.level).toBe('warning')
  })

  it('replays nothing when the state does not change', async () => {
    // The control app receives a state every few seconds: replaying the animation
    // every time would make the question blink for no reason.
    mountBanner(withMessage({ text: 'Première', level: 'info', expiresAtMs: null }))

    FakeStream.last!.emit(withMessage({ text: 'Première', level: 'info', expiresAtMs: null }))

    expect(document.body.dataset.banner).toBe('visible')
  })

  it('withdraws without waiting when there is nothing left', () => {
    mountBanner(withMessage({ text: 'Première', level: 'info', expiresAtMs: null }))

    FakeStream.last!.emit(withMessage(null))

    expect(document.body.dataset.banner).toBe('hidden')
  })
})

/**
 * The two channels in a single place.
 *
 * This page is placed in OBS-A's scenes: it is seen by the room, not by the VOD.
 * It is therefore allowed to show both — unlike the capture overlay, which only
 * shows the question.
 */
describe('question and banner, two channels', () => {
  it('displays the question when nothing comes from the console', () => {
    mountBanner(withQuestion({ text: 'Et les faux positifs ?', author: 'Camille', sessionId: 's-3' }))

    expect(document.body.dataset.banner).toBe('visible')
    expect(document.getElementById('text')?.textContent).toBe('Et les faux positifs ?')
    expect(document.getElementById('label')?.textContent).toContain('Camille')
  })

  it('lets the console banner come first', () => {
    // A "we resume in 5 minutes" means something is happening: it takes
    // precedence over the question the speaker was answering.
    mountBanner({
      state: {
        liveMessage: { text: 'Reprise dans 5 minutes', level: 'urgent', expiresAtMs: null },
        question: { text: 'Et les faux positifs ?', author: null, sessionId: 's-3' },
      },
    } as unknown as DisplayPayload)

    expect(document.getElementById('text')?.textContent).toBe('Reprise dans 5 minutes')
    expect(document.body.dataset.level).toBe('urgent')
    // And without passing itself off as an audience question.
    expect(document.getElementById('label')?.hidden).toBe(true)
  })
})
