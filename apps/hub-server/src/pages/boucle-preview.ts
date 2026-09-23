import { toString as qrSvg } from 'qrcode'
import type { DisplayPayload } from '@conference-operator/contract'
import { agendaForRoom, DEFAULT_TIMEZONE, sessionsForRoom } from '@conference-operator/program'
import { timelinePosition } from '@conference-operator/program/selectors'
import { breakOfSlots } from '@conference-operator/room-state'
import {
  availableFonts,
  boucleQrUrls,
  buildBoucleView,
  otherRoomsFor,
  renderProjectorDocument,
} from '@conference-operator/projector/server'
import type { Services } from '../context.js'

export interface BouclePreviewOptions {
  /** The room to preview; `null` = the program's first. */
  roomId: string | null
  /** A scene of the loop to hold (1 = the welcome); `null` = the loop plays. */
  scene: number | null
  /** Where the typefaces are, and the address they are served from. */
  fonts: { folder: string | null; base: string }
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
  const settings = services.settings.get()
  const snapshot = services.programs.active()
  const program = snapshot?.program ?? null
  const now = services.clock.now()
  const identity = services.identity.get()
  const roomId = program == null
    ? null
    : (program.rooms.find((room) => room.id === options.roomId) ?? program.rooms[0])?.id ?? null
  const room = program?.rooms.find((candidate) => candidate.id === roomId) ?? null

  const qrCodes = new Map<string, string>()
  for (const url of boucleQrUrls(settings.boucle, settings.openFeedbackProjectId)) {
    qrCodes.set(url, await qrSvg(url, QR_OPTIONS))
  }
  const boucle = buildBoucleView({
    boucle: settings.boucle,
    program,
    openFeedbackProjectId: settings.openFeedbackProjectId,
    wallsIoUrl: settings.wallsIoUrl,
    eventShortName: identity.shortName,
    localize: (ref) => (ref == null ? null : (services.assets.previewUrl(ref) ?? (/^https?:\/\//.test(ref) ? ref : null))),
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
    wallsIoUrl: settings.wallsIoUrl,
    screensDisabled: settings.screensDisabled,
    eventIdentity: identity,
    boucle,
    agenda: program == null || roomId == null
      ? []
      : agendaForRoom(program, roomId, { plenaries: settings.boucle.agenda.plenieres, nowMs: now }),
    wallsIoReachable: true,
  } as unknown as DisplayPayload

  return renderProjectorDocument({
    initialPayload: payload,
    preview: true,
    fonts: { base: options.fonts.base, files: availableFonts(options.fonts.folder) },
    // Held on one scene: no transition, the loop paused there.
    after: options.scene == null
      ? undefined
      : `boucle.pause(); boucle.allerA(${Math.max(1, Math.trunc(options.scene))}, 'cut')`,
  })
}
