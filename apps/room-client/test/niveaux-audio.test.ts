import { describe, expect, it } from 'vitest'
import { AgregateurNiveaux, proportion } from '../src/core/niveaux-audio.js'
import { multiplicateurEnDb, DB_FLOOR, type InputLevel } from '../src/core/obs.js'

function horloge(depart = 0) {
  let maintenant = depart
  return { lire: () => maintenant, avancer: (ms: number) => (maintenant += ms) }
}

const entree = (name: string, magnitude: number, peak = magnitude): InputLevel => ({
  name,
  channels: [{ magnitude, peak }],
})

describe('conversion des niveaux OBS', () => {
  it('traduit les multiplicateurs en dBFS', () => {
    // OBS raisonne en linéaire, l'ingénieur du son en dB — et c'est l'échelle
    // qu'OBS affiche lui-même.
    expect(multiplicateurEnDb(1)).toBeCloseTo(0, 5)
    expect(multiplicateurEnDb(0.5)).toBeCloseTo(-6.02, 1)
    expect(multiplicateurEnDb(0.1)).toBeCloseTo(-20, 5)
  })

  it('borne le silence au lieu de rendre moins l\'infini', () => {
    // `-Infinity` casserait tout calcul de largeur de barre côté page.
    expect(multiplicateurEnDb(0)).toBe(DB_FLOOR)
    expect(multiplicateurEnDb(-1)).toBe(DB_FLOOR)
    expect(Number.isFinite(multiplicateurEnDb(Number.NaN))).toBe(true)
  })

  it('place le niveau sur une échelle exploitable', () => {
    expect(proportion(0)).toBe(1)
    expect(proportion(-30)).toBeCloseTo(0.5, 5)
    expect(proportion(-90)).toBe(0)
  })
})

describe('agrégation du vumètre', () => {
  it('ramène 50 mesures par seconde à la cadence d\'affichage', () => {
    const temps = horloge()
    const recus: InputLevel[][] = []
    const agregateur = new AgregateurNiveaux((inputs) => recus.push(inputs), 100, temps.lire)

    // Une seconde de mesures OBS, toutes les 20 ms.
    for (let i = 0; i < 50; i += 1) {
      agregateur.pousser([entree('Micro', -30)])
      temps.avancer(20)
    }
    // Dix envois plutôt que cinquante : c'est ce qui garde le flux d'état
    // silencieux au repos.
    expect(recus.length).toBeLessThanOrEqual(11)
    expect(recus.length).toBeGreaterThanOrEqual(9)
  })

  it('conserve la crête la plus brève entre deux envois', () => {
    // Le point qui compte : échantillonner une mesure sur cinq ferait manquer
    // une saturation d'un dixième de seconde — précisément ce qu'on regarde.
    const temps = horloge()
    const recus: InputLevel[][] = []
    const agregateur = new AgregateurNiveaux((inputs) => recus.push(inputs), 100, temps.lire)

    agregateur.pousser([entree('Micro', -40)])
    temps.avancer(20)
    agregateur.pousser([entree('Micro', -2, -1)])
    temps.avancer(20)
    agregateur.pousser([entree('Micro', -40)])
    temps.avancer(100)
    agregateur.pousser([entree('Micro', -40)])

    expect(recus[0]![0]!.channels[0]!.magnitude).toBe(-2)
    expect(recus[0]![0]!.channels[0]!.peak).toBe(-1)
  })

  it('suit chaque entrée séparément, et chaque canal', () => {
    const temps = horloge()
    const recus: InputLevel[][] = []
    const agregateur = new AgregateurNiveaux((inputs) => recus.push(inputs), 100, temps.lire)

    agregateur.pousser([
      { name: 'Micro', channels: [{ magnitude: -30, peak: -28 }] },
      { name: 'Ambiance', channels: [{ magnitude: -50, peak: -50 }, { magnitude: -12, peak: -10 }] },
    ])
    temps.avancer(150)
    agregateur.pousser([{ name: 'Micro', channels: [{ magnitude: -35, peak: -35 }] }])

    const [micro, ambiance] = recus[0]!
    expect(micro!.channels[0]!.magnitude).toBe(-30)
    // La saturation du canal droit ne doit pas être noyée par le canal gauche.
    expect(ambiance!.channels[1]!.magnitude).toBe(-12)
    expect(ambiance!.channels[0]!.magnitude).toBe(-50)
  })

  it('retombe au silence plutôt que de figer la dernière mesure', () => {
    // OBS déconnecté : une régie muette ne doit pas continuer à montrer du
    // signal, sinon on croit le micro ouvert.
    const temps = horloge()
    const recus: InputLevel[][] = []
    const agregateur = new AgregateurNiveaux((inputs) => recus.push(inputs), 100, temps.lire)

    agregateur.pousser([entree('Micro', -10)])
    agregateur.reinitialiser()
    temps.avancer(500)
    agregateur.pousser([entree('Micro', -45)])

    expect(recus.at(-1)![0]!.channels[0]!.magnitude).toBe(-45)
  })
})
