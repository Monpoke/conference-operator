import type { DisplayPayload } from '@cloudnord/contract'

/**
 * Une salle plausible, réduite à ce que la moitié « lecture » consulte.
 *
 * Les instants sont absolus et choisis autour de 10:00 : les tests placent
 * l'heure de la salle où ils veulent plutôt que de la dériver de `Date.now()`,
 * ce qui rendrait la moitié d'entre eux dépendants du moment où ils tournent.
 */
export const DEBUT_MS = Date.parse('2026-10-30T09:00:00.000Z')
export const FIN_MS = Date.parse('2026-10-30T09:45:00.000Z')

export function talk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'talk-1',
    kind: 'talk',
    title: 'Ce que le flux ne dit pas',
    startsAt: '2026-10-30T09:00:00.000Z',
    startsAtMs: DEBUT_MS,
    endsAtMs: FIN_MS,
    speakers: ['Camille Roux'],
    ...overrides,
  }
}

export function payload(overrides: Partial<DisplayPayload> = {}): DisplayPayload {
  const base = {
    state: {
      mode: 'loop',
      connectivity: 'ONLINE',
      roomId: 'track-1',
      outboxDepth: 0,
      serverTimeOffsetMs: 0,
      simulatedClock: false,
      recording: false,
      streaming: false,
      sessionStates: {},
      targetSession: talk(),
      targetIsUpcoming: false,
      notifications: [],
      comments: [],
      breakBadge: null,
      message: null,
      liveMessage: null,
      question: null,
      sceneRole: 'HOLD',
      contentHash: 'abc',
      currentSession: talk(),
      nextSession: null,
    },
    roomName: 'Track #1',
    event: null,
    timezone: 'Europe/Paris',
    sessions: [talk()],
    sponsorTiers: [],
    diagnostics: {
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
      recording: { active: false, markers: 0, startedAtMs: null, startedAtCorrigeMs: null },
    },
    wall: null,
    otherRooms: [],
    socialLinks: [],
    eventIdentity: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
    feedback: null,
    pairing: null,
  }
  return { ...base, ...overrides } as unknown as DisplayPayload
}
