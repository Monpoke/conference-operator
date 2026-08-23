/**
 * Génère un aperçu hors ligne de l'écran de salle, dans chacun de ses modes.
 *
 * Utilise la *vraie* page et les *vraies* données de l'événement : ce qu'on
 * regarde ici est ce qui sera projeté. Seul le flux SSE est neutralisé.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toString } from 'qrcode'
import { normalizeProgram, sessionsForRoom } from '@cloudnord/program'
import { resoudreIdentiteEvenement } from '@cloudnord/contract'
import { renderProjectorPage } from '../src/core/display-page.js'
import { renderOverlayPage } from '../src/core/overlay-page.js'
import { renderOverlayLivePage } from '../src/core/overlay-live-page.js'
import { renderRegiePage } from '../src/core/regie-page.js'
import type { DisplayPayload } from '../src/core/display-server.js'

const outDir = resolve(process.argv[2] ?? './preview')
const TRACK_1 = 'track-1-teilhard-de-chardin'
const AT = Date.parse('2026-10-30T10:20:00.000Z') // 11:20 à Paris, en plein talk

const program = normalizeProgram(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
      'utf8',
    ),
  ),
)

const sessions = sessionsForRoom(program, TRACK_1)
const current = sessions.find((s) => s.startsAtMs <= AT && (s.endsAtMs ?? 0) > AT) ?? null
const next = sessions.find((s) => s.startsAtMs > AT) ?? null

const base: DisplayPayload = {
  state: {
    mode: 'sponsors',
    message: null,
    liveMessage: null,
    question: null,
    sceneRole: 'HOLD',
    connectivity: 'ONLINE',
    roomId: TRACK_1,
    contentHash: 'apercu',
    currentSession: current,
    nextSession: next,
    targetSession: current ?? next,
    targetIsUpcoming: current == null,
    simulatedClock: false,
    outboxDepth: 0,
    serverTimeOffsetMs: AT - Date.now(),
    recording: true,
    streaming: false,
    comments: [],
    sessionStates: current == null ? {} : { [current.id]: 'running' as const },
    notifications: [
      {
        id: 'n1',
        level: 'info' as const,
        text: 'Platform Engineering à l\'échelle de Décathlon vient de se terminer dans une autre salle',
        // Récent : un signalement s'efface au bout de trente secondes, en
        // montrer un de deux minutes donnerait une image impossible.
        at: new Date(AT - 12_000).toISOString(),
      },
    ],
  },
  roomName: 'Track #1 — Teilhard de Chardin',
  pairing: { status: 'paired' },
  diagnostics: {
    obs: {
      A: {
        instance: 'A', connected: true, currentSceneName: 'Habillage web',
        currentRole: 'HOLD', unresolvedRoles: ['RELAY'], recording: false, streaming: false,
        scenes: ['Direct — capture HDMI', 'Habillage web', 'Écran noir'],
        // L'aperçu n'a aucune instance OBS derrière lui : le dire est à la fois
        // honnête et la seule façon de relire le badge avant le jour J.
        simulated: true,
      },
      B: {
        instance: 'B', connected: true, currentSceneName: 'Talk complet',
        currentRole: 'TALK', unresolvedRoles: [], recording: true, streaming: false,
        scenes: ['Talk complet', 'Caméra seule', 'Slides seules'],
        simulated: true,
      },
    },
    // L'aperçu est un artefact de développement de bout en bout : il le dit,
    // ce qui rend aussi le badge relisable avant le jour J.
    mode: { salle: 'dev' as const, hub: 'dev' as const },
    /** Réglages de la salle : sans mots de passe, comme la régie les reçoit. */
    config: {
      obs: {
        // A : réglage enregistré, connexion pas encore rouverte — l'état que
        // l'aperçu doit montrer, puisque c'est celui qui demande un geste.
        A: { url: 'ws://127.0.0.1:4455', hasPassword: true, pending: true },
        B: { url: 'ws://127.0.0.1:4456', hasPassword: false, pending: false },
      },
      sceneRoles: {
        A: { LIVE: 'Direct — capture HDMI', HOLD: 'Habillage web', RELAY: 'Relais NDI — Track #2' },
        B: { TALK: 'Talk complet', CAM_ONLY: 'Caméra seule', SLIDES_ONLY: 'Slides seules' },
      },
      displayPort: 7788,
      recordingRoot: 'D:\\captations\\2026',
      fileSlug: 'track1',
      relaySourceRoomId: 'track-2-mf-1092',
      openFeedbackProjectId: 'cloud-nord-2026',
      promptRecordingOnStart: true,
      sceneOnStart: 'LIVE',
    },
    outboxDepth: 3,
    journal: [
      { level: 'warn', message: 'remontée impossible, lot reporté', createdAt: '2026-10-30T11:18:00.000Z' },
      { level: 'info', message: 'assets préchargés', createdAt: '2026-10-30T09:02:00.000Z' },
    ],
    recording: { active: true, markers: 2, startedAtMs: AT - 14 * 60_000 },
    rooms: [
      { roomId: 'track-1-teilhard-de-chardin', name: 'Track #1 — Teilhard de Chardin', connectivity: 'ONLINE', sceneRole: 'LIVE', recording: true, outboxDepth: 3, lastSeenAt: new Date(AT - 4_000).toISOString(), currentSessionId: null, conference: 'en-cours' },
      { roomId: 'track-2-mf-1092', name: 'Track #2 — MF 1092', connectivity: 'ONLINE', sceneRole: 'HOLD', recording: false, outboxDepth: 0, lastSeenAt: new Date(AT - 9_000).toISOString(), currentSessionId: null, conference: 'en-cours' },
      { roomId: 'hands-on', name: 'Hands on', connectivity: 'OFFLINE', sceneRole: null, recording: false, outboxDepth: 41, lastSeenAt: new Date(AT - 480_000).toISOString(), currentSessionId: null, conference: 'en-cours' },
    ],
    roomsRefreshedAt: new Date(AT - 6_000).toISOString(),
    questions: [
      { id: 'q1', text: 'Comment gérez-vous les faux positifs ?', author: 'Camille', votes: 7 },
      { id: 'q2', text: 'Le code du honeypot est-il open source ?', author: null, votes: 3 },
    ],
    questionsRefreshedAt: new Date(AT - 20_000).toISOString(),
    // Les questions se lisent toujours rattachées à une conférence : c'est ce
    // qui distingue « personne n'a rien demandé » de « aucun talk piloté ».
    questionsSession: current == null ? null : { id: current.id, title: current.title },
    /** Même donnée que `config.relaySourceRoomId` : elles doivent concorder. */
    relaySourceRoomId: 'track-2-mf-1092',
  },
  event: program.event,
  timezone: program.timezone,
  sessions,
  sponsorTiers: program.sponsorTiers,
  /**
   * Mur public et son QR, **vraiment généré**.
   *
   * Il manquait : l'écran de salle affichait donc ses aperçus sans le QR que
   * les participants scannent, et le menu « Écrans » de la régie sans le lien
   * vers le mur. Mêmes options que `prepareWallQr` — c'est le QR qui sera
   * projeté qu'on veut regarder, pas une image de remplacement.
   */
  feedback: current == null ? null : {
    url: `https://openfeedback.io/cloud-nord-2026/2026-10-30/${current.id}`,
    qrSvg: await toString(`https://openfeedback.io/cloud-nord-2026/2026-10-30/${current.id}`, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'H',
      color: { dark: '#0d0f16', light: '#ffffff' },
    }),
  },
  wall: {
    url: `http://localhost:8787/mur?salle=${TRACK_1}`,
    qrSvg: await toString(`http://localhost:8787/mur?salle=${TRACK_1}`, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'H',
      color: { dark: '#0d0f16', light: '#ffffff' },
    }),
  },
  /**
   * Ce qui se joue à côté, et les comptes de l'événement.
   *
   * Les deux pages que la boucle ajoute au reste. Une salle sans conférence en
   * vue y figure : c'est le cas qui montre qu'elle est écartée plutôt
   * qu'affichée vide.
   */
  otherRooms: [
    {
      roomId: 'track-2-mf-1092',
      name: 'Track #2 — MF 1092',
      session: {
        id: 's-12',
        title: '100 % open source, au-dessus de la mêlée',
        startsAt: new Date(AT + 18 * 60_000).toISOString(),
        speakers: ['Camille Durand'],
      },
      enCours: false,
    },
    {
      roomId: 'hands-on',
      name: 'Hands on',
      session: {
        id: 's-31',
        title: 'Atelier Kubernetes : du cluster au déploiement',
        startsAt: new Date(AT - 12 * 60_000).toISOString(),
        speakers: ['Alex Martin', 'Sacha Nguyen'],
      },
      enCours: true,
    },
  ],
  // Déduite de la fixture, comme le hub la déduirait du programme importé :
  // l'aperçu montre alors le même enchaînement que la réalité.
  eventIdentity: resoudreIdentiteEvenement({ programme: program.event.name }),
  socialLinks: [
    { network: 'Bluesky', handle: '@cloudnord.fr', url: 'https://bsky.app/profile/cloudnord.fr' },
    { network: 'LinkedIn', handle: 'Cloud Nord', url: 'https://www.linkedin.com/company/cloud-nord' },
    { network: 'Mastodon', handle: '@cloudnord@piaille.fr', url: 'https://piaille.fr/@cloudnord' },
  ],
}

const variantes: { nom: string; payload: DisplayPayload }[] = [
  { nom: 'sponsors', payload: base },
  { nom: 'programme', payload: { ...base, state: { ...base.state, mode: 'programme' } } },
  { nom: 'compte-a-rebours', payload: { ...base, state: { ...base.state, mode: 'countdown' } } },
  { nom: 'feedback', payload: { ...base, state: { ...base.state, mode: 'feedback' as const } } },
  {
    nom: 'question',
    payload: {
      ...base,
      state: {
        ...base.state,
        mode: 'question' as const,
        question: {
          text: 'Comment gérez-vous les faux positifs sur un honeypot exposé ?',
          author: 'Camille',
          sessionId: current?.id ?? null,
        },
      },
    },
  },
  {
    // Le mur : le seul écran que le public photographie. Il manquait à
    // l'aperçu, faute d'un `wall` dans la charge utile.
    nom: 'mur',
    payload: {
      ...base,
      state: {
        ...base.state,
        mode: 'wall' as const,
        comments: [
          {
            id: 'c1', text: 'Super talk, merci !', author: 'Camille', authorHandle: null,
            source: 'form' as const, status: 'approved' as const, roomId: TRACK_1,
            sessionId: current?.id ?? null, createdAt: new Date(AT - 120_000).toISOString(),
          },
          {
            id: 'c2', text: 'Le lien des slides est-il dispo quelque part ?', author: 'Sam',
            authorHandle: '@sam.bsky.social', source: 'bluesky' as const,
            status: 'approved' as const, roomId: TRACK_1,
            sessionId: current?.id ?? null, createdAt: new Date(AT - 60_000).toISOString(),
          },
        ],
      },
    },
  },
  {
    nom: 'message-urgent',
    payload: {
      ...base,
      state: {
        ...base.state,
        mode: 'message',
        connectivity: 'OFFLINE',
        message: { text: 'Évacuation — rejoignez la sortie la plus proche', level: 'urgent', expiresAtMs: null },
      },
    },
  },
]

mkdirSync(outDir, { recursive: true })

// L'habillage de captation : fond transparent, damier ajouté pour le seul
// aperçu — dans OBS, c'est la caméra et les slides qui apparaissent dessous.
const damier =
  '<style>body{background-image:linear-gradient(45deg,#2a2a33 25%,transparent 25%),' +
  'linear-gradient(-45deg,#2a2a33 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#2a2a33 75%),' +
  'linear-gradient(-45deg,transparent 75%,#2a2a33 75%);background-size:40px 40px;' +
  'background-position:0 0,0 20px,20px -20px,-20px 0;background-color:#1d1d22}</style>'
const overlay = renderOverlayPage({ initialPayload: base })
  .replace('<body ', `<script>window.__APERCU__ = true</script>${damier}<body `)
writeFileSync(join(outDir, 'overlay-captation.html'), overlay)
console.log(`écrit ${join(outDir, 'overlay-captation.html')}`)

/**
 * Le même habillage, question du public à l'antenne.
 *
 * Deux fichiers plutôt qu'un : c'est le cadrage des deux encarts ensemble qu'on
 * vient juger — titrage à gauche, question à droite — et il ne se voit pas sur
 * un aperçu où l'un des deux manque.
 */
const overlayQuestion = renderOverlayPage({
  initialPayload: {
    ...base,
    state: {
      ...base.state,
      question: {
        text: 'Comment gérez-vous les faux positifs sur un honeypot exposé ?',
        author: 'Camille',
        sessionId: current?.id ?? null,
      },
    },
  },
}).replace('<body ', `<script>window.__APERCU__ = true</script>${damier}<body `)
writeFileSync(join(outDir, 'overlay-captation-question.html'), overlayQuestion)
console.log(`écrit ${join(outDir, 'overlay-captation-question.html')}`)

// Panneau des salles ouvert dans l'aperçu, sinon on ne le verrait pas.
// Choix de la salle : premier écran d'une machine neuve.
const SALLES = [
  { id: 'track-1-teilhard-de-chardin', name: 'Track #1 — Teilhard de Chardin' },
  { id: 'track-2-mf-1092', name: 'Track #2 — MF 1092' },
  { id: 'hands-on', name: 'Hands on' },
]
/**
 * Rend la régie hors ligne.
 *
 * Le voile d'appairage et les onglets se posent tout seuls au premier rendu, à
 * partir de la charge utile : seul le flux SSE est neutralisé. Les aperçus
 * accrochaient auparavant le markup exact du `<body>`, qu'une retouche de mise
 * en page suffisait à faire diverger sans que rien ne le signale.
 */
function apercuRegie(payload: DisplayPayload, prelude = ''): string {
  return renderRegiePage({ initialPayload: payload }).replace(
    '<body ',
    `<script>window.__APERCU__ = true${prelude}</script><body `,
  )
}

const choix = apercuRegie({
  ...base,
  pairing: { status: 'idle', rooms: SALLES, requestedRoomId: null },
})
writeFileSync(join(outDir, 'regie-choix-salle.html'), choix)
console.log(`écrit ${join(outDir, 'regie-choix-salle.html')}`)

// Écran d'appairage : la machine n'est pas encore liée à une salle.
const appairage = apercuRegie({
  ...base,
  pairing: {
    status: 'waiting',
    userCode: 'FH9BAXGZ',
    verificationUri: 'http://hub.cloudnord.fr/admin',
    rooms: SALLES,
    requestedRoomId: 'track-2-mf-1092',
  },
})
writeFileSync(join(outDir, 'regie-appairage.html'), appairage)
console.log(`écrit ${join(outDir, 'regie-appairage.html')}`)

/** Niveaux figés pour l'aperçu : un micro qui parle, une ambiance, un retour muet. */
const NIVEAUX = [
  { nom: 'Micro cravate', canaux: [{ magnitude: -14, crete: -8 }] },
  { nom: 'Ambiance salle', canaux: [{ magnitude: -38, crete: -34 }, { magnitude: -36, crete: -33 }] },
  { nom: 'Retour régie', canaux: [{ magnitude: -60, crete: -60 }, { magnitude: -60, crete: -60 }] },
]

/**
 * Programmes des autres salles, pour le flux d'en-tête.
 *
 * La page les récupère normalement du serveur local ; l'aperçu tourne sur
 * `file://`, où aucun `fetch` n'aboutit. Sans eux, le flux afficherait
 * « programme inconnu » et l'aperçu ne dirait rien de la seule ligne qui
 * regarde les autres salles en continu.
 */
const PROGRAMMES = {
  rooms: program.rooms.map((salle) => ({ id: salle.id, name: salle.name })),
  sessions: Object.fromEntries(program.rooms.map((salle) => [salle.id, sessionsForRoom(program, salle.id)])),
}

// Bandeau live : la seule surface qu'un aperçu peut montrer en situation,
// puisqu'elle ne s'affiche que sur ordre de la console.
/** Les deux présentations du bandeau, côte à côte dans les aperçus. */
for (const style of ['bandeau', 'encart'] as const) {
  const page = renderOverlayLivePage({
    initialPayload: {
      ...base,
      state: {
        ...base.state,
        // Une question, pas un bandeau : c'est le cas qui montre le libellé
        // « Question du public » de l'encart.
        question: {
          text: 'Comment gérez-vous les faux positifs sur un honeypot exposé ?',
          author: 'Camille',
          sessionId: current?.id ?? null,
        },
      },
    },
  })
    .replace('<body ', `<script>window.__APERCU__ = true</script>${damier}<body `)
    // L'aperçu s'ouvre sur `file://`, sans paramètre d'adresse : on pose le
    // style comme le ferait `?style=`.
    .replace("get('style')", `get('style') ?? '${style}'`)
  writeFileSync(join(outDir, `overlay-live-${style}.html`), page)
  console.log(`écrit ${join(outDir, `overlay-live-${style}.html`)}`)
}

const bandeau = renderOverlayLivePage({
  initialPayload: {
    ...base,
    state: {
      ...base.state,
      liveMessage: { text: 'Reprise dans 5 minutes', level: 'info', expiresAtMs: null },
    },
  },
}).replace('<body ', `<script>window.__APERCU__ = true</script>${damier}<body `)
writeFileSync(join(outDir, 'overlay-bandeau-live.html'), bandeau)
console.log(`écrit ${join(outDir, 'overlay-bandeau-live.html')}`)

const regie = apercuRegie(
  base,
  `; window.__NIVEAUX__ = ${JSON.stringify(NIVEAUX)}` +
    `; window.__PROGRAMMES__ = ${JSON.stringify(PROGRAMMES)}`,
)
writeFileSync(join(outDir, 'regie.html'), regie)
console.log(`écrit ${join(outDir, 'regie.html')}`)

// Le panneau de configuration, ouvert : c'est là que se règlent les deux OBS,
// et un aperçu qui ne le montre pas laisse le formulaire sans relecture.
const config = regie.replace(
  '</body>',
  '<script>document.getElementById("btn-config").click()</script></body>',
)
writeFileSync(join(outDir, 'regie-configuration.html'), config)
console.log(`écrit ${join(outDir, 'regie-configuration.html')}`)

// La modale de consultation, ouverte : sinon rien dans l'aperçu ne montre les
// programmes ni l'état des salles, qui ne s'affichent plus qu'à la demande.
// Ouverte par un vrai clic sur le vrai bouton, pour ne rien avoir à simuler.
const modale = regie.replace(
  '</body>',
  '<script>document.getElementById("btn-programme").click()</script></body>',
)
writeFileSync(join(outDir, 'regie-programme.html'), modale)
console.log(`écrit ${join(outDir, 'regie-programme.html')}`)

/**
 * Le début de la balise `body` de l'écran, tel que la page l'écrit.
 *
 * Les aperçus s'y greffent pour neutraliser le flux SSE. Le motif visé portait
 * l'attribut `data-mode` en premier ; depuis que la balise a gagné une classe,
 * il ne correspondait plus à rien — silencieusement, puisqu'un `replace` qui ne
 * trouve pas rend la chaîne inchangée. Les aperçus ouvraient donc un vrai
 * `EventSource`, qui écrasait au premier message le rang de boucle forcé plus
 * bas : on relisait autre chose que ce qu'on croyait.
 */
const OUVERTURE_BODY = '<body class="bg-fond'

for (const { nom, payload } of variantes) {
  const html = renderProjectorPage({ initialPayload: payload }).replace(
    OUVERTURE_BODY,
    '<script>window.__APERCU__ = true</script>' + OUVERTURE_BODY,
  )
  const chemin = join(outDir, `ecran-${nom}.html`)
  writeFileSync(chemin, html)
  console.log(`écrit ${chemin}`)
}

/**
 * La boucle d'attente, page par page.
 *
 * Un fichier par page plutôt qu'un seul : l'aperçu est statique, il ne tourne
 * pas — et c'est chaque page qu'on vient juger, pas la bascule. Le rang de
 * départ se force dans le script, comme le style de l'encart plus haut : la
 * page servie, elle, part toujours de zéro.
 */
const PAGES_BOUCLE = ['sponsors', 'programme', 'salles', 'reseaux']
for (const [rang, nom] of PAGES_BOUCLE.entries()) {
  const html = renderProjectorPage({
    initialPayload: { ...base, state: { ...base.state, mode: 'loop' as const } },
  })
    .replace(OUVERTURE_BODY, '<script>window.__APERCU__ = true</script>' + OUVERTURE_BODY)
    .replace('let boucleRang = 0', `let boucleRang = ${rang}`)
  const chemin = join(outDir, `ecran-boucle-${rang + 1}-${nom}.html`)
  writeFileSync(chemin, html)
  console.log(`écrit ${chemin}`)
}
