import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '../src/server.js'

/**
 * Le hub sait de quel événement il est le hub.
 *
 * Ce que ces tests protègent est une propriété du dépôt entier : **aucune
 * surface n'écrit le nom d'un événement en dur**. Le hub le lit dans le
 * programme importé, un réglage peut le contredire, et tout le reste — mur
 * public, console, service worker, machines de salle — consomme ce qu'il a
 * tranché. Réintroduire une constante quelque part se verrait ici.
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
  origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`
})

afterEach(async () => {
  await hub.close()
})

describe('identité de l’événement', () => {
  it('reste neutre tant qu’aucun programme n’est importé', () => {
    // Un hub tout juste installé : il ne sait pas encore où il est, et le dire
    // vaut mieux que d'afficher le nom d'un autre événement.
    expect(hub.services.identity.get()).toEqual({ name: 'Événement', shortName: 'Événement' })
  })

  it('se déduit du programme importé, sans rien régler', () => {
    hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')

    // Le geste unique pour servir un autre événement : importer son export.
    expect(hub.services.identity.get()).toEqual({
      name: 'Cloud Nord 2026',
      shortName: 'Cloud Nord',
    })
  })

  it('suit le programme actif quand on revient sur une version', () => {
    hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
    const autre = JSON.parse(rawProgram) as { event: { name: string } }
    autre.event.name = 'DevFest Lille 2027'
    hub.services.programs.importFromText(JSON.stringify(autre), 'https://exemple/autre.json')

    expect(hub.services.identity.get().name).toBe('DevFest Lille 2027')
  })

  it('laisse le réglage du hub contredire l’export amont', () => {
    hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
    hub.services.settings.update({ eventName: 'Cloud Nord — répétition' })

    expect(hub.services.identity.get().name).toBe('Cloud Nord — répétition')
    // Et la déduction reste lisible : c'est ce que la console montre en
    // placeholder, pour qu'on ose vider le champ.
    expect(hub.services.identity.derived().name).toBe('Cloud Nord 2026')
  })
})

describe('surfaces servies par le hub', () => {
  beforeEach(() => {
    hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  })

  it('titre le mur public du nom de l’événement', async () => {
    const html = await (await fetch(`${origin}/mur`)).text()

    // Le premier mot que lit quelqu'un qui vient de scanner un QR : rendu côté
    // serveur, pas demandé par la page — sur la 4G d'une salle, il arriverait
    // après tout le reste.
    expect(html).toContain('<title>Cloud Nord 2026 — mur &amp; questions</title>')
  })

  it('titre la console du nom de l’événement', async () => {
    const html = await (await fetch(`${origin}/admin`)).text()

    expect(html).toContain('<title>Cloud Nord 2026 — console hub</title>')
  })

  it('donne son nom court au service worker des notifications', async () => {
    // Certains services de push réveillent le worker sans charge utile lisible :
    // c'est alors le seul nom dont il dispose pour titrer l'avis.
    const code = await (await fetch(`${origin}/sw.js`)).text()

    expect(code).toContain('"Cloud Nord"')
  })

  it('suit un renommage sans redémarrer le hub', async () => {
    hub.services.settings.update({ eventName: 'Cloud Nord — répétition' })

    const html = await (await fetch(`${origin}/mur`)).text()
    expect(html).toContain('Cloud Nord — répétition')
    // Le nom se corrige en cours d'événement ; redémarrer pour ça est
    // précisément ce qu'on ne peut pas faire ce jour-là. Le service worker
    // suit au prochain chargement de page — le navigateur le revérifie à
    // chaque fois, c'est pour ça qu'il est servi sans cache.
    const code = await (await fetch(`${origin}/sw.js`)).text()
    // Nom court inchangé : rien à retirer ici, « répétition » n'est pas un
    // millésime. La déduction est volontairement timide.
    expect(code).toContain('"Cloud Nord — répétition"')
  })

  it('échappe ce qu’il insère dans le HTML', async () => {
    hub.services.settings.update({ eventName: '<script>alert(1)</script>' })

    const html = await (await fetch(`${origin}/mur`)).text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
