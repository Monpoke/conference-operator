/**
 * Un hub d'événement, tel qu'il répond un 30 octobre à 10 h 12.
 *
 * Ces réponses servaient à figer les aperçus statiques de la console, du temps
 * où elle était un gabarit littéral qu'on pouvait ouvrir en `file://`. Une
 * application Vue ne s'ouvre pas ainsi — ses modules sont refusés depuis le
 * disque — et les aperçus ont donc cédé la place à `pnpm --filter
 * @cloudnord/hub-admin dev`, qui montre la vraie console.
 *
 * Le jeu de données, lui, méritait de survivre : trois salles dans trois états
 * différents, des téléversements aux trois stades, une horloge simulée, un
 * programme complet. Le rassembler prend une heure ; le retrouver après coup,
 * beaucoup plus. Il alimente maintenant les tests de la console.
 */

/** L'identité tranchée par le hub, et celle qu'il déduirait du programme. */
export const EVENEMENT = {
  resolved: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
  derived: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
}

export const SALLES = [
  { id: 'track-1-teilhard-de-chardin', name: 'Track #1 — Teilhard de Chardin' },
  { id: 'track-2-mf-1092', name: 'Track #2 — MF 1092' },
  { id: 'hands-on', name: 'Hands on' },
]

/** Réponses servies à la place du hub, par procédure oRPC. */
export const REPONSES: Record<string, unknown> = {
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
    openFeedbackProjectId: 'cloud-nord-2026',
    rooms: SALLES,
    sessions: [
      { id: 'ses-1', title: 'HoneySwamp : piéger les bots', speakers: ['Steven LE ROUX'], startsAt: '2026-10-30T10:00:00.000Z', endsAt: '2026-10-30T10:50:00.000Z', roomId: SALLES[0]!.id, roomName: SALLES[0]!.name, kind: 'talk', feedbackUrl: 'https://openfeedback.io/cloud-nord-2026/2026-10-30/ses-1', feedbackId: 'ses-1', feedbackIdOverride: null },
      { id: 'ses-2', title: '100 % open source, au-dessus de la mêlée', speakers: ['Camille Durand', 'Sacha Nguyen'], startsAt: '2026-10-30T10:00:00.000Z', endsAt: '2026-10-30T10:50:00.000Z', roomId: SALLES[1]!.id, roomName: SALLES[1]!.name, kind: 'talk', feedbackUrl: 'https://openfeedback.io/cloud-nord-2026/2026-10-30/of-42', feedbackId: 'of-42', feedbackIdOverride: 'of-42' },
      { id: 'pause-midi', title: 'Déjeuner', speakers: [], startsAt: '2026-10-30T11:00:00.000Z', endsAt: '2026-10-30T12:00:00.000Z', roomId: null, roomName: null, kind: 'break', feedbackUrl: null, feedbackId: 'pause-midi', feedbackIdOverride: null },
      { id: 'ses-3', title: 'Event Iterators en production', speakers: ['Alex Martin'], startsAt: '2026-10-30T12:00:00.000Z', endsAt: '2026-10-30T12:50:00.000Z', roomId: SALLES[2]!.id, roomName: SALLES[2]!.name, kind: 'talk', feedbackUrl: 'https://openfeedback.io/cloud-nord-2026/2026-10-30/ses-3', feedbackId: 'ses-3', feedbackIdOverride: null },
    ],
  },
  'event/identity': EVENEMENT,
  'settings/get': {
    autoEndGraceMinutes: 5,
    autoEndEnabled: true,
    programSourceUrl: 'https://exemple.test/programme.json',
    // Rien de réglé : les champs de l'onglet Réglages restent vides, et
    // montrent en placeholder ce que le hub a déduit du programme. C'est l'état
    // normal, et celui qu'il faut donner à relire.
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
   * Les trois états qu'un téléversement peut prendre sous les yeux.
   *
   * Un terminé, un en cours, un en échec avec le code du stockage : c'est cette
   * dernière ligne qu'on relit à l'œil, parce qu'elle est la seule qui demande
   * une décision — et la seule dont le rendu peut se dégrader sans qu'un test
   * le voie.
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
    { roomId: SALLES[0]!.id, roomName: SALLES[0]!.name, file: '2026-10-30_track1_1000_honeyswamp.mkv', kind: 'rush', sessionId: 'ses-1', objectKey: 'cn26/2026-10-30/track-1/2026-10-30_track1_1000_honeyswamp.mkv', state: 'termine', sizeBytes: 2_700_000_000, bytesSent: 2_700_000_000, debitOctetsS: 1_900_000, startedAt: '2026-10-30T10:55:00.000Z', lastProgressAt: '2026-10-30T11:18:00.000Z', finishedAt: '2026-10-30T11:18:00.000Z', attempts: 1, lastError: null },
    { roomId: SALLES[1]!.id, roomName: SALLES[1]!.name, file: '2026-10-30_track2_1000_open-source.mkv', kind: 'rush', sessionId: 'ses-2', objectKey: 'cn26/2026-10-30/track-2/2026-10-30_track2_1000_open-source.mkv', state: 'en-cours', sizeBytes: 3_100_000_000, bytesSent: 1_300_000_000, debitOctetsS: 1_400_000, startedAt: '2026-10-30T11:02:00.000Z', lastProgressAt: '2026-10-30T11:19:00.000Z', finishedAt: null, attempts: 1, lastError: null },
    { roomId: SALLES[2]!.id, roomName: SALLES[2]!.name, file: '2026-10-30_handson_0900_atelier.mkv', kind: 'rush', sessionId: 'ses-3', objectKey: 'cn26/2026-10-30/hands-on/2026-10-30_handson_0900_atelier.mkv', state: 'echoue', sizeBytes: 5_400_000_000, bytesSent: 210_000_000, debitOctetsS: null, startedAt: '2026-10-30T11:05:00.000Z', lastProgressAt: '2026-10-30T11:09:00.000Z', finishedAt: null, attempts: 4, lastError: 'Le stockage a refusé (AccessDenied) : quota dépassé sur le bucket' },
  ],
  /**
   * Le dossier VOD d'une conférence, tel que la modale du planning le montre.
   *
   * Une prise et son objet chez le stockage : c'est le cas nominal, celui qui
   * doit se relire d'un coup d'œil sur l'aperçu.
   */
  'vod/conference': {
    sessionId: 'ses-1',
    roomId: SALLES[0]!.id,
    roomName: SALLES[0]!.name,
    stockageConfigure: true,
    captations: [
      { roomId: SALLES[0]!.id, obs: 'B', startedAt: '2026-10-30T10:02:00.000Z', endedAt: '2026-10-30T10:53:00.000Z', durationMs: 3_060_000, file: '/rushes/2026-10-30_track1_1000_honeyswamp.mkv', sidecarWritten: true, enCours: false, rattachement: 'session' },
    ],
    televersements: [
      { roomId: SALLES[0]!.id, roomName: SALLES[0]!.name, file: '2026-10-30_track1_1000_honeyswamp.mkv', kind: 'rush', sessionId: 'ses-1', objectKey: 'cn26/2026-10-30/track-1/2026-10-30_track1_1000_honeyswamp.mkv', state: 'termine', sizeBytes: 2_700_000_000, bytesSent: 2_700_000_000, debitOctetsS: 1_900_000, startedAt: '2026-10-30T10:55:00.000Z', lastProgressAt: '2026-10-30T11:18:00.000Z', finishedAt: '2026-10-30T11:18:00.000Z', attempts: 1, lastError: null },
    ],
  },
  'questions/list': [
    { id: 'q1', roomId: SALLES[0]!.id, sessionId: 'ses-1', author: 'Camille', text: 'Comment gérez-vous les faux positifs ?', votes: 7, status: 'open', createdAt: '2026-10-30T10:12:00.000Z' },
  ],
}
