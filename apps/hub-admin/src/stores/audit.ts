import type { AuditEntry } from '@conference-operator/contract'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * The audit log: who did what through the hub, and what came of it.
 *
 * Read after the fact — a scene that switched by itself, a setting nobody
 * remembers changing. Newest first, a page at a time.
 */

const PAGE = 200

export interface Room {
  id: string
  name: string
}

export const useAuditStore = defineStore('audit', () => {
  const entries = ref<AuditEntry[]>([])
  const rooms = ref<Room[]>([])
  const room = ref<string>('')
  const actor = ref<string>('')
  /** Everyone seen so far: the person filter offers them. */
  const actors = ref<string[]>([])
  /** A page came back full: there may be more below. */
  const more = ref(false)

  const session = useSessionStore()

  const filters = () => ({
    roomId: room.value === '' ? null : room.value,
    actor: actor.value === '' ? null : actor.value,
  })

  function remember(rows: AuditEntry[]): void {
    actors.value = [...new Set([...actors.value, ...rows.map((row) => row.actor)])].sort()
  }

  /** The newest page. Polled: what is below stays as it was loaded. */
  async function load(): Promise<void> {
    const [rows, roomList] = await Promise.all([
      session.client.rpc.audit.list({ ...filters(), limit: PAGE }),
      session.client.rpc.rooms.list(),
    ])
    const fresh = rows as AuditEntry[]
    const oldest = fresh.at(-1)?.id
    // The pages loaded below the fresh one stay: a poll must not fold them away.
    const below = oldest == null ? [] : entries.value.filter((row) => row.id < oldest)
    if (below.length === 0) more.value = fresh.length === PAGE
    entries.value = [...fresh, ...below]
    rooms.value = roomList as Room[]
    remember(fresh)
  }

  async function loadMore(): Promise<void> {
    const beforeId = entries.value.at(-1)?.id ?? null
    const rows = (await session.client.rpc.audit.list({ ...filters(), beforeId, limit: PAGE })) as AuditEntry[]
    entries.value = [...entries.value, ...rows]
    more.value = rows.length === PAGE
    remember(rows)
  }

  /** A filter changed: start again from the top. */
  async function reload(): Promise<void> {
    entries.value = []
    await load()
  }

  /** Everything the filters match, however many pages: what the export writes. */
  async function everything(): Promise<AuditEntry[]> {
    const all: AuditEntry[] = []
    for (;;) {
      const rows = (await session.client.rpc.audit.list({
        ...filters(),
        beforeId: all.at(-1)?.id ?? null,
        limit: 1000,
      })) as AuditEntry[]
      all.push(...rows)
      if (rows.length < 1000) return all
    }
  }

  return { entries, rooms, room, actor, actors, more, load, loadMore, reload, everything }
})

/** The procedures, in the operator's words. */
const ACTIONS: Record<string, string> = {
  'regie.hold': 'Prise de main (régie mobile)',
  'regie.release': 'Main rendue (régie mobile)',
  'sessions.start': 'Conférence démarrée',
  'sessions.end': 'Conférence terminée',
  'sessions.reset': 'Conférence remise à « à venir »',
  'sessions.override': 'Statut de conférence forcé',
  'sessions.swap': 'Créneaux échangés',
  'sessions.resetSlots': 'Créneaux rendus au programme',
  'sessions.pin': 'Conférence forcée en salle',
  'sessions.feedbackId': 'Identifiant OpenFeedback corrigé',
  'overlay.show': 'Bandeau affiché',
  'overlay.hide': 'Bandeau retiré',
  'messages.send': 'Message envoyé',
  'settings.update': 'Réglages modifiés',
  'boucle.uploadImage': 'Image de la boucle envoyée',
  'wallsio.setToken': 'Jeton walls.io modifié',
  'rooms.setStream': 'Diffusion configurée',
  'rooms.resync': 'Resynchronisation demandée',
  'program.import': 'Programme importé',
  'program.activate': 'Programme activé',
  'devices.approve': 'Poste approuvé',
  'devices.deny': 'Poste refusé',
  'devices.revoke': 'Poste révoqué',
  'wall.moderate': 'Message du mur modéré',
  'wall.feature': 'Message du mur mis en avant',
  'wall.save': 'Message du mur modifié',
  'clock.set': 'Horloge du hub réglée',
  'vod.reset': 'VOD réinitialisées',
  'vod.request': 'Rapatriement des VOD demandé',
  'push.subscribe': 'Notifications activées',
  'push.unsubscribe': 'Notifications désactivées',
  'integrations.create': 'Intégration ajoutée',
  'integrations.update': 'Intégration modifiée',
  'integrations.remove': 'Intégration supprimée',
  'integrations.test': 'Intégration testée',
  'auth.admin.create-user': 'Compte créé',
  'auth.admin.set-role': 'Rôle modifié',
  'auth.admin.ban-user': 'Compte suspendu',
  'auth.admin.unban-user': 'Compte réactivé',
  'auth.admin.remove-user': 'Compte supprimé',
  'auth.admin.set-user-password': 'Mot de passe changé',
  'auth.admin.update-user': 'Compte modifié',
  'auth.admin.revoke-user-session': 'Session révoquée',
  'auth.admin.revoke-user-sessions': 'Sessions révoquées',
}

/** A gesture sent to a room, read from its request. */
function gesture(detail: string | null): string | null {
  let action: Record<string, unknown> | undefined
  try {
    action = (JSON.parse(detail ?? 'null') as { action?: Record<string, unknown> } | null)?.action
  } catch {
    return null
  }
  if (action == null) return null
  switch (action.type) {
    case 'scene.set': return `Scène ${String(action.role)}`
    case 'display.set': return `Écran : ${String(action.mode)}`
    case 'recording.set': return action.on === true ? 'Enregistrement démarré' : 'Enregistrement arrêté'
    case 'stream.set': return action.on === true ? 'Diffusion démarrée' : 'Diffusion arrêtée'
    case 'audio.mute': return `${String(action.input)} ${action.muted === true ? 'coupé' : 'rétabli'}`
    case 'session.start': return 'Conférence démarrée'
    case 'session.end': return 'Conférence terminée'
    case 'session.reset': return 'Conférence remise à « à venir »'
    default: return null
  }
}

/** What was done, in words. */
export function actionLabel(entry: AuditEntry): string {
  if (entry.action === 'regie.command') {
    const said = gesture(entry.detail)
    return said == null ? 'Geste de régie mobile' : `${said} (régie mobile)`
  }
  return ACTIONS[entry.action] ?? entry.action
}

/** A room that has not answered in this long will not: it was cut off, or is older. */
const SILENCE_MS = 30_000

/** What came of it: the hub's answer, then the room's when it was sent one. */
export function resultOf(entry: AuditEntry, nowMs: number): { label: string; tone: string } {
  if (!entry.ok) return { label: `Refusé${entry.error ? ` : ${entry.error}` : ''}`, tone: 'text-alert' }
  if (entry.commandSeq == null) return { label: 'Fait', tone: '' }
  if (entry.outcome != null) {
    return entry.outcome.ok
      ? { label: 'Fait en salle', tone: 'text-ok' }
      : { label: `Refusé en salle${entry.outcome.message ? ` : ${entry.outcome.message}` : ''}`, tone: 'text-alert' }
  }
  return nowMs - Date.parse(entry.at) > SILENCE_MS
    ? { label: 'Pas de réponse de la salle', tone: 'text-warn' }
    : { label: 'Envoyé à la salle…', tone: 'text-dim' }
}

/** One CSV cell: quoted, its quotes doubled. */
const cell = (value: string | null | undefined): string => `"${(value ?? '').replaceAll('"', '""')}"`

/**
 * The log as CSV, for a spreadsheet.
 *
 * A semicolon, and a byte order mark: what a French spreadsheet opens as columns
 * rather than as one line of commas.
 */
export function toCsv(entries: AuditEntry[], roomName: (id: string) => string, nowMs: number): string {
  const header = ['Date', 'Qui', 'Action', 'Salle', 'Résultat', 'Détail']
  const lines = entries.map((entry) =>
    [
      entry.at,
      entry.actor,
      actionLabel(entry),
      entry.roomId == null ? '' : roomName(entry.roomId),
      resultOf(entry, nowMs).label,
      entry.detail,
    ]
      .map(cell)
      .join(';'),
  )
  return `﻿${[header.map(cell).join(';'), ...lines].join('\r\n')}\r\n`
}
