// @vitest-environment node
//
// Environnement node, et pas happy-dom : ce test lit un fichier du dépôt, et
// happy-dom ne sait pas rendre `import.meta.url` en chemin de fichier. Il
// n'examine aucun composant, donc il n'a besoin d'aucun DOM.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { consolePaths, consoleViews, viewPath } from '@cloudnord/contract'

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
    expect(consolePaths(false)).not.toContain(viewPath('developpement'))
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

describe('adresses servies', () => {
  it('couvre chaque vue du mode, sans en laisser derrière', () => {
    // Le hub enregistre une route par vue plutôt qu'un joker `/admin/*` : une
    // vue ajoutée sans son adresse répondrait 404 sans que rien ne le dise.
    for (const vue of consoleViews(true)) {
      expect(consolePaths(true), vue).toContain(viewPath(vue))
    }
  })
})
