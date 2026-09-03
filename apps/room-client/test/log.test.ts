import { describe, expect, it } from 'vitest'
import { OutageTracker, formatDuration } from '../src/core/interruptions.js'
import { formatLogLine } from '../src/core/console-log.js'

/** Horloge pilotée : une coupure d'une heure ne doit pas durer une heure. */
function horloge(depart = 0) {
  let maintenant = depart
  return { lire: () => maintenant, avancer: (ms: number) => (maintenant += ms) }
}

describe('suivi des interruptions', () => {
  it('trace le premier échec, pas les suivants', () => {
    // Le flux de commandes réessaie toutes les 2 s : une demi-heure hors ligne
    // écrivait 900 lignes identiques et noyait tout le reste du journal.
    const temps = horloge()
    const suivi = new OutageTracker('flux de commandes', temps.lire)

    expect(suivi.failure().message).toMatch(/interrompu, nouvelle tentative/)
    for (let i = 0; i < 20; i += 1) {
      temps.avancer(2_000)
      if (i < 20) expect(suivi.failure().message).toBeNull()
    }
  })

  it('rappelle la coupure une fois par minute, avec son ampleur', () => {
    const temps = horloge()
    const suivi = new OutageTracker('flux de commandes', temps.lire)
    suivi.failure()

    temps.avancer(61_000)
    const rappel = suivi.failure()
    expect(rappel.message).toMatch(/toujours interrompu/)
    expect(rappel.message).toMatch(/1 min 01 s/)
    expect(rappel.attempts).toBe(2)
  })

  it('annonce le rétablissement, avec la durée réelle', () => {
    // C'est l'information qui manquait : devant une pile de « nouvelle
    // tentative », rien ne disait si la salle s'était rattachée.
    const temps = horloge()
    const suivi = new OutageTracker('flux du mur', temps.lire)
    suivi.failure()
    temps.avancer(8_000)
    suivi.failure()

    temps.avancer(2_000)
    const retour = suivi.restored()
    expect(retour?.message).toBe('flux du mur rétabli après 10 s et 2 tentatives')
  })

  it('ne présente pas le premier raccordement comme un rétablissement', () => {
    const suivi = new OutageTracker('flux de commandes', horloge().lire)
    expect(suivi.restored()).toBeNull()
  })

  it('repart à zéro après un rétablissement', () => {
    const temps = horloge()
    const suivi = new OutageTracker('flux de commandes', temps.lire)
    suivi.failure()
    temps.avancer(3_000)
    suivi.restored()

    // Une seconde coupure doit se tracer comme la première, pas être avalée
    // par le silence hérité de la précédente.
    expect(suivi.failure().message).toMatch(/interrompu, nouvelle tentative/)
  })

  it('met les durées sous une forme lisible', () => {
    expect(formatDuration(9_400)).toBe('9 s')
    expect(formatDuration(95_000)).toBe('1 min 35 s')
    expect(formatDuration(3_900_000)).toBe('1 h 05')
  })
})

describe('format des lignes de journal', () => {
  const a = (h: number, m: number, s: number) => new Date(2026, 9, 30, h, m, s)

  it("porte l'heure locale en tête", () => {
    // Ce qui manquait : devant une pile de reconnexions, savoir si elles datent
    // de dix secondes ou d'une heure change la conduite à tenir.
    expect(formatLogLine('info', 'hub rejoint', undefined, a(9, 5, 3))).toBe(
      '09:05:03 · hub rejoint',
    )
  })

  it('distingue les niveaux par un marqueur aligné', () => {
    expect(formatLogLine('warn', 'flux coupé', undefined, a(14, 30, 0))).toContain(' ! ')
    expect(formatLogLine('error', 'jeton refusé', undefined, a(14, 30, 0))).toContain(' ✕ ')
  })

  it("aplatit le cas courant d'un contexte à une seule information", () => {
    // `{"message":"WebSocket closed (code 1006: )"}` ajoutait des accolades
    // autour de la seule chose utile de la ligne.
    const ligne = formatLogLine(
      'warn',
      'flux de commandes interrompu',
      { message: 'WebSocket closed (code 1006: )' },
      a(14, 30, 0),
    )
    expect(ligne).toBe('14:30:00 ! flux de commandes interrompu — WebSocket closed (code 1006: )')
  })

  it('garde les clés quand le contexte en porte plusieurs', () => {
    const ligne = formatLogLine('info', 'assets préchargés', { downloaded: 34, failed: [] }, a(8, 0, 0))
    expect(ligne).toBe('08:00:00 · assets préchargés downloaded=34 failed=[]')
  })
})
