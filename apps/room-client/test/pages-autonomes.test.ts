import { describe, expect, it } from 'vitest'
import { renderProjectorPage } from '../src/core/display-page.js'
import { renderOverlayPage } from '../src/core/overlay-page.js'
import { renderRegiePage } from '../src/core/regie-page.js'
import { analyserScripts, extraireScripts } from './helpers/inline-scripts.js'

/**
 * Garde-fous communs aux pages servies localement.
 *
 * Elles sont écrites comme des template literals : un backtick oublié dans un
 * commentaire coupe la chaîne et casse le fichier. Le compilateur l'attrape,
 * mais seulement après coup — ces tests disent *quelle* propriété on tient.
 */
const PAGES: [string, string][] = [
  ['projection', renderProjectorPage()],
  ['habillage', renderOverlayPage()],
  ['régie', renderRegiePage()],
]

describe('pages servies par le client', () => {
  it.each(PAGES)('%s : aucune dépendance externe', (_nom, html) => {
    // Une balise vers un CDN casserait la page dès la première coupure —
    // c'est-à-dire exactement quand on en a besoin.
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+href=/)
    expect(html).not.toMatch(/@import\s+url/)
  })

  it.each(PAGES)('%s : document complet et clos', (_nom, html) => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })

  it.each(PAGES)('%s : le JavaScript embarqué est analysable', (_nom, html) => {
    // Sans ce test, rien ne vérifie ce code : il vit dans un template literal,
    // où TypeScript ne voit qu'une chaîne. Une erreur y casse *toute* la page.
    expect(analyserScripts(html)).toEqual([])
  })

  it.each(PAGES)('%s : contient bien du script à analyser', (_nom, html) => {
    // Garde-fou du garde-fou : si l'extraction cessait de trouver quoi que ce
    // soit, le test précédent passerait en ne vérifiant rien.
    expect(extraireScripts(html).length).toBeGreaterThan(0)
  })

  it('la régie embarque son état initial et se reconnecte seule', () => {
    const html = renderRegiePage({ initialPayload: { state: { mode: 'sponsors' } } })
    expect(html).toContain('id="etat-initial"')
    expect(html).toContain("new EventSource('/display/state?vue=regie')")
  })

  it('la régie ouvre les écrans dans un nouvel onglet', () => {
    // Ouvrir la projection dans la fenêtre de régie remplacerait les commandes
    // par l'écran de salle, en pleine intervention.
    expect(renderRegiePage()).toContain("lien.target = '_blank'")
  })
})

describe("l'attribut hidden est rendu prioritaire", () => {
  /**
   * Piège rencontré sur la console : `[hidden] { display: none }` vient de la
   * feuille du navigateur, et la moindre règle d'auteur posant un `display` la
   * bat. Les onglets changeaient bien l'attribut, l'écran ne bougeait pas.
   */
  it.each(PAGES)('%s : neutralise toute règle de disposition concurrente', (_nom, html) => {
    expect(html).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/)
  })

  it("l'overlay porte bien un badge que la règle doit neutraliser", () => {
    // Le badge de catégorie porte un `inline-block` : sans la règle, `hidden`
    // ne le cacherait pas et une catégorie fantôme s'afficherait sur la VOD.
    // La vérification de visibilité réelle est dans `visibilite-effective`.
    expect(renderOverlayPage()).toMatch(/id="categorie"[^>]*hidden/)
  })
})
