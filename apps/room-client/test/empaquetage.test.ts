import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { resoudreRegieDepuis } from '../src/core/regie-shell.js'

/**
 * Ce que l'installeur pose, et ce que le poste va chercher.
 *
 * Deux fichiers doivent s'accorder sans se connaître : `electron-builder.yml`
 * décide **où** le bundle de la régie atterrit sur une machine installée, et
 * `resoudreRegieDepuis` remonte les dossiers pour l'y trouver. Leur désaccord
 * ne se verrait qu'au montage d'une salle — la régie répondrait 503 sur une
 * machine où tout le reste marche, et personne ne relie ça à une ligne de YAML.
 *
 * Vérifié sur un arbre reconstitué plutôt que sur un vrai paquet : produire un
 * installeur prend six minutes et télécharge cent mégaoctets d'Electron. Ce qui
 * est en jeu ici est une entente entre deux chemins, pas la chaîne
 * d'empaquetage — celle-là s'éprouve à la main, avant une livraison.
 */
const RACINE = dirname(dirname(fileURLToPath(import.meta.url)))

interface Config {
  extraResources: { from: string; to: string; filter?: string[] }[]
}

const config = load(readFileSync(join(RACINE, 'electron-builder.yml'), 'utf8')) as Config
const regie = config.extraResources.find((entree) => entree.from.includes('regie-web'))

let dir: string

afterEach(() => {
  if (dir != null) rmSync(dir, { recursive: true, force: true })
})

describe('bundle de la régie dans le paquet', () => {
  it('est bien déclaré dans les ressources embarquées', () => {
    expect(regie).toBeDefined()
    expect(regie!.from).toBe('../regie-web/dist')
  })

  it('atterrit là où la remontée de dossiers le cherche', () => {
    /*
     * L'arbre d'une machine installée, réduit à ce qui compte : le bundle du
     * processus principal vit dans `resources/app.asar/dist`, les ressources
     * embarquées à côté, sous `resources/`.
     */
    dir = mkdtempSync(join(tmpdir(), 'cloudnord-paquet-'))
    const manifeste = join(dir, 'resources', regie!.to, '.vite', 'manifest.json')
    mkdirSync(dirname(manifeste), { recursive: true })
    writeFileSync(manifeste, '{}')

    const trouve = resoudreRegieDepuis(join(dir, 'resources', 'app.asar', 'dist'))

    expect(trouve?.manifeste).toBe(manifeste)
  })

  it('ne laisse pas partir la source map', () => {
    // Deux mégaoctets que personne n'ouvre sur un poste de salle. Elle reste sur
    // la machine de build, où une trace remontée se relit après coup.
    expect(regie!.filter).toContain('!**/*.map')
  })
})
