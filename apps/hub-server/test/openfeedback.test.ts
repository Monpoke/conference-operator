import { describe, expect, it } from 'vitest'
import { checkOpenFeedback } from '../src/services/openfeedback.js'

/**
 * The check on the "rate this talk" links.
 *
 * What matters here is not being able to count: it is not confusing the three
 * outcomes. A project that cannot be found, a project whose talks live elsewhere,
 * and a project where some slots really are missing get fixed in three different
 * places — and the second, taken for the third, would cry wolf about a perfectly
 * configured event.
 */

const BASE = 'https://exemple.test/projects'

/** Answers like Firestore: a document, a list, or a 404. */
function hubFirestore(routes: Record<string, { status?: number; body?: unknown }>): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input))
    const path = url.pathname
    const route = routes[path]
    if (route == null) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 })
  }) as typeof fetch
}

const SLOTS = [
  { id: 'ses-1', title: 'HoneySwamp', feedbackId: 'ses-1' },
  { id: 'ses-2', title: 'Event Iterators', feedbackId: 'ses-2' },
]

// `projetTrouve`, `talksConnus` and `manquants` are contract field names: they do
// not get renamed.
describe('OpenFeedback check', () => {
  it('reports a project that cannot be found', async () => {
    // The dumbest and most total failure: one typo in a field, and the
    // twenty-seven addresses are dead at once.
    const check = await checkOpenFeedback('cloud-nrod-2026', SLOTS, {
      base: BASE,
      fetchImpl: hubFirestore({}),
    })

    expect(check.projetTrouve).toBe(false)
    expect(check.talksConnus).toBeNull()
    expect(check.manquants).toEqual([])
  })

  it('tells "no talk stored" from "no talk found"', async () => {
    // Firestore returns `{}` — with no `documents` key — when the collection does
    // not exist. That is the case of a project reading its sessions from an
    // external source: the match is then true by construction. Taking it for a
    // gap would report the twenty-seven slots, and a check that cries wolf never
    // gets run again.
    const check = await checkOpenFeedback('cloud-nord-2026', SLOTS, {
      base: BASE,
      fetchImpl: hubFirestore({
        '/projects/cloud-nord-2026': { body: { name: 'projects/…/cloud-nord-2026' } },
        '/projects/cloud-nord-2026/talks': { body: {} },
      }),
    })

    expect(check.projetTrouve).toBe(true)
    expect(check.talksConnus).toBeNull()
    expect(check.manquants).toEqual([])
    expect(check.detail).toContain('source externe')
  })

  it('names the slots with no page at OpenFeedback', async () => {
    const check = await checkOpenFeedback('cloud-nord-2026', SLOTS, {
      base: BASE,
      fetchImpl: hubFirestore({
        '/projects/cloud-nord-2026': { body: { name: 'projects/…/cloud-nord-2026' } },
        '/projects/cloud-nord-2026/talks': {
          body: { documents: [{ name: 'projects/x/talks/ses-1' }] },
        },
      }),
    })

    expect(check.talksConnus).toBe(1)
    expect(check.manquants).toEqual([
      { sessionId: 'ses-2', title: 'Event Iterators', feedbackId: 'ses-2' },
    ])
  })

  it('compares the **served** identifier, not the export\'s', async () => {
    // The whole point of the correction: a slot rendered under another identifier
    // must be looked up under that one, otherwise the check would declare it
    // missing just after it has been repaired.
    const check = await checkOpenFeedback(
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

    expect(check.manquants).toEqual([])
  })

  it('follows the pagination before declaring a gap', async () => {
    // Declaring "missing" what was simply on page two would be worse than
    // useless: one would fix an identifier that was perfectly fine.
    let calls = 0
    const fetchImpl = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/talks')) {
        return new Response(JSON.stringify({ name: 'projects/…' }), { status: 200 })
      }
      calls += 1
      return calls === 1
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

    const check = await checkOpenFeedback('cloud-nord-2026', SLOTS, {
      base: BASE,
      fetchImpl,
    })

    expect(calls).toBe(2)
    expect(check.talksConnus).toBe(2)
    expect(check.manquants).toEqual([])
  })

  it('decodes an escaped identifier in the Firestore path', async () => {
    // `name` is a path, and Firestore encodes in it what has to be. Comparing the
    // encoded form to the program's identifier would make a false gap.
    const check = await checkOpenFeedback(
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

    expect(check.manquants).toEqual([])
  })

  it('throws when OpenFeedback answers an error', async () => {
    // Translated into a 502 by the router: a check that fails must say why,
    // otherwise nobody runs it again.
    await expect(
      checkOpenFeedback('cloud-nord-2026', SLOTS, {
        base: BASE,
        fetchImpl: hubFirestore({
          '/projects/cloud-nord-2026': { status: 500 },
        }),
      }),
    ).rejects.toThrow('500')
  })
})
