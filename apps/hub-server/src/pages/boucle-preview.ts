import { toString as qrSvg } from 'qrcode'
import type { DisplayPayload } from '@conference-operator/contract'
import { agendaForRoom, DEFAULT_TIMEZONE, sessionsForRoom } from '@conference-operator/program'
import { timelinePosition } from '@conference-operator/program/selectors'
import { breakOfSlots } from '@conference-operator/room-state'
import {
  availableFonts,
  boucleQrUrls,
  buildBoucleView,
  buildWallCards,
  otherRoomsFor,
  planningsFor,
  renderProjectorDocument,
} from '@conference-operator/projector/server'
import type { Services } from '../context.js'

/** The `salle` of the global screen: the whole program, no room of its own. */
export const SALLE_GLOBALE = 'global'

export interface BouclePreviewOptions {
  /** The room to preview; `null` = the program's first; `global` = the whole program. */
  roomId: string | null
  /** A scene of the loop to hold (1 = the welcome); `null` = the loop plays. */
  scene: number | null
  /**
   * The time the preview is drawn at, for the preview alone: `HH:MM` on `jour`
   * (`YYYY-MM-DD`, default the event's first day), in the event's timezone.
   * `null` = the hub's clock. The rooms never see it — nothing is set on the hub.
   */
  heure?: string | null
  jour?: string | null
  /** Where the typefaces are, and the address they are served from. */
  fonts: { folder: string | null; base: string }
  /**
   * Where the page fetches its state again, every twenty seconds — the public
   * and global screens stay on for hours. `null` = drawn once (a console
   * preview, which is reloaded after a save; a preview at a set time).
   */
  flux?: string | null
}

/** The same options as the room's QR codes: photographed from afar, at an angle. */
const QR_OPTIONS = {
  type: 'svg',
  margin: 1,
  errorCorrectionLevel: 'H',
  color: { dark: '#0d0f16', light: '#ffffff' },
} as const

/**
 * The room screen, drawn by the hub for its console.
 *
 * The **same document** the room projects (`renderProjectorDocument`), fed with a
 * state the hub builds the way a room would from what it would receive at sync:
 * the served program, the loop's settings, the accounts, the walls.io address,
 * the withdrawn screens — on the hub's clock, simulated or not. What differs is
 * only what a room knows alone: the images come from the hub's store rather than
 * a room's cache (an address the hub has not fetched yet is shown from its
 * source), walls.io is assumed to answer, and nothing streams — the page is
 * reloaded after a save.
 */
export async function renderBouclePreview(services: Services, options: BouclePreviewOptions): Promise<string> {
  return renderProjectorDocument({
    initialPayload: await previewPayload(services, options),
    preview: true,
    fonts: { base: options.fonts.base, files: availableFonts(options.fonts.folder) },
    after: [
      options.flux ? `boucle.suivre(${JSON.stringify(options.flux)}, 20000)` : '',
      // Held on one scene: no transition, the loop paused there.
      options.scene == null ? '' : `boucle.pause(); boucle.allerA(${Math.max(1, Math.trunc(options.scene))}, 'cut')`,
    ].filter(Boolean).join(';') || undefined,
  })
}

/**
 * The state a room would build from its sync — or, for the global screen, the
 * one of a room that is none: no agenda of its own, every room's schedule.
 */
export async function previewPayload(services: Services, options: BouclePreviewOptions): Promise<DisplayPayload> {
  const settings = services.settings.get()
  const snapshot = services.programs.active()
  const program = snapshot?.program ?? null
  const now = previewTime(options, program?.timezone ?? DEFAULT_TIMEZONE, program?.event.startsAt ?? null)
    ?? services.clock.now()
  const identity = services.identity.get()
  const global = options.roomId === SALLE_GLOBALE
  const roomId = program == null || global
    ? null
    : (program.rooms.find((room) => room.id === options.roomId) ?? program.rooms[0])?.id ?? null
  const room = program?.rooms.find((candidate) => candidate.id === roomId) ?? null

  const localize = (ref: string | null) =>
    ref == null ? null : (services.assets.previewUrl(ref) ?? (/^https?:\/\//.test(ref) ? ref : null))
  const qrCodes = new Map<string, string>()
  for (const url of boucleQrUrls(settings.boucle, settings.openFeedbackProjectId)) {
    qrCodes.set(url, await qrSvg(url, QR_OPTIONS))
  }
  const boucle = buildBoucleView({
    boucle: settings.boucle,
    program,
    openFeedbackProjectId: settings.openFeedbackProjectId,
    eventShortName: identity.shortName,
    localize,
    qr: (url) => qrCodes.get(url) ?? null,
  })

  const slots = program == null || roomId == null ? [] : sessionsForRoom(program, roomId)
  const { current, next } = timelinePosition(slots, now)
  const pause = breakOfSlots(slots, now)

  const payload = {
    state: {
      mode: 'loop',
      message: null,
      liveMessage: null,
      question: null,
      sceneRole: 'HOLD',
      connectivity: 'ONLINE',
      roomId,
      contentHash: snapshot?.contentHash ?? null,
      currentSession: current,
      nextSession: next,
      targetSession: current ?? next,
      targetIsUpcoming: current == null,
      breakBadge: pause == null
        ? null
        : { state: pause.state, title: pause.session.title, startsAt: pause.session.startsAt },
      outboxDepth: 0,
      // The page reads its time as the machine's plus this offset: the hub's
      // clock, simulated or not, is what the preview shows.
      serverTimeOffsetMs: now - Date.now(),
      recording: false,
      streaming: false,
      audioInputs: [],
      comments: [],
      sessionStates: {},
      notifications: [],
    },
    roomName: room?.name ?? null,
    event: program?.event ?? null,
    timezone: program?.timezone ?? DEFAULT_TIMEZONE,
    sessions: slots,
    sponsorTiers: program?.sponsorTiers ?? [],
    diagnostics: null,
    wall: null,
    feedback: null,
    pairing: null,
    otherRooms: program == null ? [] : otherRoomsFor(program, roomId, now),
    socialLinks: settings.socialLinks,
    screensDisabled: settings.screensDisabled,
    eventIdentity: identity,
    boucle,
    agenda: program == null || roomId == null
      ? []
      : agendaForRoom(program, roomId, { nowMs: now }),
    plannings: program == null ? [] : planningsFor(program, roomId, settings.boucle, now),
    // The hub's own wall, as the rooms will show it.
    socialWall: buildWallCards(services.wall.screen().posts, localize),
  } as unknown as DisplayPayload

  return payload
}

/**
 * The instant of `heure` on `jour`, in the event's timezone — or `null` when
 * `heure` is absent or malformed.
 *
 * Found by correcting a first guess by the zone's offset at that guess: exact
 * everywhere but inside a daylight-saving jump, where a preview can live with a
 * minute that does not exist.
 */
export function previewTime(
  options: Pick<BouclePreviewOptions, 'heure' | 'jour'>,
  timezone: string,
  eventStart: string | null,
): number | null {
  const time = /^(\d{1,2}):(\d{2})$/.exec(options.heure ?? '')
  if (time == null) return null
  const dayOf = (ms: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(ms)
        .map((part) => [part.type, part.value]),
    )
    return `${parts.year}-${parts.month}-${parts.day}`
  }
  const day = /^\d{4}-\d{2}-\d{2}$/.test(options.jour ?? '')
    ? options.jour!
    : dayOf(eventStart != null && !Number.isNaN(Date.parse(eventStart)) ? Date.parse(eventStart) : Date.now())
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const guess = Date.UTC(year, month - 1, date, Number(time[1]), Number(time[2]))
  const shown = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(guess)
      .map((part) => [part.type, part.value]),
  )
  const asIfUtc = Date.UTC(+shown.year!, +shown.month! - 1, +shown.day!, +shown.hour!, +shown.minute!)
  return guess - (asIfUtc - guess)
}
