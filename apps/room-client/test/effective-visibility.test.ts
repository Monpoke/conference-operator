/// <reference lib="dom" />
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { flattenLayersInHtml } from '@cloudnord/ui'
import { renderProjectorPage } from '../src/core/display-page.js'
import { renderOverlayPage } from '../src/core/overlay-page.js'

/**
 * Visibilité **effective**, feuille de style comprise.
 *
 * Vérifier l'attribut `hidden` ne suffit pas : la règle qui le traduit en
 * `display: none` vient de la feuille du navigateur, et la moindre règle
 * d'auteur posant un `display` la bat. C'est ce qui rendait les onglets sans
 * effet alors que l'attribut, lui, changeait bien — signalé deux fois.
 *
 * Depuis le passage à Tailwind, ce test ne tient que grâce à
 * `flattenLayersInHtml` : happy-dom ignore `@layer`, où vit toute la feuille.
 */
const PAGES: [string, () => string][] = [
  ['projection', renderProjectorPage],
  ['habillage', renderOverlayPage],
]

function monter(html: string): void {
  document.documentElement.innerHTML = flattenLayersInHtml(html)
}

describe('visibilité effective', () => {
  it.each(PAGES)('%s : un élément hidden est réellement invisible', (_nom, rendre) => {
    monter(rendre())
    // On pose un cas franc : un élément à qui une utilitaire donne un display,
    // exactement la situation qui battait `[hidden]`.
    const sonde = document.createElement('div')
    sonde.className = 'flex'
    sonde.id = 'sonde'
    sonde.hidden = true
    document.body.append(sonde)
    expect(globalThis.getComputedStyle(sonde).display).toBe('none')
  })

  it('la feuille est bien vue par le DOM de test', () => {
    // Garde-fou du garde-fou : si l'aplatissement cessait de fonctionner, le
    // test précédent passerait pour la mauvaise raison — aucune règle chargée,
    // donc `display` vide, donc rien de vérifié.
    monter(renderOverlayPage())
    const sonde = document.createElement('div')
    sonde.className = 'flex'
    document.body.append(sonde)
    expect(globalThis.getComputedStyle(sonde).display).toBe('flex')
  })
})

describe('fond de page', () => {
  const OPAQUE = [
    ['projection', renderProjectorPage],
    ] as [string, () => string][]

  it.each(OPAQUE)('%s : peint son propre fond', (_nom, rendre) => {
    // Le fond venait d'une règle `body` des anciennes feuilles. La console du
    // hub s'est retrouvée sur le blanc par défaut du navigateur en la
    // remplaçant sans reposer de classes ; les écrans de salle sont projetés,
    // le défaut y serait bien plus visible.
    monter(rendre())
    const fond = globalThis.getComputedStyle(document.body).backgroundColor
    expect(fond).not.toBe('')
    expect(fond).not.toMatch(/transparent|rgba\(0, 0, 0, 0\)|(^|[^0-9])255, 255, 255/)
  })

  it("l'habillage reste transparent, lui", () => {
    // Inverse strict : OBS-B compose cette page par-dessus la caméra. Un fond
    // opaque masquerait la vidéo — la panne la plus visible possible.
    monter(renderOverlayPage())
    const fond = globalThis.getComputedStyle(document.body).backgroundColor
    expect(fond === '' || /transparent|rgba\(0, 0, 0, 0\)/.test(fond)).toBe(true)
  })
})
