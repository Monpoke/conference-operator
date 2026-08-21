import { describe, expect, it } from 'vitest'
import { aplatirCouches, aplatirCouchesHtml } from '../src/couches.js'
import { TAILWIND_CSS } from '../src/generated/styles.js'

describe('aplatissement des couches CSS', () => {
  it('retire l\'enveloppe et garde les règles', () => {
    expect(aplatirCouches('@layer base { .a { color: red } }')).toContain('.a { color: red }')
    expect(aplatirCouches('@layer base { .a { color: red } }')).not.toContain('@layer')
  })

  it('supprime les simples déclarations d\'ordre', () => {
    expect(aplatirCouches('@layer theme, base;.a{color:red}')).toBe('.a{color:red}')
  })

  it('descend dans les couches imbriquées', () => {
    const plat = aplatirCouches('@layer a { @layer b { .x { color: red } } }')
    expect(plat).not.toContain('@layer')
    expect(plat).toContain('.x { color: red }')
  })

  it('laisse intactes les autres règles at-rules', () => {
    // Une media query enveloppe légitimement ses règles : la toucher casserait
    // le responsive au lieu de le rendre visible.
    const plat = aplatirCouches('@layer u { @media (min-width:40rem) { .x { color: red } } }')
    expect(plat).toContain('@media (min-width:40rem)')
  })

  it('ne touche pas au script de la page', () => {
    const html = '<style>@layer base { .a { color: red } }</style><script>const s = "@layer x"</script>'
    expect(aplatirCouchesHtml(html)).toContain('const s = "@layer x"')
    expect(aplatirCouchesHtml(html)).toContain('.a { color: red }')
  })

  it('rend la feuille Tailwind lisible par un DOM sans support des couches', () => {
    // Le vrai enjeu : la sortie Tailwind est intégralement en couches.
    expect(TAILWIND_CSS).toContain('@layer')
    const plat = aplatirCouches(TAILWIND_CSS)
    expect(plat).not.toContain('@layer')
    // Et le contenu survit : la règle qui rend `hidden` prioritaire est là.
    expect(plat).toMatch(/\[hidden\][^}]*display:\s*none\s*!important/)
  })
})
