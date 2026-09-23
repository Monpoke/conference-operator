/**
 * Generates an offline preview of the room screen, in each of its modes.
 *
 * Uses the *real* page and the *real* event data: what one looks at here is what
 * will be projected. Only the SSE stream is neutralized.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toString } from 'qrcode'
import { agendaForRoom, normalizeProgram, sessionsForRoom } from '@conference-operator/program'
import { DEFAULT_BOUCLE, resolveEventIdentity, type Boucle } from '@conference-operator/contract'
import { BOUCLE } from '@conference-operator/projector'
import { planningsFor } from '@conference-operator/projector/server'
import { renderProjectorPage } from '../src/core/display-page.js'
import { boucleQrUrls, buildBoucleView } from '../src/core/boucle-view.js'
import { availableFonts, resolveFontsFolder } from '../src/core/fonts.js'
import { renderOverlayPage } from '../src/core/overlay-page.js'
import { renderOverlayLivePage } from '../src/core/overlay-live-page.js'
import type { DisplayPayload } from '../src/core/display-server.js'

const outDir = resolve(process.argv[2] ?? './preview')
const TRACK_1 = 'track-1-teilhard-de-chardin'
const AT = Date.parse('2026-10-30T10:20:00.000Z') // 11:20 in Paris, mid-talk

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

/** QR codes drawn with the room's own options. */
const qr = async (url: string) =>
  toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'H', color: { dark: '#0d0f16', light: '#ffffff' } })

/**
 * The loop's content: the reference defaults, with the two things a fresh hub
 * lacks — a code-of-conduct address and a few posts — so that every scene shows.
 */
const settings: Boucle = {
  ...DEFAULT_BOUCLE,
  // The whole day, breaks included: it is what one comes to judge.
  agenda: { masquerTerminees: false },
  conduite: { ...DEFAULT_BOUCLE.conduite, url: 'https://www.cloudnord.fr/code-de-conduite' },
  mur: {
    ...DEFAULT_BOUCLE.mur,
    posts: [
      {
        auteur: 'Camille Roussel', titre: 'Ingénieure SRE chez Pixelmine', photo: null, date: '35 min', image: null,
        texte: "Premier talk de la journée et déjà trois pages de notes.\nMerci à toute l'équipe d'organisation ! #CloudNord2026 #SRE",
        reactions: 86, commentaires: 7, reseau: 'LinkedIn',
      },
      {
        auteur: 'Julien Marchetti', titre: 'CTO chez Hautbanc', photo: null, date: '1 h', image: null,
        texte: 'Très fier d\'avoir présenté notre retour d\'expérience sur la migration de 400 services vers Kubernetes 🚀 #CloudNord2026',
        reactions: 214, commentaires: 31, reseau: 'LinkedIn',
      },
      {
        auteur: 'Sarah Benali', titre: 'Développeuse backend, Ardoise', photo: null, date: '1 h', image: null,
        texte: 'Je découvre l\'événement cette année et je suis bluffée par la qualité des échanges. #CloudNord2026',
        reactions: 47, commentaires: 3, reseau: 'LinkedIn',
      },
    ],
  },
}
const WALLS_IO = 'https://my.walls.io/cloud-nord?token=b58a8dcde25eaeb9d96cddd110abcfc00c2226ec'
const qrCodes = new Map<string, string>()
for (const url of boucleQrUrls(settings, 'cloud-nord-2026')) qrCodes.set(url, await qr(url))
const boucle = buildBoucleView({
  boucle: settings,
  program,
  openFeedbackProjectId: 'cloud-nord-2026',
  wallsIoUrl: WALLS_IO,
  eventShortName: 'Cloud Nord',
  // The preview reads the images where they are: it is not a room, it has no cache.
  localize: (ref) => ref,
  qr: (url) => qrCodes.get(url) ?? null,
})

const base: DisplayPayload = {
  state: {
    mode: 'sponsors',
    message: null,
    liveMessage: null,
    question: null,
    sceneRole: 'HOLD',
    connectivity: 'ONLINE',
    roomId: TRACK_1,
    contentHash: 'preview',
    currentSession: current,
    nextSession: next,
    targetSession: current ?? next,
    targetIsUpcoming: current == null,
    remoteHolder: null,
    // The preview sits on a talk: no break to announce.
    breakBadge: null,
    simulatedClock: false,
    outboxDepth: 0,
    serverTimeOffsetMs: AT - Date.now(),
    recording: true,
    streaming: false,
    audioInputs: [
      { name: 'Micro cravate', muted: { A: false, B: false } },
      { name: 'Micro main', muted: { A: true, B: true } },
      { name: 'Ambiance salle', muted: { A: null, B: false } },
    ],
    comments: [],
    sessionStates: current == null ? {} : { [current.id]: 'running' as const },
    notifications: [
      {
        id: 'n1',
        level: 'info' as const,
        text: 'Platform Engineering à l\'échelle de Décathlon vient de se terminer dans une autre salle',
        // Recent: a notice clears after thirty seconds, showing a two-minute-old one
        // would give an impossible picture.
        at: new Date(AT - 12_000).toISOString(),
      },
      {
        id: 'n2',
        level: 'warning' as const,
        // Both levels in the preview: the background carries the type, and it is
        // precisely what one comes to review here before the day itself.
        text: 'Track #2 dépasse son créneau de 4 minutes',
        at: new Date(AT - 6_000).toISOString(),
      },
    ],
  },
  roomName: 'Track #1 — Teilhard de Chardin',
  pairing: { status: 'paired' },
  diagnostics: {
    // The room is on its own port: the badge has nothing to say, which is the
    // case to review first.
    portFallback: null,
    obs: {
      A: {
        instance: 'A', connected: true, currentSceneName: 'Habillage web',
        currentRole: 'HOLD', unresolvedRoles: ['RELAY'], recording: false, streaming: false,
        scenes: ['Direct — capture HDMI', 'Habillage web', 'Écran noir'],
        // The preview has no OBS instance behind it: saying so is both honest and the
        // only way to review the badge before the day itself.
        simulated: true,
      },
      B: {
        instance: 'B', connected: true, currentSceneName: 'Talk complet',
        currentRole: 'TALK', unresolvedRoles: [], recording: true, streaming: false,
        scenes: ['Talk complet', 'Caméra seule', 'Slides seules'],
        simulated: true,
      },
    },
    // The preview is a development artifact end to end: it says so, which also makes
    // the badge reviewable before the day itself.
    mode: { room: 'dev' as const, hub: 'dev' as const },
    protocol: { room: 1, hub: 1 },
    /** The room's settings: with no passwords, as the control app receives them. */
    config: {
      obs: {
        // A: a setting saved, the connection not reopened yet — the state the preview
        // must show, since it is the one that calls for a gesture.
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
      // A room the hub has given a destination: the preview must show the panel
      // in the state that has a working « Diffuser », since that is the one it
      // is looked at to check.
      stream: { rtmpUrl: 'rtmp://live.exemple.fr/app' },
      promptRecordingOnStart: true,
      promptRecordingOnStop: true,
      sceneOnStart: 'LIVE',
      // The preview shows the installed machine, the one that can open a picker.
      canBrowse: true,
    },
    outboxDepth: 3,
    log: [
      { level: 'warn', message: 'remontée impossible, lot reporté', createdAt: '2026-10-30T11:18:00.000Z' },
      { level: 'info', message: 'assets préchargés', createdAt: '2026-10-30T09:02:00.000Z' },
    ],
    // A null `startedAtCorrectedMs`: the preview shows the production case, where the
    // stopwatch counts in real time. The start is set, the end is not: it is the
    // state of a take in progress, the one one wants to see on a preview.
    recording: {
      active: true,
      markers: 2,
      startedAtMs: AT - 14 * 60_000,
      startedAtCorrectedMs: null,
      editing: { startMs: 52_000, endMs: null },
    },
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
    // The questions are always read attached to a talk: it is what tells "nobody
    // asked anything" from "no talk being driven".
    questionsSession: current == null ? null : { id: current.id, title: current.title },
    /** The same data as `config.relaySourceRoomId`: they have to agree. */
    relaySourceRoomId: 'track-2-mf-1092',
  },
  event: program.event,
  timezone: program.timezone,
  sessions,
  sponsorTiers: program.sponsorTiers,
  /**
   * The public wall and its QR code, **really generated**.
   *
   * It was missing: the room screen therefore showed its previews without the QR
   * code attendees scan, and the control app's "Écrans" menu without the link to
   * the wall. The same options as `prepareWallQr` — it is the QR code that will be
   * projected one wants to look at, not a stand-in image.
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
   * What is going on next door, and the event's accounts.
   *
   * The two pages the loop adds to the rest. A room with no talk in sight appears
   * in it: it is the case that shows it is skipped rather than displayed empty.
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
      running: false,
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
      running: true,
    },
  ],
  // Derived from the fixture, as the hub would derive it from the imported program:
  // the preview then shows the same chain as reality.
  eventIdentity: resolveEventIdentity({ program: program.event.name }),
  socialLinks: [
    { network: 'Bluesky', handle: '@cloudnord.fr', url: 'https://bsky.app/profile/cloudnord.fr' },
    { network: 'LinkedIn', handle: 'Cloud Nord', url: 'https://www.linkedin.com/company/cloud-nord' },
    { network: 'Mastodon', handle: '@cloudnord@piaille.fr', url: 'https://piaille.fr/@cloudnord' },
  ],
  // The preview's wall is the real one: it is the only page whose rendering is
  // done by somebody else, and a placeholder address would show an error frame
  // exactly where the thing to judge is.
  wallsIoUrl: WALLS_IO,
  // Nothing withdrawn: the preview is there to show every screen.
  screensDisabled: [],
  boucle,
  agenda: agendaForRoom(program, TRACK_1, { nowMs: AT }),
  plannings: planningsFor(program, TRACK_1, settings, AT),
  wallsIoReachable: true,
}

const variants: { name: string; payload: DisplayPayload }[] = [
  { name: 'sponsors', payload: base },
  { name: 'programme', payload: { ...base, state: { ...base.state, mode: 'programme' } } },
  // The layout under comparison: the same day, in two columns, on one still screen.
  { name: 'agenda', payload: { ...base, state: { ...base.state, mode: 'agenda' as const } } },
  { name: 'countdown', payload: { ...base, state: { ...base.state, mode: 'countdown' } } },
  { name: 'feedback', payload: { ...base, state: { ...base.state, mode: 'feedback' as const } } },
  { name: 'wallsio', payload: { ...base, state: { ...base.state, mode: 'wallsio' as const } } },
  {
    name: 'question',
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
    // The wall: the only screen the audience photographs. It was missing from the
    // preview, for want of a `wall` in the payload.
    name: 'wall',
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
    name: 'urgent-message',
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

// The capture overlay: a transparent background, with a checkerboard added for the
// preview alone — in OBS, it is the camera and the slides that appear underneath.
const checkerboard =
  '<style>body{background-image:linear-gradient(45deg,#2a2a33 25%,transparent 25%),' +
  'linear-gradient(-45deg,#2a2a33 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#2a2a33 75%),' +
  'linear-gradient(-45deg,transparent 75%,#2a2a33 75%);background-size:40px 40px;' +
  'background-position:0 0,0 20px,20px -20px,-20px 0;background-color:#1d1d22}</style>'
const overlay = renderOverlayPage({ initialPayload: base })
  .replace('<body ', `<script>window.__PREVIEW__ = true</script>${checkerboard}<body `)
writeFileSync(join(outDir, 'overlay-recording.html'), overlay)
console.log(`written ${join(outDir, 'overlay-recording.html')}`)

/**
 * The same overlay, with an audience question on air.
 *
 * Two files rather than one: it is the framing of both cards together one comes to
 * judge — the lower third on the left, the question on the right — and it does not
 * show on a preview where one of the two is missing.
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
}).replace('<body ', `<script>window.__PREVIEW__ = true</script>${checkerboard}<body `)
writeFileSync(join(outDir, 'overlay-recording-question.html'), overlayQuestion)
console.log(`written ${join(outDir, 'overlay-recording-question.html')}`)

// The live banner: the only surface a preview can show in situation, since it only
// displays on the console's order.
/** The banner's two presentations, side by side in the previews. */
for (const style of ['bandeau', 'encart'] as const) {
  const page = renderOverlayLivePage({
    initialPayload: {
      ...base,
      state: {
        ...base.state,
        // A question, not a banner: it is the case that shows the card's
        // "Question du public" label.
        question: {
          text: 'Comment gérez-vous les faux positifs sur un honeypot exposé ?',
          author: 'Camille',
          sessionId: current?.id ?? null,
        },
      },
    },
  })
    .replace('<body ', `<script>window.__PREVIEW__ = true</script>${checkerboard}<body `)
    // The preview opens over `file://`, with no address parameter: we set the style
    // as `?style=` would.
    .replace("get('style')", `get('style') ?? '${style}'`)
  writeFileSync(join(outDir, `overlay-live-${style}.html`), page)
  console.log(`written ${join(outDir, `overlay-live-${style}.html`)}`)
}

const banner = renderOverlayLivePage({
  initialPayload: {
    ...base,
    state: {
      ...base.state,
      liveMessage: { text: 'Reprise dans 5 minutes', level: 'info', expiresAtMs: null },
    },
  },
}).replace('<body ', `<script>window.__PREVIEW__ = true</script>${checkerboard}<body `)
writeFileSync(join(outDir, 'overlay-live-banner.html'), banner)
console.log(`written ${join(outDir, 'overlay-live-banner.html')}`)

/**
 * The page, frozen for review: no stream, no transitions, the loop paused on
 * one scene. The typefaces are read from the folder the room serves them from.
 */
const fontsFolder = resolveFontsFolder()
function preview(payload: DisplayPayload, scene: number | null): string {
  const html = renderProjectorPage({
    initialPayload: payload,
    fonts: fontsFolder == null ? undefined : { base: `file://${fontsFolder}`, files: availableFonts(fontsFolder) },
  })
  const freeze = scene == null ? '' : `boucle.pause(); boucle.allerA(${scene}, 'cut');`
  return html
    .replace('<body ', "<script>window.__PREVIEW__ = true; window.__BOUCLE__ = { transition: 'cut' }</script><body ")
    .replace('</body>', `<script>${freeze} boucle.pause()</script></body>`)
}

for (const { name, payload } of variants) {
  const filePath = join(outDir, `display-${name}.html`)
  writeFileSync(filePath, preview(payload, null))
  console.log(`written ${filePath}`)
}

/**
 * The welcome loop, scene by scene.
 *
 * One file per scene rather than a single one: it is each scene one comes to
 * judge, not the switch. The slots the hub leaves empty (a fourth announcement,
 * an eighth sponsor page) are left out.
 */
const loop = { ...base, state: { ...base.state, mode: 'loop' as const } }
for (const [index, step] of BOUCLE.entries()) {
  const filePath = join(outDir, `display-loop-${String(index + 1).padStart(2, '0')}-${step.scene}.html`)
  writeFileSync(filePath, preview(loop, index + 1))
  console.log(`written ${filePath}`)
}
