import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** L'accent grave, nommé pour ne pas l'écrire dans un fichier qui en parle. */
const ACCENT = String.fromCharCode(96)
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

/**
 * Fichiers source des pages, pour les garde-fous d'écriture.
 *
 * Ces pages sont des gabarits littéraux : ce qu'on y écrit passe deux fois par
 * un analyseur, celui de TypeScript puis celui du navigateur.
 */
const SOURCES = [
  'display-page.ts',
  'overlay-page.ts',
  'overlay-live-page.ts',
  'regie-page.ts',
].map((nom) => [nom, readFileSync(fileURLToPath(new URL('../src/core/' + nom, import.meta.url)), 'utf8')] as const)

describe('écriture des gabarits', () => {
  it.each(SOURCES)('%s : aucun accent grave dans le corps du gabarit', (_nom, source) => {
    /**
     * L'erreur qui revient, et qui coûte cher à chaque fois.
     *
     * Un accent grave dans un commentaire — « voir CONFIG » écrit en style
     * code — referme le gabarit littéral. TypeScript signale alors une erreur
     * de syntaxe **à la fin du fichier**, à cent lignes de la cause, et la page
     * entière cesse de compiler. Ce test la nomme.
     */
    const debut = source.indexOf(ACCENT + '<!doctype html>')
    const fin = source.lastIndexOf(ACCENT)
    expect(debut).toBeGreaterThan(-1)

    // Les accents graves **échappés** sont légitimes : `display-page` s'en sert
    // pour ses propres gabarits imbriqués. Seuls les nus referment la chaîne.
    const corps = source.slice(debut + 1, fin).split('\\' + ACCENT).join('')
    expect(corps).not.toContain(ACCENT)
  })
})

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
