import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * L'image du hub liste les manifestes un par un, et personne ne s'en souvient.
 *
 * Le Dockerfile le dit lui-même : `--frozen-lockfile` compare le verrou à
 * l'ensemble des projets trouvés, et « un manifeste manquant se lit comme un
 * verrou périmé, et l'installation échoue sur un message qui ne dit pas ça ».
 * La panne arrive donc au déploiement, sur une erreur trompeuse, alors que la
 * cause est un paquet ajouté à l'espace de travail dix commits plus tôt.
 *
 * Ce test coûte deux lectures de dossier et supprime la classe entière.
 */

const racine = fileURLToPath(new URL('../../../', import.meta.url))
const dockerfile = readFileSync(join(racine, 'Dockerfile'), 'utf8')

/** Manifestes copiés dans l'étape d'installation. */
const listes = new Set(
  [...dockerfile.matchAll(/^COPY ([\w./-]+)\/package\.json/gm)].map((trouve) => trouve[1] as string),
)

/** Projets réellement présents, selon les groupes de `pnpm-workspace.yaml`. */
const presents = new Set(
  ['apps', 'packages'].flatMap((groupe) =>
    readdirSync(join(racine, groupe))
      .map((nom) => `${groupe}/${nom}`)
      .filter((chemin) => {
        try {
          return statSync(join(racine, chemin, 'package.json')).isFile()
        } catch {
          return false
        }
      }),
  ),
)

describe('image du hub', () => {
  it('copie le manifeste de chaque projet de l’espace de travail', () => {
    expect([...presents].filter((projet) => !listes.has(projet)).sort()).toEqual([])
  })

  it('ne copie pas un manifeste qui n’existe plus', () => {
    expect([...listes].filter((projet) => !presents.has(projet)).sort()).toEqual([])
  })

  it('regarde bien quelque chose', () => {
    // Garde-fou du garde-fou : deux ensembles vides se correspondraient sans
    // rien prouver, et une regex qui ne trouve rien est le défaut le plus
    // probable ici.
    expect(listes.size).toBeGreaterThan(5)
  })
})
