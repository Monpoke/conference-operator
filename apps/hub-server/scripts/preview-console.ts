/**
 * Écrit des aperçus statiques de la console et du mur.
 *
 * Permet de relire l'habillage sans démarrer un hub, sans base et sans compte —
 * utile pour juger la mise en page, et pour comparer deux états d'un écran
 * (file de modération vide ou pleine) qu'on ne reproduit pas à la demande le
 * jour J.
 *
 *   pnpm --filter @cloudnord/hub-server preview [dossier]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { renderAdminPage } from '../src/pages/admin-page.js'
import { renderWallPage } from '../src/pages/wall-page.js'

const outDir = resolve(process.argv[2] ?? './preview')
mkdirSync(outDir, { recursive: true })

const SALLES = [
  { id: 'track-1-teilhard-de-chardin', name: 'Track #1 — Teilhard de Chardin' },
  { id: 'track-2-mf-1092', name: 'Track #2 — MF 1092' },
  { id: 'hands-on', name: 'Hands on' },
]

/** Réponses servies à la place du hub, par procédure oRPC. */
const REPONSES: Record<string, unknown> = {
  'rooms/list': SALLES,
  'rooms/statuses': [
    {
      roomId: SALLES[0]!.id, name: SALLES[0]!.name, connectivity: 'ONLINE',
      sceneRole: 'LIVE', recording: true, streaming: false, outboxDepth: 0,
      lastSeenAt: '2026-10-30T10:12:00.000Z', programContentHash: 'a1b2c3d4e5',
      currentSession: { id: 'ses-1', title: 'HoneySwamp: Active Defense to Ruin Attackers', endsAt: '2026-10-30T10:50:00.000Z' },
    },
    {
      roomId: SALLES[1]!.id, name: SALLES[1]!.name, connectivity: 'DEGRADED',
      sceneRole: 'HOLD', recording: false, streaming: false, outboxDepth: 3,
      lastSeenAt: '2026-10-30T10:09:30.000Z', programContentHash: 'a1b2c3d4e5',
      currentSession: { id: 'ses-2', title: '100 % open source, au-dessus de la mêlée', endsAt: '2026-10-30T10:50:00.000Z' },
    },
    {
      roomId: SALLES[2]!.id, name: SALLES[2]!.name, connectivity: 'OFFLINE',
      sceneRole: null, recording: false, streaming: false, outboxDepth: 12,
      lastSeenAt: '2026-10-30T09:41:00.000Z', programContentHash: '9f8e7d6c5b',
      currentSession: null,
    },
  ],
  'devices/pending': [
    { userCode: 'FH9BAXGZ', clientId: '01JBQ...9K2', requestedRoomId: SALLES[2]!.id, requestedAt: '2026-10-30T08:55:00.000Z' },
  ],
  'devices/list': [
    { id: 'dev-1', label: 'Régie Track #1', roomId: SALLES[0]!.id, lastSeenAt: '2026-10-30T10:12:00.000Z' },
    { id: 'dev-2', label: 'Régie Track #2', roomId: SALLES[1]!.id, lastSeenAt: '2026-10-30T10:09:30.000Z' },
  ],
  'program/snapshots': [
    { id: 'snap-2', contentHash: 'a1b2c3d4e5f6', sessions: 27, anomalies: 1, active: true, importedAt: '2026-10-29T18:02:00.000Z' },
    { id: 'snap-1', contentHash: '9f8e7d6c5b4a', sessions: 26, anomalies: 0, active: false, importedAt: '2026-10-27T14:20:00.000Z' },
  ],
  'wall/pending': [
    { id: 'c-1', source: 'bluesky', author: 'Camille', text: 'Belle démo sur les Event Iterators, merci !', createdAt: '2026-10-30T10:05:00.000Z' },
    { id: 'c-2', source: 'form', author: 'Sacha', text: 'Les slides seront-elles partagées après la conf ?', createdAt: '2026-10-30T10:07:30.000Z' },
  ],
  'messages/fromRooms': [
    { id: 'm-1', roomId: SALLES[1]!.id, roomName: SALLES[1]!.name, text: 'Micro cravate HS, on passe sur le micro main', level: 'warning', at: '2026-10-30T10:03:00.000Z' },
    { id: 'm-2', roomId: SALLES[0]!.id, roomName: SALLES[0]!.name, text: 'Speaker arrivé, tout est prêt', level: 'info', at: '2026-10-30T09:58:00.000Z' },
  ],
  'sessions/states': [
    // `remainingMs` vient du hub : c'est lui qui tient l'heure qui fait foi, et
    // elle peut être simulée. L'aperçu doit donc le fournir, sinon la colonne
    // « Reste » y reste vide sans qu'on sache pourquoi.
    { sessionId: 'ses-1', roomId: SALLES[0]!.id, roomName: SALLES[0]!.name, title: 'HoneySwamp : piéger les bots', status: 'running', scheduledStartsAt: '2026-10-30T10:00:00.000Z', scheduledEndsAt: '2026-10-30T10:50:00.000Z', remainingMs: 23 * 60_000, decidedBy: 'operator' },
    { sessionId: 'ses-2', roomId: SALLES[1]!.id, roomName: SALLES[1]!.name, title: 'Observabilité sous pression', status: 'ended', scheduledStartsAt: '2026-10-30T09:00:00.000Z', scheduledEndsAt: '2026-10-30T09:50:00.000Z', remainingMs: -4 * 60_000, decidedBy: 'auto' },
  ],
  /**
   * Planning du programme actif.
   *
   * Une pause y figure : c'est le cas qui montre qu'une ligne sans intervenant
   * ne propose pas de lien OpenFeedback — on ne note pas un déjeuner.
   */
  'program/planning': {
    contentHash: 'a1b2c3d4e5f6',
    timezone: 'Europe/Paris',
    // 10:12 UTC : le premier créneau est en cours, c'est lui que l'aperçu doit
    // montrer surligné.
    serverTime: '2026-10-30T10:12:00.000Z',
    rooms: SALLES,
    sessions: [
      { id: 'ses-1', title: 'HoneySwamp : piéger les bots', speakers: ['Steven LE ROUX'], startsAt: '2026-10-30T10:00:00.000Z', endsAt: '2026-10-30T10:50:00.000Z', roomId: SALLES[0]!.id, roomName: SALLES[0]!.name, kind: 'talk', feedbackUrl: 'https://openfeedback.io/cloud-nord-2026/2026-10-30/ses-1' },
      { id: 'ses-2', title: '100 % open source, au-dessus de la mêlée', speakers: ['Camille Durand', 'Sacha Nguyen'], startsAt: '2026-10-30T10:00:00.000Z', endsAt: '2026-10-30T10:50:00.000Z', roomId: SALLES[1]!.id, roomName: SALLES[1]!.name, kind: 'talk', feedbackUrl: 'https://openfeedback.io/cloud-nord-2026/2026-10-30/ses-2' },
      { id: 'pause-midi', title: 'Déjeuner', speakers: [], startsAt: '2026-10-30T11:00:00.000Z', endsAt: '2026-10-30T12:00:00.000Z', roomId: null, roomName: null, kind: 'break', feedbackUrl: null },
      { id: 'ses-3', title: 'Event Iterators en production', speakers: ['Alex Martin'], startsAt: '2026-10-30T12:00:00.000Z', endsAt: '2026-10-30T12:50:00.000Z', roomId: SALLES[2]!.id, roomName: SALLES[2]!.name, kind: 'talk', feedbackUrl: 'https://openfeedback.io/cloud-nord-2026/2026-10-30/ses-3' },
    ],
  },
  'settings/get': {
    autoEndGraceMinutes: 5,
    autoEndEnabled: true,
    programSourceUrl: 'https://exemple.test/programme.json',
    socialLinks: [
      { network: 'Bluesky', handle: '@cloudnord.fr', url: 'https://bsky.app/profile/cloudnord.fr' },
      { network: 'LinkedIn', handle: 'Cloud Nord', url: 'https://www.linkedin.com/company/cloud-nord' },
    ],
  },
  'wall/recent': [
    { id: 'c-1', source: 'form', author: 'Camille', authorHandle: null, text: 'Super talk, merci !', status: 'approved', roomId: null, sessionId: null, createdAt: '2026-10-30T10:05:00.000Z' },
  ],
  'clock/get': { now: '2026-10-30T10:12:00.000Z', simulated: true },
  'overlay/history': [
    { seq: 12, roomId: null, message: { text: 'Reprise dans 5 minutes', level: 'info' }, issuedAt: '2026-10-30T10:06:00.000Z', visible: true },
    { seq: 9, roomId: SALLES[0]!.id, message: { text: 'Problème de son en cours de résolution', level: 'warning' }, issuedAt: '2026-10-30T09:41:00.000Z', visible: false },
  ],
  'rooms/current': {
    current: {
      id: 'ses-1',
      title: 'HoneySwamp: Active Defense to Ruin Attackers',
      speakers: ['Steven LE ROUX'],
      startsAt: '2026-10-30T10:00:00.000Z',
      endsAt: '2026-10-30T10:50:00.000Z',
    },
    next: null,
  },
  'questions/list': [
    { id: 'q1', roomId: SALLES[0]!.id, sessionId: 'ses-1', author: 'Camille', text: 'Comment gérez-vous les faux positifs ?', votes: 7, status: 'open', createdAt: '2026-10-30T10:12:00.000Z' },
  ],
}

/**
 * Injecte une session et un hub simulé **avant** le script de la page.
 *
 * Évite d'ajouter un mode aperçu dans le code de production : la page reste
 * exactement celle qui est servie, seul son environnement est truqué.
 */
function figer(html: string, vueActive: string | null): string {
  const amorce = `<script>
    localStorage.setItem('cloudnord-admin', 'jeton-apercu')
    window.fetch = async (url) => {
      const chemin = String(url).replace('/rpc/', '')
      const json = ${JSON.stringify(REPONSES)}[chemin] ?? []
      return new Response(JSON.stringify({ json }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    ${vueActive == null ? '' : `addEventListener('load', () => document.getElementById('nav-${vueActive}')?.click())`}
  </script>`
  return html.replace('<body', `${amorce}<body`)
}

const VUES: [string, string | null][] = [
  ['console-exploitation', null],
  ['console-appairage', 'appairage'],
  ['console-conferences', 'conferences'],
  ['console-moderation', 'moderation'],
  ['console-messages', 'messages'],
  ['console-reglages', 'reglages'],
]

for (const [nom, vue] of VUES) {
  const chemin = join(outDir, `${nom}.html`)
  writeFileSync(chemin, figer(renderAdminPage(), vue))
  console.log(`écrit ${chemin}`)
}

/**
 * Les deux états qu'un hub mal réglé — ou de développement — doit montrer.
 *
 * Vues à part plutôt que badge sur les cinq vues courantes, qui reviendrait à
 * ne plus les voir. Et deux fichiers plutôt qu'un : les deux états ne peuvent
 * pas coexister, puisque rien n'est neutralisé en mode développement.
 */
const MODES: [string, Parameters<typeof renderAdminPage>[0], string][] = [
  // Ouvert sur le menu Développement : c'est ce que ce mode ajoute, et il
  // n'existe nulle part ailleurs.
  ['console-mode-dev', { mode: 'dev' }, 'developpement'],
  [
    'console-reglages-neutralises',
    {
      mode: 'production',
      // Les deux causes, qui ne se corrigent pas de la même façon : une
      // variable réservée au développement, et une autre qui n'existe plus.
      ignores: [
        { variable: 'SIMULATED_TIME', raison: 'réservé au mode développement (MODE=dev)' },
        { variable: 'CLOCK_CONTROL', raison: "remplacé par MODE=dev, qui ouvre le réglage de l'heure" },
      ],
    },
    'reglages',
  ],
]

for (const [nom, options, vue] of MODES) {
  const chemin = join(outDir, `${nom}.html`)
  writeFileSync(chemin, figer(renderAdminPage(options), vue))
  console.log(`écrit ${chemin}`)
}

const mur = join(outDir, 'mur-public.html')
writeFileSync(mur, figer(renderWallPage({ roomId: SALLES[0]!.id, rooms: SALLES }), null))
console.log(`écrit ${mur}`)
