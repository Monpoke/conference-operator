import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { APPARENCE, contourDe } from '@cloudnord/etat-salle'
import { describe, expect, it } from 'vitest'

/**
 * Le vocabulaire de la pastille est écrit à deux endroits, et un seul lève.
 *
 * `APPARENCE` et `contourDe()` produisent des **noms de classes** ; `status.css`
 * les peint. Rien ne relie les deux : une teinte ajoutée à la table sans règle
 * correspondante donne une pastille au hasard, et une règle laissée derrière
 * une teinte supprimée voyage dans la feuille inlinée par toutes les pages sans
 * que personne ne s'en aperçoive. Les deux défauts existaient — le second
 * (`.pastille.pause`) survivait au changement de `APPARENCE.pause`, dont la
 * teinte est passée à `hors`.
 *
 * Le test compare les deux ensembles dans les deux sens, comme `vues-du-flux`
 * le fait pour les champs du flux.
 */

const STATUS_CSS = readFileSync(fileURLToPath(new URL('../src/status.css', import.meta.url)), 'utf8')

/** Modificateurs réellement peints, lus dans la feuille. */
const peintes = new Set(
  [...STATUS_CSS.matchAll(/\.pastille\.([a-z-]+)/g)].map((trouve) => trouve[1] as string),
)

/**
 * Modificateurs réellement posés par le code.
 *
 * Le remplissage vient de la table des apparences, le contour de `contourDe()`
 * — dont la sortie est préfixée d'une espace, puisqu'elle se concatène. Les
 * deux dernières ne viennent d'aucune table : ce sont les pastilles de
 * *machine*, posées à la main là où l'on n'affiche qu'une connectivité (l'état
 * du hub en régie, par exemple), et le commentaire de `status.css` les
 * distingue explicitement d'un état de conférence.
 */
const posees = new Set(
  [
    ...Object.values(APPARENCE).map((apparence) => apparence.teinte),
    ...['ONLINE', 'DEGRADED', 'OFFLINE', null].map((c) => contourDe(c).trim()),
    'degraded',
    'offline',
  ].filter((nom) => nom !== ''),
)

describe('vocabulaire de la pastille', () => {
  it('peint chaque modificateur que le code peut poser', () => {
    expect([...posees].filter((nom) => !peintes.has(nom)).sort()).toEqual([])
  })

  it('ne peint aucun modificateur que plus personne ne pose', () => {
    expect([...peintes].filter((nom) => !posees.has(nom)).sort()).toEqual([])
  })

  it('couvre bien quelque chose', () => {
    // Garde-fou du garde-fou : deux ensembles vides se correspondraient
    // parfaitement sans rien prouver.
    expect(peintes.size).toBeGreaterThan(6)
  })
})
