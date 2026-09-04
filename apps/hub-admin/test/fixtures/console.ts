/**
 * An event hub, as it answers on 30 October at 10:12.
 *
 * These responses used to freeze the console's static previews, back when it was a
 * literal template that could be opened over `file://`. A Vue application does not
 * open that way — its modules are refused from disk — so the previews gave way to
 * `pnpm --filter @cloudnord/hub-admin dev`, which shows the real console.
 *
 * The data set, on the other hand, deserved to survive: three rooms in three
 * different states, uploads at three stages, a simulated clock, a complete
 * program. Assembling it takes an hour; finding it again afterwards, far longer.
 * It now feeds the console's tests.
 */

/** The identity the hub decided, and the one it would deduce from the program. */
export const EVENT = {
  resolved: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
  derived: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
}

export const ROOMS = [
  { id: 'track-1-teilhard-de-chardin', name: 'Track #1 — Teilhard de Chardin' },
  { id: 'track-2-mf-1092', name: 'Track #2 — MF 1092' },
  { id: 'hands-on', name: 'Hands on' },
]

/** Responses served in the hub's place, by oRPC procedure. */
export const RESPONSES: Record<string, unknown> = {
  'rooms/list': ROOMS,
  'rooms/statuses': [
    {
      roomId: ROOMS[0]!.id, name: ROOMS[0]!.name, connectivity: 'ONLINE',
      sceneRole: 'LIVE', recording: true, streaming: false, outboxDepth: 0,
      lastSeenAt: '2026-10-30T10:12:00.000Z', programContentHash: 'a1b2c3d4e5',
      currentSession: { id: 'ses-1', title: 'HoneySwamp: Active Defense to Ruin Attackers', endsAt: '2026-10-30T10:50:00.000Z' },
    },
    {
      roomId: ROOMS[1]!.id, name: ROOMS[1]!.name, connectivity: 'DEGRADED',
      sceneRole: 'HOLD', recording: false, streaming: false, outboxDepth: 3,
      lastSeenAt: '2026-10-30T10:09:30.000Z', programContentHash: 'a1b2c3d4e5',
      currentSession: { id: 'ses-2', title: '100 % open source, au-dessus de la mêlée', endsAt: '2026-10-30T10:50:00.000Z' },
    },
    {
      roomId: ROOMS[2]!.id, name: ROOMS[2]!.name, connectivity: 'OFFLINE',
      sceneRole: null, recording: false, streaming: false, outboxDepth: 12,
      lastSeenAt: '2026-10-30T09:41:00.000Z', programContentHash: '9f8e7d6c5b',
      currentSession: null,
    },
  ],
  'devices/pending': [
    { userCode: 'FH9BAXGZ', clientId: '01JBQ...9K2', requestedRoomId: ROOMS[2]!.id, requestedAt: '2026-10-30T08:55:00.000Z' },
  ],
  'devices/list': [
    { id: 'dev-1', label: 'Régie Track #1', roomId: ROOMS[0]!.id, lastSeenAt: '2026-10-30T10:12:00.000Z' },
    { id: 'dev-2', label: 'Régie Track #2', roomId: ROOMS[1]!.id, lastSeenAt: '2026-10-30T10:09:30.000Z' },
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
    { id: 'm-1', roomId: ROOMS[1]!.id, roomName: ROOMS[1]!.name, text: 'Micro cravate HS, on passe sur le micro main', level: 'warning', at: '2026-10-30T10:03:00.000Z' },
    { id: 'm-2', roomId: ROOMS[0]!.id, roomName: ROOMS[0]!.name, text: 'Speaker arrivé, tout est prêt', level: 'info', at: '2026-10-30T09:58:00.000Z' },
  ],
  'sessions/states': [
    // `remainingMs` comes from the hub: it is the hub that holds the authoritative
    // time, and it may be simulated. The fixture must therefore supply it, otherwise
    // the "Reste" column stays empty with nobody knowing why.
    { sessionId: 'ses-1', roomId: ROOMS[0]!.id, roomName: ROOMS[0]!.name, title: 'HoneySwamp : piéger les bots', status: 'running', scheduledStartsAt: '2026-10-30T10:00:00.000Z', scheduledEndsAt: '2026-10-30T10:50:00.000Z', remainingMs: 23 * 60_000, decidedBy: 'operator' },
    { sessionId: 'ses-2', roomId: ROOMS[1]!.id, roomName: ROOMS[1]!.name, title: 'Observabilité sous pression', status: 'ended', scheduledStartsAt: '2026-10-30T09:00:00.000Z', scheduledEndsAt: '2026-10-30T09:50:00.000Z', remainingMs: -4 * 60_000, decidedBy: 'auto' },
  ],
  /**
   * The active program's schedule.
   *
   * A break appears in it: that is the case showing a row with no speaker offers no
   * OpenFeedback link — one does not rate a lunch.
   */
  'program/planning': {
    contentHash: 'a1b2c3d4e5f6',
    timezone: 'Europe/Paris',
    // 10:12 UTC: the first slot is running, and it is the one the fixture must
    // show highlighted.
    serverTime: '2026-10-30T10:12:00.000Z',
    openFeedbackProjectId: 'cloud-nord-2026',
    rooms: ROOMS,
    sessions: [
      { id: 'ses-1', title: 'HoneySwamp : piéger les bots', speakers: ['Steven LE ROUX'], startsAt: '2026-10-30T10:00:00.000Z', endsAt: '2026-10-30T10:50:00.000Z', roomId: ROOMS[0]!.id, roomName: ROOMS[0]!.name, kind: 'talk', feedbackUrl: 'https://openfeedback.io/cloud-nord-2026/2026-10-30/ses-1', feedbackId: 'ses-1', feedbackIdOverride: null },
      { id: 'ses-2', title: '100 % open source, au-dessus de la mêlée', speakers: ['Camille Durand', 'Sacha Nguyen'], startsAt: '2026-10-30T10:00:00.000Z', endsAt: '2026-10-30T10:50:00.000Z', roomId: ROOMS[1]!.id, roomName: ROOMS[1]!.name, kind: 'talk', feedbackUrl: 'https://openfeedback.io/cloud-nord-2026/2026-10-30/of-42', feedbackId: 'of-42', feedbackIdOverride: 'of-42' },
      { id: 'pause-midi', title: 'Déjeuner', speakers: [], startsAt: '2026-10-30T11:00:00.000Z', endsAt: '2026-10-30T12:00:00.000Z', roomId: null, roomName: null, kind: 'break', feedbackUrl: null, feedbackId: 'pause-midi', feedbackIdOverride: null },
      { id: 'ses-3', title: 'Event Iterators en production', speakers: ['Alex Martin'], startsAt: '2026-10-30T12:00:00.000Z', endsAt: '2026-10-30T12:50:00.000Z', roomId: ROOMS[2]!.id, roomName: ROOMS[2]!.name, kind: 'talk', feedbackUrl: 'https://openfeedback.io/cloud-nord-2026/2026-10-30/ses-3', feedbackId: 'ses-3', feedbackIdOverride: null },
    ],
  },
  'event/identity': EVENT,
  'settings/get': {
    autoEndGraceMinutes: 5,
    autoEndEnabled: true,
    programSourceUrl: 'https://exemple.test/programme.json',
    // Nothing set: the Réglages tab's fields stay empty, and show as placeholders
    // what the hub deduced from the program. That is the normal state, and the one
    // worth giving to read.
    eventName: null,
    eventShortName: null,
    openFeedbackProjectId: 'cloud-nord-2026',
    vodBucket: 'rushes-cloudnord',
    vodPrefix: 'cn26',
    vodPolitique: {
      actif: true,
      debitMaxOctetsS: 2_000_000,
      cpuMax: 0.7,
      margeConferenceMinutes: 10,
      taillePartMo: 8,
    },
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
    { seq: 9, roomId: ROOMS[0]!.id, message: { text: 'Problème de son en cours de résolution', level: 'warning' }, issuedAt: '2026-10-30T09:41:00.000Z', visible: false },
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
  'vod/status': {
    configure: true,
    endpoint: 'https://s3.gra.io.cloud.ovh.net',
    bucket: 'rushes-cloudnord',
    prefix: 'cn26',
    politique: {
      actif: true,
      debitMaxOctetsS: 2_000_000,
      cpuMax: 0.7,
      margeConferenceMinutes: 10,
      taillePartMo: 8,
    },
  },
  /**
   * The three states an upload can take before one's eyes.
   *
   * One finished, one running, one failed with the storage's code: it is that last
   * row one reads by eye, because it is the only one that calls for a decision — and
   * the only one whose rendering can degrade without a test seeing it.
   */
  'vod/check': {
    ok: true,
    etapes: [
      { nom: 'joindre', ok: true, detail: null },
      { nom: 'authentifier', ok: true, detail: null },
      { nom: 'signer', ok: true, detail: null },
      { nom: 'nettoyer', ok: true, detail: null },
    ],
  },
  'vod/uploads': [
    { roomId: ROOMS[0]!.id, roomName: ROOMS[0]!.name, file: '2026-10-30_track1_1000_honeyswamp.mkv', kind: 'rush', sessionId: 'ses-1', objectKey: 'cn26/2026-10-30/track-1/2026-10-30_track1_1000_honeyswamp.mkv', state: 'termine', sizeBytes: 2_700_000_000, bytesSent: 2_700_000_000, debitOctetsS: 1_900_000, startedAt: '2026-10-30T10:55:00.000Z', lastProgressAt: '2026-10-30T11:18:00.000Z', finishedAt: '2026-10-30T11:18:00.000Z', attempts: 1, lastError: null },
    { roomId: ROOMS[1]!.id, roomName: ROOMS[1]!.name, file: '2026-10-30_track2_1000_open-source.mkv', kind: 'rush', sessionId: 'ses-2', objectKey: 'cn26/2026-10-30/track-2/2026-10-30_track2_1000_open-source.mkv', state: 'en-cours', sizeBytes: 3_100_000_000, bytesSent: 1_300_000_000, debitOctetsS: 1_400_000, startedAt: '2026-10-30T11:02:00.000Z', lastProgressAt: '2026-10-30T11:19:00.000Z', finishedAt: null, attempts: 1, lastError: null },
    { roomId: ROOMS[2]!.id, roomName: ROOMS[2]!.name, file: '2026-10-30_handson_0900_atelier.mkv', kind: 'rush', sessionId: 'ses-3', objectKey: 'cn26/2026-10-30/hands-on/2026-10-30_handson_0900_atelier.mkv', state: 'echoue', sizeBytes: 5_400_000_000, bytesSent: 210_000_000, debitOctetsS: null, startedAt: '2026-10-30T11:05:00.000Z', lastProgressAt: '2026-10-30T11:09:00.000Z', finishedAt: null, attempts: 4, lastError: 'Le stockage a refusé (AccessDenied) : quota dépassé sur le bucket' },
  ],
  /**
   * A talk's VOD folder, as the schedule's modal shows it.
   *
   * One take and its object at the storage: the nominal case, the one that must be
   * readable at a glance.
   */
  'vod/conference': {
    sessionId: 'ses-1',
    roomId: ROOMS[0]!.id,
    roomName: ROOMS[0]!.name,
    stockageConfigure: true,
    captations: [
      { roomId: ROOMS[0]!.id, obs: 'B', startedAt: '2026-10-30T10:02:00.000Z', endedAt: '2026-10-30T10:53:00.000Z', durationMs: 3_060_000, file: '/rushes/2026-10-30_track1_1000_honeyswamp.mkv', sidecarWritten: true, enCours: false, rattachement: 'session' },
    ],
    televersements: [
      { roomId: ROOMS[0]!.id, roomName: ROOMS[0]!.name, file: '2026-10-30_track1_1000_honeyswamp.mkv', kind: 'rush', sessionId: 'ses-1', objectKey: 'cn26/2026-10-30/track-1/2026-10-30_track1_1000_honeyswamp.mkv', state: 'termine', sizeBytes: 2_700_000_000, bytesSent: 2_700_000_000, debitOctetsS: 1_900_000, startedAt: '2026-10-30T10:55:00.000Z', lastProgressAt: '2026-10-30T11:18:00.000Z', finishedAt: '2026-10-30T11:18:00.000Z', attempts: 1, lastError: null },
    ],
  },
  'questions/list': [
    { id: 'q1', roomId: ROOMS[0]!.id, sessionId: 'ses-1', author: 'Camille', text: 'Comment gérez-vous les faux positifs ?', votes: 7, status: 'open', createdAt: '2026-10-30T10:12:00.000Z' },
  ],
}
