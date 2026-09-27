import type { AuditEntry } from '@conference-operator/contract'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * The audit log: who did what through the hub, and what came of it.
 *
 * Read after the fact — a scene that switched by itself, a setting nobody
 * remembers changing. Newest first, a numbered page at a time, searched.
 */

export const PAGE_SIZE = 50

export interface Room {
  id: string
  name: string
}

/** Lower case, accents gone: « Démarrée » finds « démarrée » and « demarree ». */
const fold = (text: string) =>
  text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

export const useAuditStore = defineStore('audit', () => {
  const entries = ref<AuditEntry[]>([])
  const total = ref(0)
  const page = ref(1)
  const query = ref('')
  const rooms = ref<Room[]>([])
  const room = ref<string>('')
  const actor = ref<string>('')
  /** Everyone seen so far: the person filter offers them. */
  const actors = ref<string[]>([])

  const session = useSessionStore()

  /**
   * The filters, and the search with what it means in the console's words: the
   * hub stores `sessions.start` and a room's id, the operator types « démarrée »
   * or « Track #1 ».
   */
  const filters = () => {
    const q = query.value.trim()
    const wanted = fold(q)
    return {
      roomId: room.value === '' ? null : room.value,
      actor: actor.value === '' ? null : actor.value,
      q,
      actions: q === '' ? [] : Object.keys(ACTIONS).filter((key) => fold(ACTIONS[key]!).includes(wanted)),
      rooms: q === '' ? [] : rooms.value.filter((r) => fold(r.name).includes(wanted)).map((r) => r.id),
    }
  }

  function remember(rows: AuditEntry[]): void {
    actors.value = [...new Set([...actors.value, ...rows.map((row) => row.actor)])].sort()
  }

  /**
   * The page asked for. Polled: the page on screen is read again, and the hub
   * answers with the last one when it no longer goes that far.
   *
   * Only the latest call writes: a search typed fast sends several, and an older
   * answer arriving last must not replace the newer list.
   */
  let asked = 0
  async function load(): Promise<void> {
    const call = ++asked
    const [answer, roomList] = await Promise.all([
      session.client.rpc.audit.page({ ...filters(), page: page.value, pageSize: PAGE_SIZE }),
      session.client.rpc.rooms.list(),
    ])
    if (call !== asked) return
    entries.value = answer.items as AuditEntry[]
    total.value = answer.total
    page.value = answer.page
    rooms.value = roomList as Room[]
    remember(entries.value)
  }

  async function goTo(next: number): Promise<void> {
    page.value = Math.max(1, next)
    await load()
  }

  async function search(q: string): Promise<void> {
    query.value = q
    page.value = 1
    await load()
  }

  /** A filter changed: start again from the first page. */
  async function reload(): Promise<void> {
    page.value = 1
    await load()
  }

  /** Everything the filters and the search match, however many pages: what the export writes. */
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

  return { entries, total, page, query, rooms, room, actor, actors, load, goTo, search, reload, everything }
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
