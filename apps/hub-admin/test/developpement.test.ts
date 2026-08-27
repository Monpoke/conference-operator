import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createConsoleRouter } from '../src/router.js'
import { useConferencesStore } from '../src/stores/conferences.js'
import { programMoments } from '../src/stores/dev.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * Ce que la vue de développement a besoin de savoir, et qu'elle ne demandait
 * pas.
 *
 * Les raccourcis d'horloge sont déduits des créneaux du programme, jamais
 * écrits en dur — une date d'édition dans le code ne vaut que pour cette
 * édition-là. Mais rien ne chargeait ce programme : les boutons apparaissaient
 * en venant de l'onglet Conférences, qui l'avait chargé au passage, et pas
 * autrement. Le même oubli emportait le fuseau dans lequel l'heure du hub
 * s'affiche — sans lui, elle se lit dans celui du poste, ce qui est exactement
 * l'erreur que ce réglage sert à débusquer.
 */

const CRENEAUX = [
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

/** Le `refresh` que le routeur attache à l'adresse de développement. */
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
    // Un déplacement à une date sans le moindre créneau ne montre rien et ne
    // dit pas pourquoi : mieux vaut aucun bouton qu'un bouton muet.
    expect(programMoments([])).toEqual([])
  })

  it('les déduit des créneaux, et saute les pauses pour le milieu', () => {
    const moments = programMoments(CRENEAUX)
    expect(moments.map(([libelle]) => libelle)).toEqual([
      'Avant ouverture',
      'Première conférence',
      'Milieu de journée',
      'Fin de journée',
    ])
    // Le milieu vise un talk, pas le déjeuner : c'est un talk qu'on vient
    // regarder se dérouler.
    expect(moments[2]?.[1]).toBe('2026-10-30T16:05:00.000Z')
  })
})

describe('ce que l’adresse de développement charge', () => {
  it('charge le programme, sans quoi les raccourcis n’existent pas', async () => {
    await rafraichirDeveloppement()()
    await flushPromises()

    expect(appels).toContain('program/planning')
    const planning = useConferencesStore().planning
    expect(programMoments(planning?.sessions ?? [])).toHaveLength(4)
    // Et le fuseau de l'événement avec, dans lequel l'heure du hub se lit.
    expect(planning?.timezone).toBe('Europe/Paris')
  })

  it('ne le relit pas à chaque rafraîchissement', async () => {
    const refresh = rafraichirDeveloppement()
    await refresh()
    await flushPromises()
    const apresPremier = appels.filter((appel) => appel === 'program/planning').length

    await refresh()
    await flushPromises()

    /*
     * Le rafraîchissement tourne toutes les dix secondes. Le programme, lui, ne
     * bouge pas pendant qu'on pousse l'horloge : le relire ferait trois appels
     * pour une réponse identique.
     */
    expect(appels.filter((appel) => appel === 'program/planning')).toHaveLength(apresPremier)
    // L'horloge, en revanche, est relue à chaque fois : c'est elle qu'on regarde.
    expect(appels.filter((appel) => appel === 'clock/get')).toHaveLength(2)
  })
})
