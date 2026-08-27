import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHAMPS_PAR_VUE, type VueAffichage } from '../src/core/display-server.js'

/**
 * Le flux d'état ne pousse à chaque page que les champs qu'elle lit — l'overlay
 * n'a que faire des 27 sessions de la salle ou du QR du mur.
 *
 * Le risque de ce découpage est silencieux : un champ ajouté à une page mais
 * oublié dans `CHAMPS_PAR_VUE` ne lève rien, il affiche du vide. Ce test relit
 * donc les sources des pages et compare ce qu'elles consultent à ce qu'elles
 * reçoivent.
 *
 * La régie n'y figure plus : c'est un bundle, pas un gabarit, et son garde-fou
 * vit chez elle — `apps/regie-web/test/champs-du-flux.test.ts`, qui relit ses
 * sources de la même façon.
 */
const PAGES: { vue: VueAffichage; fichier: string }[] = [
  { vue: 'projecteur', fichier: 'display-page.ts' },
  { vue: 'overlay', fichier: 'overlay-page.ts' },
]

/**
 * Champs de la charge utile consultés par une page, par lecture de sa source.
 *
 * `donnees?.champ` autant que `donnees.champ`, et l'optionnel n'est pas un
 * détail : la première version du motif l'ignorait, et le seul champ qu'une
 * page lisait ainsi — le mur, dans le menu des écrans de la régie — était
 * absent de `CHAMPS_PAR_VUE` sans que rien ne le dise. Le lien « Mur public »
 * ne tenait que par accident : l'état embarqué dans la coquille n'est pas
 * filtré, et la liste des écrans n'était construite qu'une fois.
 */
function champsLus(fichier: string): string[] {
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'core', fichier), 'utf8')
  const trouves = source.matchAll(/\bdonnees\??\.([a-zA-Z]+)/g)
  return [...new Set([...trouves].map((m) => m[1]!))].sort()
}

describe('vues du flux d\'état', () => {
  for (const { vue, fichier } of PAGES) {
    it(`${vue} reçoit tout ce que ${fichier} consulte`, () => {
      const recus = new Set<string>(CHAMPS_PAR_VUE[vue] as readonly string[])
      const manquants = champsLus(fichier).filter((champ) => !recus.has(champ))
      expect(
        manquants,
        manquants.length === 0
          ? ''
          : `${fichier} lit ${manquants.join(', ')} — à ajouter dans CHAMPS_PAR_VUE.${vue}, ` +
            "sinon la page rend du vide sans lever d'erreur.",
      ).toEqual([])
    })

    it(`${vue} ne reçoit rien d'inutile`, () => {
      // L'inverse compte aussi : un champ envoyé sans être lu est du trafic pur.
      const lus = new Set(champsLus(fichier))
      const inutiles = (CHAMPS_PAR_VUE[vue] as readonly string[]).filter((champ) => !lus.has(champ))
      expect(inutiles).toEqual([])
    })
  }

  it('la lecture des sources trouve bien quelque chose', () => {
    // Garde-fou du garde-fou : une extraction devenue muette ferait passer les
    // tests précédents en ne vérifiant rien.
    for (const { fichier } of PAGES) expect(champsLus(fichier).length).toBeGreaterThan(0)
  })
})
