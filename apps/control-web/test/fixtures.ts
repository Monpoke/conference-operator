import type { DisplayPayload } from '@conference-operator/contract'
import type { VisibleConfig, ObsState } from '@conference-operator/contract'
import type { Session, Speaker } from '@conference-operator/program'
import { NO_EDITING_MARKS } from '@conference-operator/contract'

/**
 * A plausible room, and **typed with no escape hatch**.
 *
 * No `as unknown as DisplayPayload` here, and that is the point. The type is
 * shared from `@conference-operator/contract` precisely so that the machine and the control
 * app cannot diverge; casting it in the fixtures made that sharing decorative — a
 * field added to the payload would have left the whole suite green on a room that
 * cannot exist.
 *
 * The instants are absolute and chosen around 10:00: the tests place the room's
 * time wherever they want rather than derive it from `Date.now()`, which would
 * make half of them depend on when they run.
 */
export const START_MS = Date.parse('2026-10-30T09:00:00.000Z')
export const END_MS = Date.parse('2026-10-30T09:45:00.000Z')

export function speaker(name: string): Speaker {
  return {
    id: name.toLowerCase(),
    name,
    jobTitle: null,
    company: null,
    bio: null,
    photoUrl: null,
    companyLogoUrl: null,
    socials: [],
  }
}

export function talk(overrides: Partial<Session> = {}): Session {
  return {
    id: 'talk-1',
    title: 'Ce que le flux ne dit pas',
    abstract: null,
    startsAt: '2026-10-30T09:00:00.000Z',
    endsAt: '2026-10-30T09:45:00.000Z',
    startsAtMs: START_MS,
    endsAtMs: END_MS,
    durationMinutes: null,
    roomId: 'track-1',
    kind: 'talk',
    sharedFrom: null,
    feedbackId: null,
    speakers: [speaker('Camille Roux')],
    category: null,
    format: null,
    language: null,
    level: null,
    tags: [],
    imageUrl: null,
    ...overrides,
  }
}

/** A plugged-in OBS instance, to be touched up field by field. */
export function obsState(overrides: Partial<ObsState> = {}): ObsState {
  return {
    instance: 'A',
    connected: true,
    currentSceneName: 'Scène 1',
    currentRole: 'LIVE',
    unresolvedRoles: [],
    simulated: false,
    scenes: ['Scène 1'],
    recording: false,
    streaming: false,
    ...overrides,
  }
}

/** A room's configuration, complete. The overrides apply to one field. */
export function config(overrides: Partial<VisibleConfig> = {}): VisibleConfig {
  return {
    obs: {
      A: { url: 'ws://127.0.0.1:4455', hasPassword: false, pending: false },
      B: { url: 'ws://127.0.0.1:4456', hasPassword: false, pending: false },
    },
    sceneRoles: { A: {}, B: {} },
    displayPort: 7788,
    recordingRoot: null,
    fileSlug: null,
    relaySourceRoomId: null,
    openFeedbackProjectId: null,
    promptRecordingOnStart: true,
    promptRecordingOnStop: true,
    // An installed machine can open a picker; the control app opened in a browser
    // cannot. Both are tested by overriding this field.
    canBrowse: true,
    sceneOnStart: 'LIVE',
    ...overrides,
  }
}

export function diagnostics(): NonNullable<DisplayPayload['diagnostics']> {
  return {
    obs: { A: null, B: null },
    questions: [],
    questionsRefreshedAt: null,
    questionsSession: null,
    config: null,
    mode: { room: 'production', hub: 'production' },
    relaySourceRoomId: null,
    rooms: [],
    roomsRefreshedAt: null,
    outboxDepth: 0,
    log: [],
    recording: { active: false, markers: 0, startedAtMs: null, startedAtCorrectedMs: null, editing: NO_EDITING_MARKS },
  }
}

export function state(): DisplayPayload['state'] {
  return {
    mode: 'loop',
    message: null,
    liveMessage: null,
    question: null,
    sceneRole: 'HOLD',
    connectivity: 'ONLINE',
    roomId: 'track-1',
    contentHash: 'abc',
    currentSession: talk(),
    nextSession: null,
    outboxDepth: 0,
    serverTimeOffsetMs: 0,
    recording: false,
    streaming: false,
    comments: [],
    sessionStates: {},
    notifications: [],
    targetSession: talk(),
    breakBadge: null,
    targetIsUpcoming: false,
    simulatedClock: false,
    remoteHolder: null,
  }
}

export function payload(overrides: Partial<DisplayPayload> = {}): DisplayPayload {
  return {
    state: state(),
    roomName: 'Track #1',
    event: null,
    timezone: 'Europe/Paris',
    sessions: [talk()],
    sponsorTiers: [],
    diagnostics: diagnostics(),
    wall: null,
    otherRooms: [],
    socialLinks: [],
    eventIdentity: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
    feedback: null,
    pairing: null,
    ...overrides,
  }
}
