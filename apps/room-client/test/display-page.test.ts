/// <reference lib="dom" />
// La lib DOM est déclarée ici seulement : l'ajouter au tsconfig laisserait le
// code serveur appeler `document` sans que rien ne proteste.
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aplatirCouchesHtml } from '@cloudnord/ui'
import { renderProjectorPage } from '../src/core/display-page.js'
import type { DisplayPayload } from '../src/core/display-server.js'

/**
 * Comportement de l'écran de salle dans un vrai DOM.
 *
 * Le programme d'une journée fait deux à trois fois la hauteur de l'écran, et
 * personne ne peut faire défiler un vidéoprojecteur : ce qui compte est donc
 * *quelle* ligne la page amène au centre.
 */
const session = (id: string, heure: string, title: string, kind = 'talk') => ({
  id,
  title,
  kind,
  startsAt: `2026-10-30T${heure}:00.000Z`,
  endsAt: `2026-10-30T${heure}:45.000Z`,
  startsAtMs: Date.parse(`2026-10-30T${heure}:00Z`),
  endsAtMs: Date.parse(`2026-10-30T${heure}:45Z`),
  speakers: [],
})

/** Une vraie journée : plus longue que l'écran, c'est tout l'intérêt. */
const SESSIONS = [
  session('s-0', '07:30', 'Accueil', 'break'),
  session('s-1', '08:00', 'Keynote'),
  session('s-2', '09:00', 'IA for OPS'),
  session('s-3', '10:00', 'HoneySwamp'),
  session('s-4', '11:00', 'Blind ops'),
  session('s-5', '12:00', 'Déjeuner', 'break'),
  session('s-6', '13:00', 'Houston'),
]

const ETAT = {
  state: {
    mode: 'programme',
    message: null,
    sceneRole: 'HOLD',
    connectivity: 'ONLINE',
    roomId: 'track-1',
    contentHash: 'h',
    currentSession: SESSIONS[3],
    nextSession: SESSIONS[4],
    outboxDepth: 0,
    serverTimeOffsetMs: Date.parse('2026-10-30T10:20:00Z') - Date.now(),
    recording: false,
    streaming: false,
    comments: [],
    sessionStates: {},
  },
  roomName: 'Track #1',
  event: null,
  timezone: 'Europe/Paris',
  sessions: SESSIONS,
  sponsorTiers: [],
  wall: null,
  feedback: null,
  diagnostics: null,
  pairing: null,
} as unknown as DisplayPayload

/** Ce que la page a demandé d'amener à l'écran, et comment. */
let centre: { element: Element; options: unknown } | null

/**
 * Les `setInterval` posés par la page, rejoués à la main.
 *
 * La boucle avance sur le tic d'une seconde de la page, et le compte à rebours
 * s'y remet à jour : le rejouer nous-mêmes évite d'attendre une minute réelle
 * par test, et le décalage d'horloge doit **persister** d'un appel à l'autre —
 * la page compare à `Date.now()`, et la remettre à l'heure entre deux avances
 * ferait reculer le temps.
 */
const MINUTEURS: (() => void)[] = []
const VRAI_NOW = Date.now
const VRAI_INTERVAL = globalThis.setInterval
let decalage = 0

function avancer(secondes: number): void {
  for (let passe = 0; passe < secondes; passe += 1) {
    decalage += 1_000
    for (const minuteur of MINUTEURS) minuteur()
  }
}

function poserMinuteurs(): void {
  MINUTEURS.length = 0
  decalage = 0
  Date.now = () => VRAI_NOW.call(Date) + decalage
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    // Seul le tic d'une seconde nous intéresse : c'est lui qui fait avancer la
    // boucle. Les autres sont neutralisés — un aperçu de test n'a pas à vivre
    // sa vie en arrière-plan.
    if (ms === 1000) MINUTEURS.push(fn)
    return VRAI_INTERVAL(() => {}, 1_000_000) as unknown as number
  }) as typeof setInterval
}

// Rendus au reste du fichier : ces deux remplacements sont globaux, et les
// laisser en place ferait dépendre les autres tests de l'ordre d'exécution.
function rendreMinuteurs(): void {
  Date.now = VRAI_NOW
  globalThis.setInterval = VRAI_INTERVAL
}

function monterEcran(payload: DisplayPayload = ETAT): void {
  centre = null
  document.documentElement.innerHTML = aplatirCouchesHtml(
    renderProjectorPage({ initialPayload: payload }),
  )
  // happy-dom ne calcule aucune mise en page : on observe l'intention, qui est
  // la seule chose que la page décide elle-même.
  Element.prototype.scrollIntoView = function (options?: unknown) {
    centre = { element: this as Element, options }
  }
  for (const script of document.querySelectorAll('script:not([type])')) {
    // eslint-disable-next-line no-new-func
    new Function(script.textContent ?? '')()
  }
}

const contenu = () => document.getElementById('contenu')!

/**
 * La couche en cours d'affichage.
 *
 * Pendant un fondu enchaîné, la page sortante est encore dans le document :
 * viser la couche vivante est la seule façon de dire ce que la salle est en
 * train de lire, plutôt que ce qu'elle achève de quitter.
 */
const vivante = () => contenu().querySelector('.calque:not(.sortante)')!

beforeEach(() => {
  monterEcran()
})

describe('programme projeté', () => {
  it('amène la conférence en cours au centre de l\'écran', () => {
    // Sans cela, la salle regarderait le petit-déjeuner à seize heures.
    const repere = contenu().querySelector('.repere')!

    expect(repere.textContent).toContain('HoneySwamp')
    expect(centre?.element).toBe(repere)
    expect(centre?.options).toEqual({ block: 'center' })
  })

  it('vise la suivante entre deux conférences', () => {
    // `currentSession` est vide à ce moment-là — et c'est justement quand on
    // cherche l'heure de la suivante.
    monterEcran({
      ...ETAT,
      state: { ...ETAT.state, currentSession: null, nextSession: SESSIONS[4] },
    } as unknown as DisplayPayload)

    expect(contenu().querySelector('.repere')?.textContent).toContain('Blind ops')
  })

  it('n\'en désigne qu\'une seule', () => {
    expect(contenu().querySelectorAll('.repere').length).toBe(1)
  })

  it('affiche quand même toute la journée', () => {
    // Le repère positionne, il ne filtre pas : ce qui précède et ce qui suit
    // restent lisibles de part et d'autre.
    expect(contenu().querySelectorAll('article').length).toBe(SESSIONS.length)
  })

  it('ne demande rien quand la journée est finie', () => {
    monterEcran({
      ...ETAT,
      state: { ...ETAT.state, currentSession: null, nextSession: null },
    } as unknown as DisplayPayload)

    expect(contenu().querySelector('.repere')).toBeNull()
    expect(centre).toBeNull()
  })

  it('ne cherche pas de repère dans les autres modes', () => {
    monterEcran({
      ...ETAT,
      state: { ...ETAT.state, mode: 'sponsors' },
    } as unknown as DisplayPayload)

    expect(centre).toBeNull()
  })
})

/**
 * QR OpenFeedback.
 *
 * Fabriqué hors ligne : OpenFeedback réutilise les identifiants de session de
 * l'export amont — les 27 concordent — donc l'adresse se déduit du programme
 * déjà en cache, sans clé d'API ni appel réseau le jour J.
 */
describe('écran « notez le talk »', () => {
  const AVEC_QR = {
    ...ETAT,
    state: { ...ETAT.state, mode: 'feedback' },
    feedback: {
      url: 'https://openfeedback.io/cloud-nord-2026/2026-10-30/s-3',
      qrSvg: '<svg id="qr"></svg>',
    },
  } as unknown as DisplayPayload

  it('affiche le QR et le titre de la conférence', () => {
    monterEcran(AVEC_QR)

    expect(contenu().querySelector('#qr')).toBeTruthy()
    expect(contenu().textContent).toContain('HoneySwamp')
    expect(contenu().textContent).toContain('Scannez')
  })

  it('le dit plutôt que de montrer un cadre vide', () => {
    // Hors conférence, il n'y a rien à noter — et un QR mort scanné par deux
    // cents personnes coûte plus qu'un écran qui l'annonce.
    monterEcran({
      ...AVEC_QR,
      feedback: null,
    } as unknown as DisplayPayload)

    expect(contenu().textContent).toContain('Aucune conférence à noter')
    expect(contenu().querySelector('#qr')).toBeNull()
  })
})

/**
 * Question projetée.
 *
 * Même donnée que sur les deux overlays — une seule sélection, trois surfaces.
 * Les overlays ne touchent que ceux qui regardent la captation ou la scène
 * live ; ce mode-ci la met devant toute la salle.
 */
describe('écran « question du public »', () => {
  const enQuestion = (question: unknown) =>
    ({
      ...ETAT,
      state: { ...ETAT.state, mode: 'question', question },
    }) as unknown as DisplayPayload

  it('projette la question choisie en régie', () => {
    monterEcran(enQuestion({ text: 'Comment gérez-vous les faux positifs ?', author: 'Camille', sessionId: 's-3' }))

    expect(contenu().textContent).toContain('Question du public')
    expect(contenu().textContent).toContain('faux positifs')
    expect(contenu().textContent).toContain('Camille')
  })

  it('ne prend pas le bandeau de la console pour une question', () => {
    // Les deux ont longtemps partagé un champ : « on reprend dans 5 minutes »
    // se projetait alors en grand sous le titre « Question du public ».
    monterEcran({
      ...ETAT,
      state: {
        ...ETAT.state,
        mode: 'question',
        question: null,
        liveMessage: { text: 'Reprise dans 5 minutes', level: 'info', expiresAtMs: null },
      },
    } as unknown as DisplayPayload)

    expect(contenu().textContent).not.toContain('Reprise dans 5 minutes')
    expect(contenu().textContent).toContain('Aucune question affichée')
  })

  it('le dit quand aucune question n\'est choisie', () => {
    monterEcran(enQuestion(null))

    expect(contenu().textContent).toContain('Aucune question affichée')
  })
})

/**
 * Page partenaires.
 *
 * Deux règles la gouvernent. Le premier palier a payé le plus cher : il occupe
 * seul le haut de l'écran. Et un sponsor qui a pris plusieurs packs n'apparaît
 * **qu'une fois** — l'export amont lui donne un identifiant par palier, si bien
 * que le même logo revenait trois fois à l'identique, ce qui se lit comme un
 * défaut d'affichage.
 */
describe('page partenaires', () => {
  // Les identifiants diffèrent d'un palier à l'autre, comme dans le vrai
  // export ; la barre finale du site aussi. C'est exactement ce que le
  // dédoublonnage doit absorber.
  const PALIERS = [
    {
      id: 't0', name: 'Gold', order: 0,
      sponsors: [{ id: 'g1', name: 'HoppR', website: 'https://www.hoppr.tech/', logoUrl: null }],
    },
    {
      id: 't1', name: 'Digital', order: 1,
      sponsors: [
        { id: 'd1', name: 'ape factory', website: 'https://www.apefactory.com', logoUrl: null },
        { id: 'd2', name: 'Davidson', website: 'https://www.davidson.fr/', logoUrl: null },
      ],
    },
    {
      id: 't2', name: 'Pack Inclusivité', order: 2,
      sponsors: [{ id: 'p1', name: 'ape factory', website: 'https://www.apefactory.com/', logoUrl: null }],
    },
  ]

  const enPartenaires = (tiers: unknown = PALIERS) =>
    ({ ...ETAT, state: { ...ETAT.state, mode: 'sponsors' }, sponsorTiers: tiers }) as unknown as DisplayPayload

  it('donne le haut de l\'écran au premier palier', () => {
    monterEcran(enPartenaires())

    expect(vivante().textContent).toContain('Gold')
    expect(vivante().textContent).toContain('HoppR')
  })

  it('ne montre qu\'une fois celui qui a pris plusieurs packs', () => {
    monterEcran(enPartenaires())

    const texte = vivante().textContent ?? ''
    expect(texte.match(/ape factory/g)?.length).toBe(1)
  })

  it('dit lesquels il a pris', () => {
    monterEcran(enPartenaires())

    expect(vivante().textContent).toContain('Digital · Pack Inclusivité')
    expect(vivante().textContent).toContain('Et sur tous les fronts')
  })

  it('ne promet pas plusieurs fronts quand personne n\'en a pris deux', () => {
    // Le libellé est une affirmation : sans sponsor multi-packs, il mentirait.
    monterEcran(enPartenaires(PALIERS.slice(0, 2).map((tier) => ({
      ...tier,
      sponsors: tier.sponsors.slice(0, 1),
    }))))

    expect(vivante().textContent).toContain('Et aussi')
    expect(vivante().textContent).not.toContain('Et sur tous les fronts')
  })

  it('se réduit au bandeau quand il n\'y a qu\'un palier', () => {
    monterEcran(enPartenaires(PALIERS.slice(0, 1)))

    const texte = vivante().textContent ?? ''
    expect(texte).toContain('HoppR')
    expect(texte).not.toContain('Et aussi')
    expect(texte).not.toContain('Et sur tous les fronts')
  })

  it('propose ses logos au détourage', () => {
    // L'accroche du détourage, et rien de plus : le recadrage lui-même demande
    // un canvas, que happy-dom n'a pas. Ce que ce test tient, c'est que la page
    // ne lève pas pour autant et que les logos restent repérables.
    monterEcran(enPartenaires([
      {
        id: 't0', name: 'Gold', order: 0,
        sponsors: [{ id: 'g1', name: 'HoppR', website: null, logoUrl: '/assets/abc123' }],
      },
    ]))

    expect(vivante().querySelectorAll('img[data-logo]').length).toBe(1)
  })

  it('le dit quand il n\'y a aucun partenaire', () => {
    monterEcran(enPartenaires([]))

    expect(vivante().textContent).toContain('Merci à nos partenaires')
  })
})

/**
 * Compte à rebours de reprise.
 *
 * Il vit à la seconde, et c'est précisément ce qui interdisait de l'animer :
 * la page réécrivait tout le bloc à chaque tic, ce qui remettait à zéro tout
 * ce qui aurait pu bouger. Structure et valeurs sont désormais séparées.
 */
describe('compte à rebours', () => {
  beforeEach(poserMinuteurs)
  afterEach(rendreMinuteurs)

  const enCompte = () =>
    ({ ...ETAT, state: { ...ETAT.state, mode: 'countdown' } }) as unknown as DisplayPayload

  it('met les chiffres à jour sans reconstruire le bloc', () => {
    monterEcran(enCompte())
    const secondes = vivante().querySelector('.cd-sec')!
    const avant = secondes.textContent

    avancer(2)

    // Le même nœud, avec une autre valeur : c'est la condition pour qu'une
    // animation posée dessus survive d'une seconde à l'autre.
    expect(vivante().querySelector('.cd-sec')).toBe(secondes)
    expect(secondes.textContent).not.toBe(avant)
  })

  it('annonce la conférence de reprise', () => {
    monterEcran(enCompte())

    expect(vivante().textContent).toContain('Blind ops')
  })

  it('le dit quand la journée est finie', () => {
    monterEcran({
      ...ETAT,
      state: { ...ETAT.state, mode: 'countdown', nextSession: null },
    } as unknown as DisplayPayload)

    expect(vivante().textContent).toContain('Fin des interventions')
  })
})

/**
 * Boucle d'attente.
 *
 * Ce qu'on laisse tourner pendant les pauses. Deux règles la gouvernent : les
 * pages sans contenu sont **sautées** — dix secondes de cadre désert devant la
 * salle se lisent comme une panne — et le retour dans la boucle repart du
 * début, plutôt que d'atterrir au milieu du programme.
 */
describe('boucle d\'attente', () => {
  const AUTRES = [
    {
      roomId: 'track-2',
      name: 'Track #2',
      session: { id: 's-12', title: 'Au-dessus de la mêlée', startsAt: '2026-10-30T11:00:00.000Z', speakers: ['Camille'] },
      enCours: false,
    },
    {
      roomId: 'hands-on',
      name: 'Hands on',
      session: { id: 's-31', title: 'Atelier Kubernetes', startsAt: '2026-10-30T10:00:00.000Z', speakers: [] },
      enCours: true,
    },
  ]

  const RESEAUX = [
    { network: 'Bluesky', handle: '@cloudnord.fr', url: 'https://bsky.app/profile/cloudnord.fr' },
  ]

  const SPONSORS = [{ id: 't1', name: 'Gold', order: 1, sponsors: [{ id: 's1', name: 'Clever Cloud', website: null, logoUrl: null }] }]

  const enBoucle = (patch: Record<string, unknown> = {}) =>
    ({
      ...ETAT,
      state: { ...ETAT.state, mode: 'loop' },
      sponsorTiers: SPONSORS,
      otherRooms: AUTRES,
      socialLinks: RESEAUX,
      ...patch,
    }) as unknown as DisplayPayload

  beforeEach(poserMinuteurs)
  afterEach(rendreMinuteurs)

  it('ouvre sur les sponsors', () => {
    monterEcran(enBoucle())

    expect(contenu().textContent).toContain('Nos partenaires')
    expect(contenu().textContent).toContain('Clever Cloud')
  })

  it('enchaîne les pages toute seule', () => {
    monterEcran(enBoucle())

    // Sponsors 12 s, puis le programme.
    avancer(13)
    expect(vivante().textContent).toContain('Programme de la salle')

    // Puis les autres salles, puis les réseaux.
    avancer(16)
    expect(vivante().textContent).toContain('Pendant ce temps')
    avancer(13)
    expect(vivante().textContent).toContain('Suivez Cloud Nord')
  })

  it('revient au début après le dernier écran', () => {
    monterEcran(enBoucle())
    avancer(13 + 16 + 13 + 11)

    expect(vivante().textContent).toContain('Nos partenaires')
  })

  it('saute les pages qui n\'ont rien à montrer', () => {
    // Sans sponsors ni réseaux, la boucle ne doit pas s'arrêter douze secondes
    // sur un cadre vide : elle se réduit à ce qui existe.
    monterEcran(enBoucle({ sponsorTiers: [], socialLinks: [] }))

    expect(vivante().textContent).toContain('Programme de la salle')
    avancer(16)
    expect(vivante().textContent).toContain('Pendant ce temps')
    avancer(13)
    expect(vivante().textContent).toContain('Programme de la salle')
  })

  it('dit ce qui se joue à côté, et à quelle heure', () => {
    monterEcran(enBoucle())
    avancer(13 + 16)

    const texte = vivante().textContent ?? ''
    expect(texte).toContain('Track #2')
    expect(texte).toContain('Au-dessus de la mêlée')
    // 11:00 UTC = 12:00 à Paris, dans le fuseau de l'événement.
    expect(texte).toContain('12:00')
    // Une salle dont le talk a déjà commencé n'annonce pas une heure passée.
    expect(texte).toContain('en ce moment')
  })

  it('montre le handle, pas l\'URL', () => {
    // C'est le handle qu'on retape sur son téléphone depuis le fond de la
    // salle ; une URL ne se recopie pas.
    monterEcran(enBoucle())
    avancer(13 + 16 + 13)

    expect(vivante().textContent).toContain('@cloudnord.fr')
    expect(vivante().textContent).not.toContain('https://')
  })

  /**
   * Fondu enchaîné.
   *
   * Les deux pages coexistent le temps de la bascule : la sortante s'efface
   * par-dessus la nouvelle qui entre. Sans cela l'écran *saute*, et un saut
   * devant la salle se lit comme un rafraîchissement, pas comme une suite.
   *
   * happy-dom ne termine aucune animation, donc `animationend` n'arrive jamais
   * : ce que ces tests observent est exactement l'état intermédiaire qu'un
   * navigateur traverse.
   */
  it('croise la page sortante avec celle qui arrive', () => {
    monterEcran(enBoucle())
    avancer(13)

    expect(contenu().querySelectorAll('.calque').length).toBe(2)
    expect(contenu().querySelector('.sortante')?.textContent).toContain('Nos partenaires')
    expect(vivante().textContent).toContain('Programme de la salle')
  })

  it('n\'empile jamais deux couches mortes', () => {
    // La réécriture suivante emporte la précédente : c'est ce qui garantit que
    // trois bascules ne laissent pas trois pages fantômes superposées.
    monterEcran(enBoucle())
    avancer(13 + 16 + 13)

    expect(contenu().querySelectorAll('.sortante').length).toBe(1)
  })

  it('cale la jauge sur la durée de la page affichée', () => {
    // C'est la jauge qui dit *quand* ça va tourner : une durée fausse est un
    // repère qui ment, pire que pas de repère du tout.
    monterEcran(enBoucle())
    const sponsors = contenu().querySelector('.point.actif') as HTMLElement

    expect(sponsors.style.getPropertyValue('--duree')).toBe('12000ms')

    avancer(13)
    const programme = vivante().querySelector('.point.actif') as HTMLElement
    expect(programme.style.getPropertyValue('--duree')).toBe('15000ms')
  })

  it('reste tenable sur une salle jamais synchronisée', () => {
    // Ni programme, ni sponsors, ni réseaux : plutôt qu'un écran noir, elle
    // affiche au moins de quel événement il s'agit.
    monterEcran(enBoucle({ sponsorTiers: [], socialLinks: [], otherRooms: [], sessions: [] }))

    expect(contenu().textContent).toContain('partenaires')
    // Et elle ne se met pas à clignoter faute de page à afficher.
    avancer(30)
    expect(contenu().textContent).toContain('partenaires')
  })
})
