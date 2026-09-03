import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** L'accent grave, nommé pour ne pas l'écrire dans un fichier qui en parle. */
const ACCENT = String.fromCharCode(96)
import { renderProjectorPage } from '../src/core/display-page.js'
import { renderOverlayPage } from '../src/core/overlay-page.js'
import { renderHubAddressPage } from '../src/core/hub-address-page.js'
import { analyserScripts, extraireScripts } from './helpers/inline-scripts.js'

/**
 * Garde-fous communs aux pages servies localement.
 *
 * Elles sont écrites comme des template literals : un backtick oublié dans un
 * commentaire coupe la chaîne et casse le fichier. Le compilateur l'attrape,
 * mais seulement après coup — ces tests disent *quelle* propriété on tient.
 *
 * La régie en est sortie : c'est un bundle. Ceux de ses garde-fous qui ont
 * encore un sens l'ont suivie — l'origine des ressources et le document clos
 * dans `regie-servie.test.ts`, le fond et la disposition dans
 * `apps/regie-web/test/cadre.test.ts`. Les autres ne visaient que le gabarit
 * littéral, et Vite les rend sans objet.
 */
const PAGES: [string, string][] = [
  ['projection', renderProjectorPage()],
  ['habillage', renderOverlayPage()],
  ['adresse du hub', renderHubAddressPage({ initialValue: 'http://localhost:8787' })],
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
  'hub-address-page.ts',
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
  it.each(PAGES)('%s : aucune dépendance externe, hors exception nommée', (nom, html) => {
    /*
     * Une balise vers un CDN casse la page dès la première coupure —
     * c'est-à-dire exactement quand on en a besoin.
     *
     * **Une seule exception, nommée ici** : le bouton de X sur la slide
     * Réseaux de la projection. Le test ne disparaît pas pour autant, et c'est
     * le point : il liste les origines externes et refuse toute autre que
     * celle-là. Une seconde dépendance qui s'inviterait — une police, une
     * analytique — échouerait ici, et la première reste tenue à sa page et à
     * son `async`.
     */
    const AUTORISEES: Record<string, string[]> = {
      projection: ['https://platform.x.com/widgets.js'],
    }
    const externes = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)]
      .map((trouve) => trouve[1]!)
      .filter((adresse) => /^(?:https?:)?\/\//.test(adresse))

    expect(externes).toEqual(AUTORISEES[nom] ?? [])
    expect(html).not.toMatch(/@import\s+url/)

    // Chargée en `async` : rien de ce qui se lit ne doit attendre le réseau.
    for (const adresse of externes) {
      expect(html).toMatch(new RegExp('<script async src="' + adresse.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'))
    }
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

  it("l'écran d'adresse échappe la valeur qu'on lui remet sous les yeux", () => {
    // Elle vient du disque ou de la ligne de commande : elle n'a rien à
    // pouvoir refermer l'attribut qui la porte.
    const html = renderHubAddressPage({ initialValue: 'http://hub"><script>x' })
    expect(html).toContain('value="http://hub&quot;&gt;&lt;script&gt;x"')
  })

  it("l'écran d'adresse ne conditionne jamais « Continuer » à une réponse du hub", () => {
    // Un poste de régie se prépare la veille, hub éteint : la sonde informe,
    // elle n'allowed pas. Un bouton désactivable ici serait une panne un matin
    // d'événement.
    const html = renderHubAddressPage({ initialValue: 'http://localhost:8787' })
    // Le corps seul : la feuille Tailwind, en tête, parle de `:disabled` pour
    // tous les boutons de l'application.
    const corps = html.slice(html.indexOf('<body'))
    expect(corps).toMatch(/<button[^>]*type="submit"/)
    expect(corps).not.toMatch(/disabled/)
  })
})

/**
 * Les classes de l'ancienne feuille de composants, et pourquoi elles reviennent.
 *
 * `.btn`, `.champ`, `.panneau` ont été l'idiome de ce dépôt pendant toute la
 * vie des pages-gabarits. La feuille qui les définissait a suivi la régie, sa
 * dernière lectrice — mais l'habitude, elle, reste : ajouter un bouton à
 * l'écran d'adresse du hub et écrire `class="btn"` donne un bouton nu, sans
 * qu'aucune erreur ne parte.
 *
 * Le garde-fou est étroit à dessein. Sa forme générale — toute classe posée
 * doit exister dans la feuille — a été essayée : la page de projection a son
 * propre `<style>` et une douzaine de classes qui ne servent que de prise à son
 * JavaScript, et il aurait fallu les maintenir à la main dans une liste. C'est
 * exactement le genre de liste qui finit par manquer quelque chose.
 */
const CLASSES_DISPARUES = [
  'btn',
  'btn-onglet',
  'btn-petit',
  'champ',
  'inactif',
  'panneau',
  'titre-panneau',
  'touche',
]

describe('classes de la feuille de composants supprimée', () => {
  it.each(PAGES)('%s : n\'en pose aucune', (_nom, html) => {
    const corps = html.slice(html.indexOf('<body'))
    const posees = new Set<string>()
    for (const attribut of corps.matchAll(/class="([^"]*)"/g)) {
      for (const nom of attribut[1]!.split(/\s+/)) posees.add(nom)
    }
    expect(CLASSES_DISPARUES.filter((classe) => posees.has(classe))).toEqual([])
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
    expect(renderOverlayPage()).toMatch(/id="category"[^>]*hidden/)
  })
})
