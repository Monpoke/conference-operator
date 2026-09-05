/// <reference lib="dom" />
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { flattenLayersInHtml } from '@conference-operator/ui'
import { renderProjectorPage } from '../src/core/display-page.js'
import { renderOverlayPage } from '../src/core/overlay-page.js'

/**
 * **Effective** visibility, stylesheet included.
 *
 * Checking the `hidden` attribute is not enough: the rule that turns it into
 * `display: none` comes from the browser's own sheet, and the slightest author
 * rule setting a `display` beats it. That is what made the tabs have no effect
 * while the attribute itself was changing correctly — reported twice.
 *
 * Since the move to Tailwind, this test only holds thanks to
 * `flattenLayersInHtml`: happy-dom ignores `@layer`, where the whole sheet lives.
 */
const PAGES: [string, () => string][] = [
  ['projector', renderProjectorPage],
  ['overlay', renderOverlayPage],
]

function mount(html: string): void {
  document.documentElement.innerHTML = flattenLayersInHtml(html)
}

describe('effective visibility', () => {
  it.each(PAGES)('%s: a hidden element is really invisible', (_name, render) => {
    mount(render())
    // We set up a clear-cut case: an element to which a utility gives a display,
    // exactly the situation that beat `[hidden]`.
    const probe = document.createElement('div')
    probe.className = 'flex'
    probe.id = 'probe'
    probe.hidden = true
    document.body.append(probe)
    expect(globalThis.getComputedStyle(probe).display).toBe('none')
  })

  it('the stylesheet really is seen by the test DOM', () => {
    // A guard for the guard: if the flattening stopped working, the previous test
    // would pass for the wrong reason — no rule loaded, so an empty `display`, so
    // nothing checked.
    mount(renderOverlayPage())
    const probe = document.createElement('div')
    probe.className = 'flex'
    document.body.append(probe)
    expect(globalThis.getComputedStyle(probe).display).toBe('flex')
  })
})

describe('page background', () => {
  const OPAQUE = [
    ['projector', renderProjectorPage],
    ] as [string, () => string][]

  it.each(OPAQUE)('%s: paints its own background', (_name, render) => {
    // The background used to come from a `body` rule in the old sheets. The hub
    // console ended up on the browser's default white when they were replaced
    // without laying classes back down; the room screens are projected, and the
    // default would be far more visible there.
    mount(render())
    const background = globalThis.getComputedStyle(document.body).backgroundColor
    expect(background).not.toBe('')
    expect(background).not.toMatch(/transparent|rgba\(0, 0, 0, 0\)|(^|[^0-9])255, 255, 255/)
  })

  it('the overlay, on the other hand, stays transparent', () => {
    // Strictly the opposite: OBS-B composites this page over the camera. An
    // opaque background would hide the video — the most visible failure possible.
    mount(renderOverlayPage())
    const background = globalThis.getComputedStyle(document.body).backgroundColor
    expect(background === '' || /transparent|rgba\(0, 0, 0, 0\)/.test(background)).toBe(true)
  })
})
