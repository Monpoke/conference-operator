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
    },
    {
      roomId: SALLES[1]!.id, name: SALLES[1]!.name, connectivity: 'DEGRADED',
      sceneRole: 'HOLD', recording: false, streaming: false, outboxDepth: 3,
      lastSeenAt: '2026-10-30T10:09:30.000Z', programContentHash: 'a1b2c3d4e5',
    },
    {
      roomId: SALLES[2]!.id, name: SALLES[2]!.name, connectivity: 'OFFLINE',
      sceneRole: null, recording: false, streaming: false, outboxDepth: 12,
      lastSeenAt: '2026-10-30T09:41:00.000Z', programContentHash: '9f8e7d6c5b',
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
    { sessionId: 'ses-1', roomId: SALLES[0]!.id, roomName: SALLES[0]!.name, title: 'HoneySwamp : piéger les bots', status: 'running', scheduledStartsAt: '2026-10-30T10:00:00.000Z', scheduledEndsAt: '2026-10-30T10:50:00.000Z', decidedBy: 'operator' },
    { sessionId: 'ses-2', roomId: SALLES[1]!.id, roomName: SALLES[1]!.name, title: 'Observabilité sous pression', status: 'ended', scheduledStartsAt: '2026-10-30T09:00:00.000Z', scheduledEndsAt: '2026-10-30T09:50:00.000Z', decidedBy: 'auto' },
  ],
  'settings/get': { autoEndGraceMinutes: 5, wallEnabled: true, questionsEnabled: true },
  'clock/get': { now: '2026-10-30T10:12:00.000Z', simulated: true },
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

const mur = join(outDir, 'mur-public.html')
writeFileSync(mur, renderWallPage({ roomId: SALLES[0]!.id, rooms: SALLES }))
console.log(`écrit ${mur}`)
