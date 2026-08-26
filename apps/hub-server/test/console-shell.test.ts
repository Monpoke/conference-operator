import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assetsDeDeveloppement,
  assetsDeProduction,
  renderConsoleShell,
} from '../src/pages/console-shell.js'

/**
 * La coquille qui charge le bundle de la console.
 *
 * Le hub sert un bundle mais rend toujours la page qui le charge, et c'est ce
 * que ces tests tiennent : trois choses doivent être connues de la console
 * avant son premier appel réseau, et une seule règle gouverne ses balises.
 */

const IDENTITE = { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' }

function coquille(overrides: Partial<Parameters<typeof renderConsoleShell>[0]> = {}): string {
  return renderConsoleShell({
    mode: 'production',
    event: IDENTITE as never,
    google: null,
    assets: { scripts: ['/admin/assets/index-abc.js'], styles: ['/admin/assets/index-abc.css'] },
    ...overrides,
  })
}

describe('coquille de la console', () => {
  it('ne référence rien hors de son origine', () => {
    /**
     * L'invariant, reformulé — et c'est le seul endroit où il se vérifie.
     *
     * L'ancienne règle interdisait toute balise `src` ou `href`, pour une
     * raison écrite noir sur blanc : « une balise vers un CDN casserait la page
     * dès la première coupure ». Ce que cette raison vise, c'est le réseau, pas
     * la balise. Un asset servi par le hub lui-même ne peut pas disparaître
     * d'une coupure du réseau de l'événement — mais un asset servi par
     * quelqu'un d'autre, si. D'où : tout `src`, tout `href`, relatif.
     */
    const html = coquille()
    for (const url of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((t) => t[1] as string)) {
      expect(url.startsWith('/'), url).toBe(true)
    }
  })

  it("embarque de quoi s'afficher avant le premier appel", () => {
    const html = coquille({ mode: 'dev', google: { domaine: 'cloudnord.fr' } })
    const amorce = JSON.parse(
      /<script id="console-boot" type="application\/json">(.*?)<\/script>/s.exec(html)![1]!,
    ) as { mode: string; event: { name: string }; google: { domain: string } | null }

    // Le nom de l'événement : premier mot lu, et l'attendre d'un aller-retour
    // le ferait apparaître après le reste.
    expect(amorce.event.name).toBe('Cloud Nord 2026')
    // Le mode : sans lui la console ne sait pas si la vue de développement
    // existe, et le décider dans le navigateur mettrait le code qui déplace
    // l'heure de tout le monde dans le bundle de production.
    expect(amorce.mode).toBe('dev')
    // Le bouton Google n'est proposé que si le hub sait s'en servir.
    expect(amorce.google).toEqual({ domain: 'cloudnord.fr' })
  })

  it('ne laisse pas une identité refermer la balise qui la porte', () => {
    const html = renderConsoleShell({
      mode: 'production',
      event: { name: '</script><script>alert(1)</script>', shortName: 'x' } as never,
      google: null,
      assets: { scripts: [], styles: [] },
    })
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('lit les noms hachés dans le manifeste plutôt que de les deviner', () => {
    const dossier = mkdtempSync(join(tmpdir(), 'cn-spa-'))
    mkdirSync(join(dossier, '.vite'))
    const manifeste = join(dossier, '.vite', 'manifest.json')
    writeFileSync(
      manifeste,
      JSON.stringify({
        'index.html': { file: 'assets/index-XYZ.js', css: ['assets/index-XYZ.css'], isEntry: true },
      }),
    )

    // Les empreintes sont ce qui rend `immutable` sûr, donc ce qui supprime les
    // 45 Ko de CSS retéléchargés à chaque navigation.
    expect(assetsDeProduction(manifeste)).toEqual({
      scripts: ['/admin/assets/index-XYZ.js'],
      styles: ['/admin/assets/index-XYZ.css'],
    })
  })

  it('dit ce qui manque quand le manifeste ne porte pas d’entrée', () => {
    const dossier = mkdtempSync(join(tmpdir(), 'cn-spa-'))
    const manifeste = join(dossier, 'manifest.json')
    writeFileSync(manifeste, JSON.stringify({}))

    expect(() => assetsDeProduction(manifeste)).toThrow(/index\.html/)
  })

  it('passe par le serveur de Vite en développement, sans rien construire', () => {
    expect(assetsDeDeveloppement().scripts).toEqual(['/admin/@vite/client', '/admin/src/main.ts'])
  })
})
