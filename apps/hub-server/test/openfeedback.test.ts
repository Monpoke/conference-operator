import { describe, expect, it } from 'vitest'
import { controlerOpenFeedback } from '../src/services/openfeedback.js'

/**
 * Le contrôle des liens « notez ce talk ».
 *
 * Ce qui compte ici n'est pas de savoir compter : c'est de ne pas confondre les
 * trois issues. Un projet introuvable, un projet dont les talks vivent
 * ailleurs, et un projet dont certains créneaux manquent réellement se
 * corrigent à trois endroits différents — et la deuxième, prise pour la
 * troisième, ferait crier au loup sur un événement parfaitement configuré.
 */

const BASE = 'https://exemple.test/projects'

/** Répond comme Firestore : un document, une liste, ou un 404. */
function hubFirestore(routes: Record<string, { status?: number; body?: unknown }>): typeof fetch {
  return (async (entree: URL | RequestInfo) => {
    const url = new URL(String(entree))
    const chemin = url.pathname
    const route = routes[chemin]
    if (route == null) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 })
  }) as typeof fetch
}

const CRENEAUX = [
  { id: 'ses-1', title: 'HoneySwamp', feedbackId: 'ses-1' },
  { id: 'ses-2', title: 'Event Iterators', feedbackId: 'ses-2' },
]

describe('contrôle OpenFeedback', () => {
  it('signale un projet introuvable', async () => {
    // La panne la plus bête et la plus totale : une faute de frappe dans un
    // champ, et les vingt-sept adresses sont mortes d'un coup.
    const controle = await controlerOpenFeedback('cloud-nrod-2026', CRENEAUX, {
      base: BASE,
      fetchImpl: hubFirestore({}),
    })

    expect(controle.projetTrouve).toBe(false)
    expect(controle.talksConnus).toBeNull()
    expect(controle.manquants).toEqual([])
  })

  it('distingue « aucun talk stocké » de « aucun talk trouvé »', async () => {
    // Firestore rend `{}` — sans clé `documents` — quand la collection n'existe
    // pas. C'est le cas d'un projet qui lit ses sessions d'une source externe :
    // la concordance est alors vraie par construction. Le prendre pour un
    // manque signalerait les vingt-sept créneaux, et un contrôle qui crie au
    // loup ne se relance jamais.
    const controle = await controlerOpenFeedback('cloud-nord-2026', CRENEAUX, {
      base: BASE,
      fetchImpl: hubFirestore({
        '/projects/cloud-nord-2026': { body: { name: 'projects/…/cloud-nord-2026' } },
        '/projects/cloud-nord-2026/talks': { body: {} },
      }),
    })

    expect(controle.projetTrouve).toBe(true)
    expect(controle.talksConnus).toBeNull()
    expect(controle.manquants).toEqual([])
    expect(controle.detail).toContain('source externe')
  })

  it('nomme les créneaux sans page chez OpenFeedback', async () => {
    const controle = await controlerOpenFeedback('cloud-nord-2026', CRENEAUX, {
      base: BASE,
      fetchImpl: hubFirestore({
        '/projects/cloud-nord-2026': { body: { name: 'projects/…/cloud-nord-2026' } },
        '/projects/cloud-nord-2026/talks': {
          body: { documents: [{ name: 'projects/x/talks/ses-1' }] },
        },
      }),
    })

    expect(controle.talksConnus).toBe(1)
    expect(controle.manquants).toEqual([
      { sessionId: 'ses-2', title: 'Event Iterators', feedbackId: 'ses-2' },
    ])
  })

  it('compare l\'identifiant **servi**, pas celui de l\'export', async () => {
    // Tout l'intérêt de la correction : un créneau rendu à un autre identifiant
    // doit être cherché sous celui-là, sinon le contrôle le déclarerait
    // manquant alors qu'on vient justement de le réparer.
    const controle = await controlerOpenFeedback(
      'cloud-nord-2026',
      [{ id: 'ses-1', title: 'HoneySwamp', feedbackId: 'of-42' }],
      {
        base: BASE,
        fetchImpl: hubFirestore({
          '/projects/cloud-nord-2026': { body: { name: 'projects/…/cloud-nord-2026' } },
          '/projects/cloud-nord-2026/talks': {
            body: { documents: [{ name: 'projects/x/talks/of-42' }] },
          },
        }),
      },
    )

    expect(controle.manquants).toEqual([])
  })

  it('suit la pagination avant de déclarer un manque', async () => {
    // Déclarer « manquant » ce qui était simplement page deux serait pire
    // qu'inutile : on corrigerait un identifiant qui allait très bien.
    let appels = 0
    const fetchImpl = (async (entree: URL | RequestInfo) => {
      const url = new URL(String(entree))
      if (!url.pathname.endsWith('/talks')) {
        return new Response(JSON.stringify({ name: 'projects/…' }), { status: 200 })
      }
      appels += 1
      return appels === 1
        ? new Response(
            JSON.stringify({
              documents: [{ name: 'projects/x/talks/ses-1' }],
              nextPageToken: 'suite',
            }),
            { status: 200 },
          )
        : new Response(
            JSON.stringify({ documents: [{ name: 'projects/x/talks/ses-2' }] }),
            { status: 200 },
          )
    }) as typeof fetch

    const controle = await controlerOpenFeedback('cloud-nord-2026', CRENEAUX, {
      base: BASE,
      fetchImpl,
    })

    expect(appels).toBe(2)
    expect(controle.talksConnus).toBe(2)
    expect(controle.manquants).toEqual([])
  })

  it('décode un identifiant échappé dans le chemin Firestore', async () => {
    // `name` est un chemin, et Firestore y encode ce qui doit l'être. Comparer
    // la forme encodée à l'identifiant du programme ferait un faux manque.
    const controle = await controlerOpenFeedback(
      'cloud-nord-2026',
      [{ id: 'a b', title: 'Avec espace', feedbackId: 'a b' }],
      {
        base: BASE,
        fetchImpl: hubFirestore({
          '/projects/cloud-nord-2026': { body: { name: 'projects/…' } },
          '/projects/cloud-nord-2026/talks': {
            body: { documents: [{ name: 'projects/x/talks/a%20b' }] },
          },
        }),
      },
    )

    expect(controle.manquants).toEqual([])
  })

  it('lève quand OpenFeedback répond une erreur', async () => {
    // Traduit en 502 par le routeur : un contrôle qui échoue doit dire
    // pourquoi, sinon on ne le relance pas.
    await expect(
      controlerOpenFeedback('cloud-nord-2026', CRENEAUX, {
        base: BASE,
        fetchImpl: hubFirestore({
          '/projects/cloud-nord-2026': { status: 500 },
        }),
      }),
    ).rejects.toThrow('500')
  })
})
