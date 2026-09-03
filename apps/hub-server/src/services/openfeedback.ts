import { z } from 'zod'
import type { OpenFeedbackCheck } from '@cloudnord/contract'

/**
 * Vérifier que les liens « notez ce talk » mènent quelque part.
 *
 * Le hub fabrique ces adresses hors ligne — `{projet}/{jour}/{id}` — en pariant
 * qu'OpenFeedback réutilise les identifiants de session de l'export amont. Le
 * pari tient, mais il se perd en silence : le lien reste cliquable, le QR reste
 * scannable, et les deux mènent à une page qui ne parle d'aucun talk. Personne
 * ne s'en aperçoit avant que les retours ne manquent, c'est-à-dire une fois
 * l'événement fini.
 *
 * Ce module est la seule chose du hub qui appelle OpenFeedback, et il ne le
 * fait que sur demande : rien ici ne tourne en tâche de fond. Un contrôle est
 * un geste d'avant-événement — on l'exécute une fois, quand le programme vient
 * d'être importé, et on corrige ce qu'il signale.
 *
 * **Lecture publique, sans clé.** OpenFeedback est une application Firebase, et
 * ses règles Firestore ouvrent `projects/{projet}` et `projects/{projet}/talks`
 * à tout le monde — ce sont les données que sa page publique affiche déjà. On
 * lit donc l'API REST de Firestore directement, sans compte et sans secret à
 * poser sur le hub. Il n'existe pas d'API REST documentée côté OpenFeedback :
 * c'est le seul chemin, et il est stable parce que ces règles sont la surface
 * publique du produit.
 */

/** Projet Firebase d'OpenFeedback. Public : il est dans leur dépôt et leurs SDK. */
const PROJET_FIREBASE = 'open-feedback-42'

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJET_FIREBASE}/databases/(default)/documents/projects`

/** Au-delà, on rend la main : le contrôle est facultatif, l'attente ne l'est pas. */
const DELAI_MS = 8_000

/**
 * Réponse de listing Firestore, réduite à ce qu'on lit.
 *
 * `documents` est **absent** — et non vide — quand la collection n'existe pas :
 * Firestore rend alors `{}` avec un 200. C'est exactement le cas d'un projet
 * dont les talks vivent ailleurs, et il ne faut surtout pas le confondre avec
 * « aucun de vos vingt-sept créneaux n'existe ».
 */
const listeTalksSchema = z.object({
  documents: z
    .array(z.object({ name: z.string() }))
    .optional(),
  nextPageToken: z.string().optional(),
})

/**
 * Le dernier segment du chemin d'un document Firestore, décodé.
 *
 * `name` est un chemin complet — `projects/…/documents/projects/x/talks/ses-1` —
 * et seul son dernier segment est l'identifiant qui apparaît dans l'URL
 * publique.
 */
function idDuDocument(name: string): string {
  const segments = name.split('/')
  return decodeURIComponent(segments[segments.length - 1] ?? '')
}

export interface OpenFeedbackOptions {
  fetchImpl?: typeof fetch
  /** Surchargeable pour les tests : rien d'autre ne doit pointer ailleurs. */
  base?: string
}

/**
 * Confronte les identifiants du programme à ce qu'OpenFeedback connaît.
 *
 * Trois réponses possibles, et elles ne se valent pas :
 *
 * - **Projet introuvable** (404) : le slug réglé n'existe pas. C'est la panne
 *   la plus fréquente et la plus bête — une faute de frappe — et elle rend
 *   toutes les adresses mortes d'un coup.
 * - **Projet trouvé, talks absents** : OpenFeedback ne stocke pas les sessions
 *   de ce projet ; il les lit d'une source externe (l'export de l'organisateur).
 *   La concordance est alors vraie par construction, et il n'y a rien à
 *   comparer. On le **dit**, au lieu de signaler vingt-sept créneaux manquants
 *   qui ne manquent pas : un contrôle qui crie au loup ne se relance jamais.
 * - **Projet trouvé, talks listés** : on compare, et on nomme ceux qui n'ont
 *   pas de contrepartie. Ce sont eux dont le QR mène à une page vide.
 */
export async function controlerOpenFeedback(
  projectId: string,
  sessions: { id: string; title: string; feedbackId: string }[],
  options: OpenFeedbackOptions = {},
): Promise<OpenFeedbackCheck> {
  const fetchImpl = options.fetchImpl ?? fetch
  const base = options.base ?? BASE
  const projet = projectId.trim()

  const existe = await fetchImpl(`${base}/${encodeURIComponent(projet)}`, {
    signal: AbortSignal.timeout(DELAI_MS),
  })
  if (existe.status === 404) {
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
  if (!existe.ok) throw new Error(`OpenFeedback a répondu ${existe.status}`)

  /*
   * La liste des talks, paginée.
   *
   * Un événement dépasse rarement la centaine de sessions, et Firestore en rend
   * trois cents par page : la boucle ne tourne qu'une fois dans les faits. Elle
   * existe pour ne pas déclarer « manquant » ce qui était simplement page deux.
   */
  const connus = new Set<string>()
  let listeVue = false
  let pageToken: string | undefined
  do {
    const url = new URL(`${base}/${encodeURIComponent(projet)}/talks`)
    url.searchParams.set('pageSize', '300')
    if (pageToken != null) url.searchParams.set('pageToken', pageToken)
    const reponse = await fetchImpl(url, { signal: AbortSignal.timeout(DELAI_MS) })
    if (!reponse.ok) throw new Error(`OpenFeedback a répondu ${reponse.status}`)
    const page = listeTalksSchema.parse(await reponse.json())
    if (page.documents != null) {
      listeVue = true
      for (const document of page.documents) connus.add(idDuDocument(document.name))
    }
    pageToken = page.nextPageToken
  } while (pageToken != null)

  if (!listeVue) {
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

  const manquants = sessions
    .filter((session) => !connus.has(session.feedbackId))
    .map((session) => ({ sessionId: session.id, title: session.title, feedbackId: session.feedbackId }))

  return {
    projet,
    projetTrouve: true,
    talksConnus: connus.size,
    manquants,
    detail:
      manquants.length === 0
        ? 'Tous les créneaux ont leur page chez OpenFeedback.'
        : 'Ces créneaux n’ont pas de page chez OpenFeedback : leur lien et leur QR ' +
          'mènent à une page vide. Corrigez leur identifiant depuis le planning.',
  }
}
