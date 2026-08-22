import { describe, expect, it } from 'vitest'
import { decalageDuMode, lireMode } from '../src/core/mode.js'

/**
 * Mode d'exécution de la salle.
 *
 * Le garde-fou qui compte : les commodités de développement ne s'appliquent
 * **que** en `MODE=dev`. Un `OBS_MOCK=1` oublié dans un raccourci, c'est une
 * journée entière filmée par une instance OBS qui n'existe pas, et la panne se
 * découvre au montage — quand il n'y a plus rien à rattraper.
 */
describe('mode de la salle', () => {
  it('est en production quand rien n\'est demandé', () => {
    // Le défaut doit être le cas dangereux, pas le cas confortable.
    expect(lireMode({})).toEqual({
      mode: 'production',
      obsSimule: false,
      heureSimulee: null,
      ignores: [],
    })
  })

  it('neutralise les réglages de développement hors du mode dev', () => {
    const mode = lireMode({ HEURE_SIMULEE: '2026-10-30T10:20:00Z' })

    expect(mode.obsSimule).toBe(false)
    expect(mode.heureSimulee).toBeNull()
    // Et le dit, avec la raison : quelqu'un croit avoir réglé quelque chose.
    expect(mode.ignores).toEqual([
      { variable: 'HEURE_SIMULEE', raison: 'réservé au mode développement (MODE=dev)' },
    ])
  })

  it('signale OBS_MOCK comme obsolète, dans les deux modes', () => {
    // Il ne fait plus rien nulle part : en développement, OBS est simulé par
    // défaut. Le trouver dans un raccourci veut dire que quelqu'un compte
    // dessus — et compter sur un OBS simulé le jour J coûte la journée.
    for (const env of [{ OBS_MOCK: '1' }, { MODE: 'dev', OBS_MOCK: '1' }]) {
      expect(lireMode(env).ignores).toContainEqual({
        variable: 'OBS_MOCK',
        raison: 'remplacé par MODE=dev, qui simule OBS par défaut (OBS_REEL=1 pour de vraies instances)',
      })
    }
  })

  it('ne s\'alarme ni d\'un OBS_REEL ni d\'un OBS_MOCK à zéro', () => {
    // `OBS_REEL` est sans effet en production, mais ce qu'il demande est
    // justement ce qui se passe : avertir sèmerait le doute pour rien.
    expect(lireMode({ OBS_REEL: '1' }).ignores).toEqual([])
    expect(lireMode({ OBS_MOCK: '0' }).ignores).toEqual([])
  })

  it('simule OBS par défaut en développement', () => {
    // Le cas courant du développement ; exiger une variable de plus pour le cas
    // courant se paie en oublis.
    expect(lireMode({ MODE: 'dev' }).obsSimule).toBe(true)
    expect(lireMode({ MODE: 'dev', OBS_REEL: '1' }).obsSimule).toBe(false)
  })

  it('accepte une heure locale simulée en développement', () => {
    const mode = lireMode({ MODE: 'dev', HEURE_SIMULEE: '2026-10-30T10:20:00Z' })

    expect(mode.heureSimulee).toBe('2026-10-30T10:20:00Z')
    expect(mode.ignores).toEqual([])
  })
})

describe('heure simulée de la salle', () => {
  it('ne décale rien quand rien n\'est simulé', () => {
    expect(decalageDuMode(lireMode({ MODE: 'dev' }))).toBe(0)
  })

  it('rend un décalage, et non une horloge de remplacement', () => {
    /**
     * Le défaut que cette forme supprime : tout le reste du client compte à
     * partir de `Date.now()` — les pages servies, qui n'ont que l'horloge du
     * navigateur, et la file de remontée. Remplacer l'horloge du seul cœur
     * applicatif les faisait diverger en silence, et la régie cherchait ses
     * conférences des semaines après la fin de l'événement.
     */
    const base = () => Date.parse('2026-08-21T18:00:00Z')
    const decalage = decalageDuMode(
      lireMode({ MODE: 'dev', HEURE_SIMULEE: '2026-10-30T10:20:00Z' }),
      base,
    )

    expect(new Date(base() + decalage).toISOString()).toBe('2026-10-30T10:20:00.000Z')
    // Et l'heure avance au rythme réel : un compte à rebours figé ne se
    // distinguerait pas d'un écran planté.
    expect(new Date(base() + 90_000 + decalage).toISOString()).toBe('2026-10-30T10:21:30.000Z')
  })

  it('refuse une heure illisible plutôt que de démarrer de travers', () => {
    expect(() => decalageDuMode(lireMode({ MODE: 'dev', HEURE_SIMULEE: 'hier soir' }))).toThrow(
      /illisible/,
    )
  })
})
