import type { DisplayPayload } from '@cloudnord/contract'
import type { ConfigVisible, ObsState } from '@cloudnord/contract'
import type { Session, Speaker } from '@cloudnord/program'
import { SANS_REPERES } from '@cloudnord/contract'

/**
 * Une salle plausible, et **typée sans échappatoire**.
 *
 * Aucun `as unknown as DisplayPayload` ici, et c'est le point. Le type est
 * partagé depuis `@cloudnord/contract` précisément pour que le poste et la
 * régie ne puissent pas diverger ; le caster dans les fixtures rendait ce
 * partage décoratif — un champ ajouté à la charge utile aurait laissé toute la
 * suite au vert sur une salle qui ne peut pas exister.
 *
 * Les instants sont absolus et choisis autour de 10:00 : les tests placent
 * l'heure de la salle où ils veulent plutôt que de la dériver de `Date.now()`,
 * ce qui rendrait la moitié d'entre eux dépendants du moment où ils tournent.
 */
export const DEBUT_MS = Date.parse('2026-10-30T09:00:00.000Z')
export const FIN_MS = Date.parse('2026-10-30T09:45:00.000Z')

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
    startsAtMs: DEBUT_MS,
    endsAtMs: FIN_MS,
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

/** Une instance OBS branchée, à retoucher champ par champ. */
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

/** La configuration d'une salle, complète. Les surcharges portent sur un champ. */
export function config(overrides: Partial<ConfigVisible> = {}): ConfigVisible {
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
    // Le poste installé sait ouvrir un sélecteur ; la régie ouverte dans un
    // navigateur, non. Les deux se testent en surchargeant ce champ.
    peutParcourir: true,
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
    mode: { salle: 'production', hub: 'production' },
    relaySourceRoomId: null,
    rooms: [],
    roomsRefreshedAt: null,
    outboxDepth: 0,
    journal: [],
    recording: { active: false, markers: 0, startedAtMs: null, startedAtCorrigeMs: null, montage: SANS_REPERES },
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
