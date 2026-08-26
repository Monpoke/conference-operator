import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADRESSE_HUB_PAR_DEFAUT,
  adresseImposee,
  normaliserAdresseHub,
  resoudreAdresseHub,
} from '../src/main/adresse-hub.js'

let dir: string
let chemin: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-hub-'))
  chemin = join(dir, 'hub')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Écran de saisie simulé : rend ce qu'on lui dit, et note ce qu'on lui propose. */
function ecran(reponse: string | null) {
  const proposees: string[] = []
  const demander = vi.fn(async (valeurInitiale: string) => {
    proposees.push(valeurInitiale)
    return reponse
  })
  return { demander, proposees }
}

describe("normalisation de l'adresse saisie", () => {
  it('complète le schéma absent : on tape une IP et un port, pas une URL', () => {
    expect(normaliserAdresseHub('192.168.1.10:8787')).toBe('http://192.168.1.10:8787')
    expect(normaliserAdresseHub('  hub.cloudnord.fr  ')).toBe('http://hub.cloudnord.fr')
  })

  it('garde https quand il est écrit', () => {
    expect(normaliserAdresseHub('https://hub.cloudnord.fr')).toBe('https://hub.cloudnord.fr')
  })

  it("retire chemin et barre finale : tout le client résout des chemins absolus", () => {
    expect(normaliserAdresseHub('http://hub:8787/admin')).toBe('http://hub:8787')
    expect(normaliserAdresseHub('http://hub:8787/')).toBe('http://hub:8787')
  })

  it('refuse, en disant pourquoi, ce qui ne peut pas joindre un hub', () => {
    expect(() => normaliserAdresseHub('  ')).toThrow(/vide/i)
    expect(() => normaliserAdresseHub('ftp://hub')).toThrow(/http/i)
    expect(() => normaliserAdresseHub('http://')).toThrow()
  })
})

describe("adresse dictée du dehors", () => {
  it("lit --hub par préfixe : l'argv d'un paquet et celui d'un `electron` diffèrent", () => {
    expect(adresseImposee(['Régie de salle.exe', '--hub=http://hub:8787'], {})).toEqual({
      valeur: 'http://hub:8787',
      source: 'argument',
    })
    expect(adresseImposee(['electron', 'dist/main.cjs', '--hub', 'http://hub:8787'], {})).toEqual({
      valeur: 'http://hub:8787',
      source: 'argument',
    })
  })

  it("passe la main à HUB_ORIGIN, et l'argument l'emporte sur lui", () => {
    expect(adresseImposee(['electron'], { HUB_ORIGIN: 'http://env:8787' })).toEqual({
      valeur: 'http://env:8787',
      source: 'environnement',
    })
    expect(adresseImposee(['--hub=http://arg:8787'], { HUB_ORIGIN: 'http://env:8787' })?.valeur).toBe(
      'http://arg:8787',
    )
  })

  it('ignore une variable vide plutôt que de la prendre pour une adresse', () => {
    expect(adresseImposee(['electron'], { HUB_ORIGIN: '   ' })).toBeNull()
  })
})

describe('résolution au démarrage', () => {
  it('demande à chaque lancement, en proposant la dernière adresse retenue', async () => {
    const premier = ecran('192.168.1.10:8787')
    const adresse = await resoudreAdresseHub({ chemin, argv: [], env: {}, demander: premier.demander })

    expect(adresse).toBe('http://192.168.1.10:8787')
    // Proposé : le défaut de développement, faute de mieux à proposer.
    expect(premier.proposees).toEqual([ADRESSE_HUB_PAR_DEFAUT])
    expect(readFileSync(chemin, 'utf8')).toBe('http://192.168.1.10:8787')

    // Au lancement suivant, la question est reposée — mais la réponse est déjà
    // dans le champ : valider repart sur le même hub.
    const second = ecran('http://192.168.1.10:8787')
    expect(
      await resoudreAdresseHub({ chemin, argv: [], env: {}, demander: second.demander }),
    ).toBe('http://192.168.1.10:8787')
    expect(second.proposees).toEqual(['http://192.168.1.10:8787'])
  })

  it("n'ouvre aucune fenêtre quand l'adresse est dictée : un raccourci n'a personne pour répondre", async () => {
    const saisie = ecran(null)
    await resoudreAdresseHub({
      chemin,
      argv: [],
      env: { HUB_ORIGIN: 'http://env:8787' },
      demander: saisie.demander,
    })
    expect(saisie.demander).not.toHaveBeenCalled()
  })

  it("rend null quand l'opérateur ferme sans valider : il n'y a rien à démarrer", async () => {
    expect(
      await resoudreAdresseHub({ chemin, argv: [], env: {}, demander: ecran(null).demander }),
    ).toBeNull()
  })

  it("provisionne la machine à l'argument, et c'est aussi comme cela qu'on en change", async () => {
    writeFileSync(chemin, 'http://ancien:8787', 'utf8')
    const saisie = ecran(null)

    const adresse = await resoudreAdresseHub({
      chemin,
      argv: ['--hub=http://nouveau:8787'],
      env: {},
      demander: saisie.demander,
    })

    expect(adresse).toBe('http://nouveau:8787')
    expect(readFileSync(chemin, 'utf8')).toBe('http://nouveau:8787')
    expect(saisie.demander).not.toHaveBeenCalled()
  })

  it("garde la main à l'opérateur : la mémorisée n'est qu'une proposition", async () => {
    writeFileSync(chemin, 'http://ancien:8787', 'utf8')
    const saisie = ecran('http://nouveau:8787')

    const adresse = await resoudreAdresseHub({ chemin, argv: [], env: {}, demander: saisie.demander })

    expect(saisie.proposees).toEqual(['http://ancien:8787'])
    expect(adresse).toBe('http://nouveau:8787')
    expect(readFileSync(chemin, 'utf8')).toBe('http://nouveau:8787')
  })

  it("dit à voix haute qu'un argument est refusé, plutôt que de démarrer sur celui d'hier", async () => {
    writeFileSync(chemin, 'http://ancien:8787', 'utf8')
    const onLog = vi.fn()
    const saisie = ecran('http://choisi:8787')

    const adresse = await resoudreAdresseHub({
      chemin,
      argv: ['--hub=ftp://hub'],
      env: {},
      demander: saisie.demander,
      onLog,
    })

    expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('argument'))
    // La valeur fautive est remise sous les yeux : c'est elle qu'on corrige.
    expect(saisie.proposees).toEqual(['ftp://hub'])
    expect(adresse).toBe('http://choisi:8787')
  })

  it('redemande quand le fichier mémorisé est illisible', async () => {
    writeFileSync(chemin, 'ftp://n-importe-quoi', 'utf8')
    const onLog = vi.fn()
    const saisie = ecran('http://hub:8787')

    const adresse = await resoudreAdresseHub({
      chemin,
      argv: [],
      env: {},
      demander: saisie.demander,
      onLog,
    })

    expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('mémorisée'))
    expect(saisie.proposees).toEqual([ADRESSE_HUB_PAR_DEFAUT])
    expect(adresse).toBe('http://hub:8787')
  })
})
