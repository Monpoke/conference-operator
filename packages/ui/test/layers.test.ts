import { describe, expect, it } from 'vitest'
import { flattenLayers, flattenLayersInHtml } from '../src/layers.js'
import { TAILWIND_CSS } from '../src/generated/styles.js'

describe('CSS layer flattening', () => {
  it('removes the wrapper and keeps the rules', () => {
    expect(flattenLayers('@layer base { .a { color: red } }')).toContain('.a { color: red }')
    expect(flattenLayers('@layer base { .a { color: red } }')).not.toContain('@layer')
  })

  it('drops plain order declarations', () => {
    expect(flattenLayers('@layer theme, base;.a{color:red}')).toBe('.a{color:red}')
  })

  it('goes down into nested layers', () => {
    const flat = flattenLayers('@layer a { @layer b { .x { color: red } } }')
    expect(flat).not.toContain('@layer')
    expect(flat).toContain('.x { color: red }')
  })

  it('leaves other at-rules untouched', () => {
    // A media query legitimately wraps its rules: touching it would break
    // responsiveness instead of making it visible.
    const flat = flattenLayers('@layer u { @media (min-width:40rem) { .x { color: red } } }')
    expect(flat).toContain('@media (min-width:40rem)')
  })

  it('does not touch the page script', () => {
    const html = '<style>@layer base { .a { color: red } }</style><script>const s = "@layer x"</script>'
    expect(flattenLayersInHtml(html)).toContain('const s = "@layer x"')
    expect(flattenLayersInHtml(html)).toContain('.a { color: red }')
  })

  it('makes the Tailwind sheet readable by a DOM with no layer support', () => {
    // The real point: Tailwind's output is entirely in layers.
    expect(TAILWIND_CSS).toContain('@layer')
    const flat = flattenLayers(TAILWIND_CSS)
    expect(flat).not.toContain('@layer')
    // And the content survives: the rule that gives `hidden` priority is there.
    expect(flat).toMatch(/\[hidden\][^}]*display:\s*none\s*!important/)
  })
})
