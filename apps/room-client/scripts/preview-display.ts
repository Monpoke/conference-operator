/**
 * Génère un aperçu hors ligne de l'écran de salle, dans chacun de ses modes.
 *
 * Utilise la *vraie* page et les *vraies* données de l'événement : ce qu'on
 * regarde ici est ce qui sera projeté. Seul le flux SSE est neutralisé.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeProgram, sessionsForRoom } from '@cloudnord/program'
import { renderProjectorPage } from '../src/core/display-page.js'
import { renderOverlayPage } from '../src/core/overlay-page.js'
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
        at: new Date(AT - 90_000).toISOString(),
      },
    ],
  },
  roomName: 'Track #1 — Teilhard de Chardin',
  pairing: { status: 'paired' },
  diagnostics: {
    obs: {
      A: {
        instance: 'A', connected: true, currentSceneName: 'Habillage web',
        currentRole: 'HOLD', unresolvedRoles: [], recording: false, streaming: false,
      },
      B: {
        instance: 'B', connected: true, currentSceneName: 'Talk complet',
        currentRole: 'TALK', unresolvedRoles: ['RELAY'], recording: true, streaming: false,
      },
    },
    outboxDepth: 3,
    journal: [
      { level: 'warn', message: 'remontée impossible, lot reporté', createdAt: '2026-10-30T11:18:00.000Z' },
      { level: 'info', message: 'assets préchargés', createdAt: '2026-10-30T09:02:00.000Z' },
    ],
    recording: { active: true, markers: 2, startedAtMs: AT - 14 * 60_000 },
    rooms: [
      { roomId: 'track-1-teilhard-de-chardin', name: 'Track #1 — Teilhard de Chardin', connectivity: 'ONLINE', sceneRole: 'LIVE', recording: true, outboxDepth: 3, lastSeenAt: new Date(AT - 4_000).toISOString() },
      { roomId: 'track-2-mf-1092', name: 'Track #2 — MF 1092', connectivity: 'ONLINE', sceneRole: 'HOLD', recording: false, outboxDepth: 0, lastSeenAt: new Date(AT - 9_000).toISOString() },
      { roomId: 'hands-on', name: 'Hands on', connectivity: 'OFFLINE', sceneRole: null, recording: false, outboxDepth: 41, lastSeenAt: new Date(AT - 480_000).toISOString() },
    ],
    roomsRefreshedAt: new Date(AT - 6_000).toISOString(),
  },
  event: program.event,
  timezone: program.timezone,
  sessions,
  sponsorTiers: program.sponsorTiers,
}

const variantes: { nom: string; payload: DisplayPayload }[] = [
  { nom: 'sponsors', payload: base },
  { nom: 'programme', payload: { ...base, state: { ...base.state, mode: 'programme' } } },
  { nom: 'compte-a-rebours', payload: { ...base, state: { ...base.state, mode: 'countdown' } } },
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

const regie = apercuRegie(
  base,
  `; window.__NIVEAUX__ = ${JSON.stringify(NIVEAUX)}` +
    `; window.__PROGRAMMES__ = ${JSON.stringify(PROGRAMMES)}`,
)
writeFileSync(join(outDir, 'regie.html'), regie)
console.log(`écrit ${join(outDir, 'regie.html')}`)

// La modale de consultation, ouverte : sinon rien dans l'aperçu ne montre les
// programmes ni l'état des salles, qui ne s'affichent plus qu'à la demande.
// Ouverte par un vrai clic sur le vrai bouton, pour ne rien avoir à simuler.
const modale = regie.replace(
  '</body>',
  '<script>document.getElementById("btn-programme").click()</script></body>',
)
writeFileSync(join(outDir, 'regie-programme.html'), modale)
console.log(`écrit ${join(outDir, 'regie-programme.html')}`)

for (const { nom, payload } of variantes) {
  const html = renderProjectorPage({ initialPayload: payload }).replace(
    '<body data-mode="sponsors"',
    '<script>window.__APERCU__ = true</script><body data-mode="sponsors"',
  )
  const chemin = join(outDir, `ecran-${nom}.html`)
  writeFileSync(chemin, html)
  console.log(`écrit ${chemin}`)
}
