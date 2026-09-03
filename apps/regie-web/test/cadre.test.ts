import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Le cadre de la page, décrit en règles et non en utilitaires.
 *
 * Le `<body>` est rendu par le poste de salle, pas par ce paquet : ses classes
 * ne sont scannées par personne. Ce qui le tient debout vit donc dans cette
 * feuille, et ces trois règles sont exactement celles qu'on ne verrait manquer
 * qu'à l'écran — reprises des garde-fous des pages qu'elle remplace.
 */
const FEUILLE = readFileSync(join(import.meta.dirname, '..', 'src', 'style.css'), 'utf8')

describe('feuille de la régie', () => {
  it('peint son propre fond', () => {
    /*
     * Le fond venait d'une règle `body` des anciennes feuilles. La console du
     * hub s'est retrouvée sur le blanc par défaut du navigateur en la
     * remplaçant sans reposer de classes ; ici, c'est une fenêtre qu'on ouvre
     * dans une salle sombre.
     */
    expect(FEUILLE).toMatch(/body\s*\{[^}]*background:\s*var\(--color-fond\)/s)
    expect(FEUILLE).toMatch(/body\s*\{[^}]*color:\s*var\(--color-texte\)/s)
  })

  it('occupe la hauteur, et ne défile pas d’un bloc', () => {
    // Une régie qui défile en entier fait sortir les commandes de l'écran au
    // moment où l'on déroule une liste de rushes.
    expect(FEUILLE).toMatch(/height:\s*100%/)
    expect(FEUILLE).toMatch(/overflow:\s*hidden/)
  })

  it('laisse la racine de editing transparente à la disposition', () => {
    // `#regie-root` est une boîte que le poste pose ; sans `display: contents`,
    // l'en-tête et le contenu ne sont plus les enfants directs du `<body>` et
    // la colonne flex ne s'applique à rien.
    expect(FEUILLE).toMatch(/#regie-root\s*\{[^}]*display:\s*contents/s)
  })
})
