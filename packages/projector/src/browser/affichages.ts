/**
 * What the social wall put on air, sent to the room machine in batches.
 *
 * A page of the wall counts once for each of its posts, when it goes live — not
 * when it is laid out off screen, which the loop does ahead of time. The counts
 * pile up here and leave every half minute: a room turns its wall over every
 * few minutes, and one request per page would only be noise.
 *
 * Never from a preview: the hub's previews and public screens draw the same
 * wall, and nobody in a room saw them. Their page has no room machine to talk to
 * anyway.
 */
const DELAI_MS = 30_000
/** Beyond this many posts held, the batch leaves at once. */
const MAX_POSTS = 400

const comptes = new Map<string, number>()
let minuteur: ReturnType<typeof setTimeout> | null = null

export function compterAffichages(ids: readonly string[]): void {
  if ((globalThis as { __PREVIEW__?: boolean }).__PREVIEW__ || ids.length === 0) return
  for (const id of ids) comptes.set(id, (comptes.get(id) ?? 0) + 1)
  if (comptes.size >= MAX_POSTS) envoyer()
  else minuteur ??= setTimeout(envoyer, DELAI_MS)
}

function envoyer(): void {
  if (minuteur != null) clearTimeout(minuteur)
  minuteur = null
  if (comptes.size === 0) return
  const counts = Object.fromEntries(comptes)
  comptes.clear()
  // The room machine is this page's own server: a failure is a restart of it,
  // and the counts wait for the next batch rather than vanish.
  const remettre = () => {
    for (const [id, n] of Object.entries(counts)) comptes.set(id, (comptes.get(id) ?? 0) + n)
    minuteur ??= setTimeout(envoyer, DELAI_MS)
  }
  fetch('/display/wall/impressions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ counts }),
    keepalive: true,
  })
    .then((response) => { if (response.status >= 500) remettre() })
    .catch(remettre)
}

// The page closing (a reload, a new version) sends what it holds. Guarded: the
// scenes are also imported where there is no page — the hub, the tests.
if (typeof addEventListener === 'function') addEventListener('pagehide', envoyer)
