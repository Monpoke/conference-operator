// @vitest-environment node
//
// Environnement node, et pas happy-dom : ce test lit un fichier du dépôt, et
// happy-dom ne sait pas rendre `import.meta.url` en chemin de fichier. Il
// n'examine aucun composant, donc il n'a besoin d'aucun DOM.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bundledConsolePaths, consoleViews, legacyConsolePaths, viewPath } from '@cloudnord/contract'
import { isMigrated } from '../src/router.js'

/**
 * Les adresses de la console, et ce qui les sert.
 *
 * Deux invariants, et aucun ne se voit en relecture d'une vue.
 */

const ROUTER = readFileSync(fileURLToPath(new URL('../src/router.ts', import.meta.url)), 'utf8')

describe('vues de développement', () => {
  it("n'existent pas en production", () => {
    // Le code qui déplace l'heure de tout le système, et celui qui efface les
    // rushes : le hub ne sert pas leur adresse hors mode dev.
    expect(consoleViews(false)).not.toContain('developpement')
    expect(consoleViews(true)).toContain('developpement')
    expect(bundledConsolePaths(false)).not.toContain(viewPath('developpement'))
  })

  it("n'entrent pas dans le bundle servi le jour J", () => {
    /*
     * Le second verrou, et celui qu'un refactor peut défaire sans bruit.
     *
     * `consoleViews(dev)` empêche le hub de *servir* l'adresse ; il n'empêche
     * pas le code de voyager. Un `import` statique le ferait entrer dans le
     * bundle de production, à un `fetch` de distance de qui inspecte la page —
     * et rien ne le dirait, puisque la vue resterait inatteignable.
     *
     * Le test lit la source du routeur plutôt que la sortie de Vite : il n'a
     * alors besoin d'aucun build, et tourne donc à chaque `pnpm test`.
     */
    expect(ROUTER).toMatch(/component:\s*\(\)\s*=>\s*import\(['"]\.\/views\/DevelopmentView\.vue['"]\)/)
    expect(ROUTER).not.toMatch(/^import .*DevelopmentView/m)
    expect(ROUTER).not.toMatch(/^import .*stores\/dev/m)
  })
})

describe('frontière de migration', () => {
  it('couvre toutes les vues, sans en laisser derrière', () => {
    // La console est entièrement passée en Vue : plus aucune adresse ne doit
    // retomber sur le gabarit. Le jour où l'on en ressort une, ce test le dit.
    expect(legacyConsolePaths(true)).toEqual([])
    for (const vue of consoleViews(true)) expect(isMigrated(vue), vue).toBe(true)
  })
})
