import { z } from 'zod'
import type { OpenFeedbackCheck } from '@cloudnord/contract'

/**
 * Checking that the "rate this talk" links lead somewhere.
 *
 * The hub builds those addresses offline — `{project}/{day}/{id}` — betting that
 * OpenFeedback reuses the session identifiers of the upstream export. The bet
 * holds, but it is lost silently: the link stays clickable, the QR code stays
 * scannable, and both lead to a page that talks about no talk. Nobody notices
 * before the feedback is missing, which is to say once the event is over.
 *
 * This module is the only thing in the hub that calls OpenFeedback, and it only
 * does so on demand: nothing here runs in the background. A check is a pre-event
 * gesture — you run it once, when the program has just been imported, and you
 * correct what it reports.
 *
 * **Public read, no key.** OpenFeedback is a Firebase application, and its
 * Firestore rules open `projects/{project}` and `projects/{project}/talks` to
 * everyone — that is the data its public page already shows. So we read
 * Firestore's REST API directly, with no account and no secret to put on the hub.
 * There is no documented REST API on the OpenFeedback side: this is the only
 * path, and it is stable because those rules are the product's public surface.
 */

/** OpenFeedback's Firebase project. Public: it is in their repository and SDKs. */
const FIREBASE_PROJECT = 'open-feedback-42'

const BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/projects`

/** Beyond this we give up: the check is optional, the wait is not. */
const TIMEOUT_MS = 8_000

/**
 * Firestore listing response, reduced to what we read.
 *
 * `documents` is **absent** — and not empty — when the collection does not exist:
 * Firestore then returns `{}` with a 200. That is exactly the case of a project
 * whose talks live elsewhere, and it must on no account be confused with "none of
 * your twenty-seven slots exists".
 */
const talkListSchema = z.object({
  documents: z
    .array(z.object({ name: z.string() }))
    .optional(),
  nextPageToken: z.string().optional(),
})

/**
 * The last segment of a Firestore document's path, decoded.
 *
 * `name` is a full path — `projects/…/documents/projects/x/talks/ses-1` — and
 * only its last segment is the identifier that appears in the public URL.
 */
function documentId(name: string): string {
  const segments = name.split('/')
  return decodeURIComponent(segments[segments.length - 1] ?? '')
}

export interface OpenFeedbackOptions {
  fetchImpl?: typeof fetch
  /** Overridable for the tests: nothing else must point elsewhere. */
  base?: string
}

/**
 * Compares the program's identifiers with what OpenFeedback knows.
 *
 * Three possible answers, and they are not equivalent:
 *
 * - **Project not found** (404): the configured slug does not exist. It is the
 *   most frequent and the silliest failure — a typo — and it kills every address
 *   at once.
 * - **Project found, talks absent**: OpenFeedback does not store that project's
 *   sessions; it reads them from an external source (the organizer's export). The
 *   match is then true by construction, and there is nothing to compare. We **say
 *   so**, instead of reporting twenty-seven slots as missing when they are not: a
 *   check that cries wolf never gets run again.
 * - **Project found, talks listed**: we compare, and we name those with no
 *   counterpart. Those are the ones whose QR code leads to an empty page.
 */
export async function checkOpenFeedback(
  projectId: string,
  sessions: { id: string; title: string; feedbackId: string }[],
  options: OpenFeedbackOptions = {},
): Promise<OpenFeedbackCheck> {
  const fetchImpl = options.fetchImpl ?? fetch
  const base = options.base ?? BASE
  const projet = projectId.trim()

  const exists = await fetchImpl(`${base}/${encodeURIComponent(projet)}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (exists.status === 404) {
    return {
      projet,
      projetTrouve: false,
      talksConnus: null,
      manquants: [],
      detail:
        'Aucun projet de ce nom chez OpenFeedback. Le lien de chaque conférence ' +
        'mène donc à une page vide, et le QR projeté en salle aussi.',
    }
  }
  if (!exists.ok) throw new Error(`OpenFeedback a répondu ${exists.status}`)

  /*
   * The list of talks, paginated.
   *
   * An event rarely exceeds a hundred sessions, and Firestore returns three
   * hundred per page: in practice the loop runs once. It exists so as not to
   * declare "missing" what was simply on page two.
   */
  const known = new Set<string>()
  let listSeen = false
  let pageToken: string | undefined
  do {
    const url = new URL(`${base}/${encodeURIComponent(projet)}/talks`)
    url.searchParams.set('pageSize', '300')
    if (pageToken != null) url.searchParams.set('pageToken', pageToken)
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) throw new Error(`OpenFeedback a répondu ${response.status}`)
    const page = talkListSchema.parse(await response.json())
    if (page.documents != null) {
      listSeen = true
      for (const document of page.documents) known.add(documentId(document.name))
    }
    pageToken = page.nextPageToken
  } while (pageToken != null)

  if (!listSeen) {
    return {
      projet,
      projetTrouve: true,
      talksConnus: null,
      manquants: [],
      detail:
        'Le projet existe, mais OpenFeedback n’y stocke aucun talk : il lit les ' +
        'sessions d’une source externe. Les identifiants concordent alors par ' +
        'construction, et il n’y a rien à comparer d’ici.',
    }
  }

  const missing = sessions
    .filter((session) => !known.has(session.feedbackId))
    .map((session) => ({ sessionId: session.id, title: session.title, feedbackId: session.feedbackId }))

  return {
    projet,
    projetTrouve: true,
    talksConnus: known.size,
    manquants: missing,
    detail:
      missing.length === 0
        ? 'Tous les créneaux ont leur page chez OpenFeedback.'
        : 'Ces créneaux n’ont pas de page chez OpenFeedback : leur lien et leur QR ' +
          'mènent à une page vide. Corrigez leur identifiant depuis le planning.',
  }
}
