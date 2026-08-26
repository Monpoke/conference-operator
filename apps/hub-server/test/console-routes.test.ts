import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundledConsolePaths } from '@cloudnord/contract'
import { createHub, type Hub } from '../src/server.js'
import { resoudreConsole } from '../src/pages/console-shell.js'

/**
 * Ce que sert le hub sur les adresses reprises par le bundle.
 *
 * Le test décrit les **deux** situations, parce que les deux existent pour de
 * vrai : la console est construite dans l'image, elle ne l'est pas en intégration
 * continue — `dist/` n'est pas versionné et `pnpm test` ne déclenche aucun build
 * Vite, ce qui est précisément ce qui garde la suite dans la minute revendiquée.
 *
 * Faire dépendre ces assertions d'un artefact construit ou non les rendrait
 * ingérables ; les écrire pour les deux dit ce que le hub promet dans chacune.
 */

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

let hub: Hub
let origin: string

beforeEach(async () => {
  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
  })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  const port = typeof address === 'object' && address != null ? address.port : 0
  origin = `http://127.0.0.1:${port}`
  hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
})

afterEach(async () => {
  await hub.close()
})

describe('adresses reprises par le bundle', () => {
  it('en sert au moins une', () => {
    // Garde-fou du garde-fou : une liste vide ferait passer tout ce qui suit
    // sans rien exercer.
    expect(bundledConsolePaths(false).length).toBeGreaterThan(0)
  })

  it('répond, quel que soit l’état du bundle', async () => {
    for (const chemin of bundledConsolePaths(false)) {
      const reponse = await fetch(`${origin}${chemin}`)
      // Jamais 404 et jamais 503 : l'adresse existe, et il y a toujours quelque
      // chose à servir — la coquille si le bundle est là, le gabarit sinon.
      expect(reponse.status, chemin).toBe(200)
    }
  })

  it('sert la coquille quand le bundle est construit, le gabarit sinon', async () => {
    const bundle = resoudreConsole()
    const chemin = bundledConsolePaths(false)[0]!
    const html = await (await fetch(`${origin}${chemin}`)).text()

    if (bundle == null) {
      /*
       * Le repli n'est pas une consolation : le gabarit existe toujours et
       * fonctionne. Refuser de servir parce qu'un artefact manque punirait
       * l'exploitation pour un défaut de construction, alors qu'il y a une
       * console parfaitement utilisable sous la main.
       */
      expect(html).toContain('console hub')
    } else {
      expect(html).toContain('id="console-boot"')
      // Empreinte dans le nom : c'est ce qui rend `immutable` sûr côté assets.
      expect(html).toMatch(/src="\/admin\/assets\/[^"]+\.js"/)
    }
  })

  it('ne met jamais la coquille en cache', async () => {
    const chemin = bundledConsolePaths(false)[0]!
    const reponse = await fetch(`${origin}${chemin}`)
    if (resoudreConsole() != null) {
      // Une console mise à jour qui ne l'est jamais sur le poste d'un opérateur
      // est pire que la retélécharger à chaque ouverture.
      expect(reponse.headers.get('cache-control')).toBe('no-store')
    }
  })
})
