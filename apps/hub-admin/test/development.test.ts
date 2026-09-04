import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createConsoleRouter } from '../src/router.js'
import { useConferencesStore } from '../src/stores/conferences.js'
import { programMoments } from '../src/stores/dev.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * What the development view needs to know, and was not asking for
 * pas.
 *
 * The clock shortcuts are deduced from the program's slots, never hard-coded — a
 * date for one edition in the code only holds for that edition. But nothing loaded
 * that program: the buttons appeared when arriving from the Conférences tab, which
 * had loaded it along the way, and not otherwise. The same omission carried away
 * the time zone in which the hub's clock
 * s'affiche — sans lui, elle se lit dans celui du poste, ce qui est exactement
 * the mistake this setting exists to flush out.
 */

/**
 * A realistic day: it **opens on a welcome**.
 *
 * C'est ce que fait l'export amont, et ce que la fixture d'origine n'avait pas
 * — it began with a talk, so that "Première conférence" could aim at whatever slot
 * came first with nothing to report it.
 */
const CRENEAUX = [
  { id: 'accueil', startsAt: '2026-10-30T07:30:00.000Z', endsAt: '2026-10-30T08:00:00.000Z', kind: 'break' },
  { id: 'a', startsAt: '2026-10-30T08:00:00.000Z', endsAt: '2026-10-30T08:45:00.000Z', kind: 'talk' },
  { id: 'b', startsAt: '2026-10-30T12:00:00.000Z', endsAt: '2026-10-30T13:00:00.000Z', kind: 'break' },
  { id: 'c', startsAt: '2026-10-30T16:00:00.000Z', endsAt: '2026-10-30T16:45:00.000Z', kind: 'talk' },
]

let appels: string[]

function stub(): void {
  appels = []
  const note =
    (chemin: string, resultat: unknown) =>
    async (): Promise<unknown> => {
      appels.push(chemin)
      return resultat
    }
  useSessionStore().client = {
    token: { read: () => 'jeton', write: () => {}, clear: () => {} },
    rpc: {
      sessions: { states: note('sessions/states', []) },
      program: {
        snapshots: note('program/snapshots', [{ active: true }]),
        planning: note('program/planning', { timezone: 'Europe/Paris', sessions: CRENEAUX }),
      },
      clock: {
        get: note('clock/get', {
          serverTime: '2026-10-30T09:00:00.000Z',
          simulated: true,
          controllable: true,
        }),
      },
    },
  } as never
}

/** The `refresh` the router attaches to the development address. */
function rafraichirDeveloppement(): () => Promise<void> {
  const route = createConsoleRouter()
    .getRoutes()
    .find((candidate) => candidate.name === 'developpement')
  return route!.meta.refresh as () => Promise<void>
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  stub()
})

describe('moments du programme', () => {
  it('ne rend aucun raccourci sans programme', () => {
    // A jump to a date with no slot at all shows nothing and does not
    // dit pas pourquoi : mieux vaut aucun bouton qu'un bouton muet.
    expect(programMoments([])).toEqual([])
  })

  it('deduces them from the slots, and skips the breaks for the midday one', () => {
    const moments = programMoments(CRENEAUX)
    expect(moments.map(([libelle]) => libelle)).toEqual([
      'Avant ouverture',
      'Première conférence',
      'Milieu de journée',
      'Fin de journée',
    ])
    // The midday one aims at a talk, not the lunch: it is a talk one comes to
    // watch unfold.
    expect(moments[2]?.[1]).toBe('2026-10-30T16:05:00.000Z')
  })

  it('aims at the first talk, not the welcome that opens the day', () => {
    /*
     * The defect being corrected: a day opens on a welcome or a breakfast, which
     * are breaks. The button therefore led thirty minutes before the first talk, and
     * one believed the clock wrong when it was the label.
     */
    const moments = programMoments(CRENEAUX)
    expect(moments[1]?.[1]).toBe('2026-10-30T08:05:00.000Z')
  })

  it('keeps "avant ouverture" on the first slot, break included', () => {
    // That one does aim at the welcome: "before opening" means before the
    // salle n'ouvre ses portes, pas avant le premier talk.
    expect(programMoments(CRENEAUX)[0]?.[1]).toBe('2026-10-30T07:00:00.000Z')
  })

  it('falls back on the first slot when the day has only breaks', () => {
    // Four buttons beat three, even if this one then aims at a lunch: a program
    // with no talk is an incomplete program, not
    // une raison de retirer un outil.
    const pauses = CRENEAUX.filter((creneau) => creneau.kind === 'break')
    expect(programMoments(pauses)[1]?.[1]).toBe('2026-10-30T07:35:00.000Z')
  })
})

describe('what the development address loads', () => {
  it('charge le programme, sans quoi les raccourcis n’existent pas', async () => {
    await rafraichirDeveloppement()()
    await flushPromises()

    expect(appels).toContain('program/planning')
    const planning = useConferencesStore().planning
    expect(programMoments(planning?.sessions ?? [])).toHaveLength(4)
    // And the event's time zone with it, in which the hub's clock is read.
    expect(planning?.timezone).toBe('Europe/Paris')
  })

  it('does not read it back on every refresh', async () => {
    const refresh = rafraichirDeveloppement()
    await refresh()
    await flushPromises()
    const apresPremier = appels.filter((appel) => appel === 'program/planning').length

    await refresh()
    await flushPromises()

    /*
     * The refresh runs every ten seconds. The program, on the other hand, does not
     * bouge pas pendant qu'on pousse l'horloge : le relire ferait trois appels
     * for an identical answer.
     */
    expect(appels.filter((appel) => appel === 'program/planning')).toHaveLength(apresPremier)
    // The clock, on the other hand, is read back every time: it is what one watches.
    expect(appels.filter((appel) => appel === 'clock/get')).toHaveLength(2)
  })
})
