import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HUB_ADDRESS,
  imposedAddress,
  normalizeHubAddress,
  resolveHubAddress,
} from '../src/main/hub-address.js'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-hub-'))
  path = join(dir, 'hub')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A simulated entry screen: returns what it is told, and notes what it is offered. */
function screen(answer: string | null) {
  const offered: string[] = []
  const ask = vi.fn(async (initialValue: string) => {
    offered.push(initialValue)
    return answer
  })
  return { ask, offered }
}

describe("normalisation de l'adresse saisie", () => {
  it('complète le schéma absent : on tape une IP et un port, pas une URL', () => {
    expect(normalizeHubAddress('192.168.1.10:8787')).toBe('http://192.168.1.10:8787')
    expect(normalizeHubAddress('  hub.cloudnord.fr  ')).toBe('http://hub.cloudnord.fr')
  })

  it('garde https quand il est écrit', () => {
    expect(normalizeHubAddress('https://hub.cloudnord.fr')).toBe('https://hub.cloudnord.fr')
  })

  it("retire path et barre finale : tout le client résout des chemins absolus", () => {
    expect(normalizeHubAddress('http://hub:8787/admin')).toBe('http://hub:8787')
    expect(normalizeHubAddress('http://hub:8787/')).toBe('http://hub:8787')
  })

  it('refuse, en disant pourquoi, ce qui ne peut pas joindre un hub', () => {
    expect(() => normalizeHubAddress('  ')).toThrow(/vide/i)
    expect(() => normalizeHubAddress('ftp://hub')).toThrow(/http/i)
    expect(() => normalizeHubAddress('http://')).toThrow()
  })
})

describe("adresse dictée du dehors", () => {
  it("lit --hub par préfixe : l'argv d'un paquet et celui d'un `electron` diffèrent", () => {
    expect(imposedAddress(['Régie de salle.exe', '--hub=http://hub:8787'], {})).toEqual({
      value: 'http://hub:8787',
      source: 'argument',
    })
    expect(imposedAddress(['electron', 'dist/main.cjs', '--hub', 'http://hub:8787'], {})).toEqual({
      value: 'http://hub:8787',
      source: 'argument',
    })
  })

  it("passe la main à HUB_ORIGIN, et l'argument l'emporte sur lui", () => {
    expect(imposedAddress(['electron'], { HUB_ORIGIN: 'http://env:8787' })).toEqual({
      value: 'http://env:8787',
      source: 'environnement',
    })
    expect(imposedAddress(['--hub=http://arg:8787'], { HUB_ORIGIN: 'http://env:8787' })?.value).toBe(
      'http://arg:8787',
    )
  })

  it('ignore une variable vide plutôt que de la prendre pour une adresse', () => {
    expect(imposedAddress(['electron'], { HUB_ORIGIN: '   ' })).toBeNull()
  })
})

describe('résolution au démarrage', () => {
  it('demande à chaque lancement, en proposant la dernière adresse retenue', async () => {
    const first = screen('192.168.1.10:8787')
    const address = await resolveHubAddress({ path, argv: [], env: {}, ask: first.ask })

    expect(address).toBe('http://192.168.1.10:8787')
    // Proposé : le défaut de développement, faute de mieux à proposer.
    expect(first.offered).toEqual([DEFAULT_HUB_ADDRESS])
    expect(readFileSync(path, 'utf8')).toBe('http://192.168.1.10:8787')

    // Au lancement suivant, la question est reposée — mais la réponse est déjà
    // dans le champ : valider repart sur le même hub.
    const second = screen('http://192.168.1.10:8787')
    expect(
      await resolveHubAddress({ path, argv: [], env: {}, ask: second.ask }),
    ).toBe('http://192.168.1.10:8787')
    expect(second.offered).toEqual(['http://192.168.1.10:8787'])
  })

  it("n'ouvre aucune fenêtre quand l'adresse est dictée : un raccourci n'a personne pour répondre", async () => {
    const entry = screen(null)
    await resolveHubAddress({
      path,
      argv: [],
      env: { HUB_ORIGIN: 'http://env:8787' },
      ask: entry.ask,
    })
    expect(entry.ask).not.toHaveBeenCalled()
  })

  it("rend null quand l'opérateur ferme sans valider : il n'y a rien à démarrer", async () => {
    expect(
      await resolveHubAddress({ path, argv: [], env: {}, ask: screen(null).ask }),
    ).toBeNull()
  })

  it("provisionne la machine à l'argument, et c'est aussi comme cela qu'on en change", async () => {
    writeFileSync(path, 'http://ancien:8787', 'utf8')
    const entry = screen(null)

    const address = await resolveHubAddress({
      path,
      argv: ['--hub=http://nouveau:8787'],
      env: {},
      ask: entry.ask,
    })

    expect(address).toBe('http://nouveau:8787')
    expect(readFileSync(path, 'utf8')).toBe('http://nouveau:8787')
    expect(entry.ask).not.toHaveBeenCalled()
  })

  it("garde la main à l'opérateur : la mémorisée n'est qu'une proposition", async () => {
    writeFileSync(path, 'http://ancien:8787', 'utf8')
    const entry = screen('http://nouveau:8787')

    const address = await resolveHubAddress({ path, argv: [], env: {}, ask: entry.ask })

    expect(entry.offered).toEqual(['http://ancien:8787'])
    expect(address).toBe('http://nouveau:8787')
    expect(readFileSync(path, 'utf8')).toBe('http://nouveau:8787')
  })

  it("dit à voix haute qu'un argument est refusé, plutôt que de démarrer sur celui d'hier", async () => {
    writeFileSync(path, 'http://ancien:8787', 'utf8')
    const onLog = vi.fn()
    const entry = screen('http://choisi:8787')

    const address = await resolveHubAddress({
      path,
      argv: ['--hub=ftp://hub'],
      env: {},
      ask: entry.ask,
      onLog,
    })

    expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('argument'))
    // La valeur fautive est remise sous les yeux : c'est elle qu'on corrige.
    expect(entry.offered).toEqual(['ftp://hub'])
    expect(address).toBe('http://choisi:8787')
  })

  it('redemande quand le fichier mémorisé est illisible', async () => {
    writeFileSync(path, 'ftp://n-importe-quoi', 'utf8')
    const onLog = vi.fn()
    const entry = screen('http://hub:8787')

    const address = await resolveHubAddress({
      path,
      argv: [],
      env: {},
      ask: entry.ask,
      onLog,
    })

    expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('mémorisée'))
    expect(entry.offered).toEqual([DEFAULT_HUB_ADDRESS])
    expect(address).toBe('http://hub:8787')
  })
})
