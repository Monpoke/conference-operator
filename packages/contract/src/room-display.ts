import type { Program, Session, SponsorTier } from '@cloudnord/program'
import type { EventIdentity } from './event-identity.js'
import type {
  Connectivity,
  DisplayMode,
  ExecutionMode,
  ObsInstance,
  SceneRole,
} from './primitives.js'
import type { SceneRoleMap, SessionStatus } from './room-state.js'
import type { Comment } from './wall.js'

/**
 * What a room says about itself, and what its pages read from it.
 *
 * These types used to live in the room client, next to the process that produces
 * them. They moved out because they now have **two** readers: the process itself,
 * and the control app, which became a separate package with its own compilation.
 * A type copied between the two would drift — that has already happened once,
 * between the control app and the console, on the thresholds of the same state.
 *
 * Nothing is added or renamed on the way: the definitions are those of
 * `runtime.ts`, `obs.ts`, `control-api.ts` and `display-server.ts`, moved as is.
 * Those four files re-export them, so that no caller has to change an import.
 *
 * They are interfaces and not Zod schemas, deliberately: nothing validates them
 * on the way. They describe a **local** flow — the room process towards the pages
 * it serves itself on its own loopback — not a network boundary crossed by
 * someone else.
 */

export interface BroadcastMessage {
  text: string
  level: 'info' | 'warning' | 'urgent'
  /** Absolute expiry: a command caught up late does not reappear. */
  expiresAtMs: number | null
}

/**
 * An audience question put on air from the control app.
 *
 * **A distinct channel from `liveMessage`, and that is the whole purpose of the
 * type.** The two long shared a single field: a "back in 5 minutes" sent from the
 * hub then showed up in place of the question on the room screen, and above all
 * no surface could show one without risking the other. Yet they do not go to the
 * same place — the question belongs in the VOD, the operations message does not.
 */
export interface AiredQuestion {
  text: string
  author: string | null
  /**
   * The talk it attaches to.
   *
   * Used to make it fall away by itself at the next talk: a question left on air
   * across a change of talk would be burnt into the wrong speaker's VOD.
   */
  sessionId: string | null
}

/** What the display page must render at a given instant. */
export interface DisplayState {
  mode: DisplayMode
  message: BroadcastMessage | null
  /**
   * Banner overlaid on the live scenes.
   *
   * Distinct from `message`: that one **replaces** the room screen, the banner
   * sits on top of the video without interrupting anything. So the two coexist,
   * and that is deliberate.
   *
   * Distinct from `question` too: this banner comes from the console and must
   * never reach the capture overlay — it does not talk to the VOD audience, it
   * talks to the room right now.
   */
  liveMessage: BroadcastMessage | null
  /** Audience question on air. Goes into the VOD, unlike the banner. */
  question: AiredQuestion | null
  sceneRole: SceneRole | null
  connectivity: Connectivity
  roomId: string | null
  contentHash: string | null
  currentSession: Session | null
  nextSession: Session | null
  outboxDepth: number
  serverTimeOffsetMs: number
  /**
   * OBS-B's real state, observed and not assumed.
   *
   * Used for the control app's indicator, never for the overlay: what is in the
   * overlay goes into the master, and a red dot burnt into the VOD has no
   * business there.
   */
  recording: boolean
  streaming: boolean
  /**
   * Latest approved messages. Bounded: a wall that scrolls endlessly becomes
   * unreadable from ten metres, and the client's memory does not have to keep
   * everything.
   */
  comments: Comment[]
  /**
   * Talk states, by identifier. Absent = "upcoming".
   * Only what happened is stored, here as on the hub.
   */
  sessionStates: Record<string, SessionStatus>
  /** Recent facts worth reporting in the control app. Bounded and perishable. */
  notifications: Notification[]
  /**
   * The talk the control commands act on.
   *
   * Rarely the same as `currentSession`: between two talks, during a break, or a
   * few minutes before the start, `currentSession` is empty or points at a slot
   * with no speaker. Yet those are exactly the moments when the operator wants to
   * press "Start" — the speaker is settling in.
   */
  targetSession: Session | null
  /**
   * The room's break, running or imminent — or `null`.
   *
   * Separate from the current session: the two coexist, and "BREAK coming up"
   * shows while a talk is still running.
   */
  breakBadge: { state: 'en-cours' | 'a-venir'; title: string; startsAt: string } | null
  /** The target has not started in the program yet: the screen must say so. */
  targetIsUpcoming: boolean
  /**
   * The time comes from a hub with a simulated clock.
   *
   * Shown in the control app: seeing 11:00 on an August morning with no
   * explanation would cast doubt on the rest of the screen.
   */
  simulatedClock: boolean
  /**
   * Who holds this room's mobile control app, or `null` if nobody.
   *
   * It **greys out nothing**. The room's control app keeps all its commands: the
   * person who is physically there must never depend on a phone that has wandered
   * off down a corridor, nor on a lock somebody forgot to release.
   *
   * It exists so the screen can say it. Without it, a scene switching and a
   * recording starting without anyone touching the keyboard read as a failure —
   * and you would worry about it in the middle of a talk.
   */
  remoteHolder: string | null
}

/**
 * A notice shown at the top of the control app.
 *
 * Mostly useful for the other rooms: knowing a talk has just ended next door lets
 * you anticipate a handover or a switch, without having to watch the rooms panel
 * all the time.
 */
export interface Notification {
  id: string
  level: 'info' | 'warning'
  text: string
  at: string
}

export interface ObsState {
  instance: ObsInstance
  connected: boolean
  /** Current scene as announced by OBS, never assumed by us. */
  currentSceneName: string | null
  currentRole: SceneRole | null
  /** Roles configured but missing from OBS: to be shown red in the control app. */
  unresolvedRoles: SceneRole[]
  /**
   * The instance is simulated.
   *
   * To be flagged everywhere we believe we are driving OBS: a simulated recording
   * looks exactly like a real one, except it captures nothing.
   */
  simulated: boolean
  /**
   * Scenes actually declared in this instance.
   *
   * Used by the control app's configuration form: picking a scene name from a
   * list read off OBS beats typing it again, since a typo is precisely what
   * produces an unresolvable role.
   */
  scenes: string[]
  recording: boolean
  streaming: boolean
}

/**
 * The room's configuration as the control app sees it.
 *
 * OBS passwords are not part of it: only the fact that there is one. The form
 * does not need to read them back to keep them — a field left empty means
 * "unchanged" — and a page served over HTTP is not the place to bring an already
 * saved secret back into view.
 */
export interface VisibleConfig {
  obs: { A: VisibleObsEndpoint; B: VisibleObsEndpoint }
  sceneRoles: SceneRoleMap
  displayPort: number
  recordingRoot: string | null
  fileSlug: string | null
  relaySourceRoomId: string | null
  /** OpenFeedback project, for the "rate this talk" QR code. */
  openFeedbackProjectId: string | null
  /** Warn on "Start" if nothing is recording. */
  promptRecordingOnStart: boolean
  /** Offer on "End" to stop the capture that is still running. */
  promptRecordingOnStop: boolean
  /** Scene taken automatically on "Start". `null` = no switch. */
  sceneOnStart: string | null
  /**
   * The machine can open a native folder picker.
   *
   * True under Electron, false everywhere else — `dev:headless`, or the control
   * app opened from a browser. It is the machine that answers, not the page: it
   * cannot guess what it is running under, and a button that fails one time in
   * two is worth less than a field filled in by hand.
   *
   * The folder browsed is the one on **the room machine**, wherever this page is
   * read: that is where the rushes are written, and this field has never
   * designated anything else.
   */
  canBrowse: boolean
}

export interface VisibleObsEndpoint {
  url: string
  hasPassword: boolean
  /**
   * The current connection was not opened with these settings.
   *
   * Saving does not reconnect: it is up to the operator to choose when to cut an
   * instance. But they still have to see that it remains to be done.
   */
  pending: boolean
}

export interface ControlDiagnostics {
  obs: { A: ObsState | null; B: ObsState | null }
  /**
   * Questions asked in this room, most voted first.
   *
   * Read on demand rather than pushed: the control app only looks at them at the
   * end of a talk, and streaming them continuously would load the state flow for
   * nothing.
   */
  questions: { id: string; text: string; author: string | null; votes: number }[]
  /** Instant of the last read, so we can present a dated list. */
  questionsRefreshedAt: string | null
  /**
   * The talk the listed questions relate to.
   *
   * Shown in the control app: an empty list does not say the same thing depending
   * on whether no question was asked on this talk, or no talk is being driven.
   * `null` in the second case.
   */
  questionsSession: { id: string; title: string } | null
  /** The room's settings, for the configuration panel. `null` before the first sync. */
  config: VisibleConfig | null
  /**
   * Execution modes, the room's and the hub's.
   *
   * `hub` stays `null` as long as no synchronization has succeeded. Both are shown
   * together because it is their **disagreement** that matters: a development room
   * plugged into the event hub would send real commands from a machine that
   * simulates everything.
   */
  mode: { room: ExecutionMode; hub: ExecutionMode | null }
  /** Relayed room, `null` if relaying is not configured for this room. */
  relaySourceRoomId: string | null
  /**
   * State of the other rooms, as the hub knows it.
   *
   * Refreshed periodically and **cached**: the operator must be able to glance at
   * the other rooms without every screen render triggering a network call.
   */
  rooms: {
    roomId: string
    name: string
    connectivity: string
    sceneRole: string | null
    recording: boolean
    outboxDepth: number
    lastSeenAt: string | null
    /**
     * The talk the room is really driving, `null` if it is driving none.
     *
     * Distinct from what the program says: it is the only way to know a room is
     * **overrunning** — its slot is over, it is still running. The program alone
     * will never say so, it simply moves on to the next one.
     */
    currentSessionId: string | null
    /**
     * Where the room stands, computed by the hub.
     *
     * It alone crosses the program, its clock — which can be simulated — and the
     * talk lifecycle of the other rooms. The control app uses it as long as this
     * view is fresh, and falls back on its own cache as soon as it is stale:
     * during an outage, the room next door still finishes on schedule.
     */
    conference: string
  }[]
  /** Instant of the last rooms refresh, to flag a stale view. */
  roomsRefreshedAt: string | null
  outboxDepth: number
  log: { level: string; message: string; createdAt: string }[]
  /** Recording in progress on the client side, and what was marked during it. */
  recording: {
    active: boolean
    /** Chapter markers. The two editing marks have their own field. */
    markers: number
    startedAtMs: number | null
    /**
     * Start on the corrected clock, or `null` if real time is authoritative.
     *
     * Carries the value **and** the rule: the control app counts on the hub's
     * clock when this field is set — the development case, where a day is played
     * out by pushing the clock — and on real time otherwise.
     */
    startedAtCorrectedMs: number | null
    /**
     * Where the two editing marks fall, `null` while they are missing.
     *
     * The marker count was not enough to answer the one question you ask yourself
     * in the control room before stopping a take: "did I set the start?". Three
     * markers can be three chapters. And a mark gets reset — the value then says
     * where it has just landed, which a boolean would not.
     */
    editing: EditingMarks
  }
}

export interface DisplayPayload {
  state: DisplayState
  /** Readable room name. `state.roomId` is a technical identifier. */
  roomName: string | null
  event: Program['event'] | null
  timezone: string
  sessions: Session[]
  sponsorTiers: SponsorTier[]
  /** Only present for the control app; the projected screen does not need it. */
  diagnostics: ControlDiagnostics | null
  /** Public wall address and its QR code (inline SVG), for the room screen. */
  wall: { url: string; qrSvg: string } | null
  /**
   * What is happening in the **other** rooms.
   *
   * Computed here, from the already cached program: the hub has nothing to say
   * about it that the room does not already know, and the waiting loop must run
   * through in full without a network. Used by the "meanwhile, next door" page —
   * the one thing an attendee in a room cannot guess.
   */
  otherRooms: {
    roomId: string
    name: string
    /** Next talk to start, or the running one if it is on. */
    session: { id: string; title: string; startsAt: string; speakers: string[] } | null
    /** True if it has already started: "right now" rather than "at HH:MM". */
    running: boolean
  }[]
  /** The event's accounts, set on the hub. Empty = the loop skips this page. */
  socialLinks: { network: string; handle: string; url: string }[]
  /**
   * Event name, decided by the hub and read back from the local cache.
   *
   * Distinct from the program's `event.name`: the hub can contradict it by
   * setting, and above all it is known **without** a program — a machine that has
   * just been paired must already title its windows correctly.
   */
  eventIdentity: { name: string; shortName: string }
  /**
   * OpenFeedback QR code for the running talk.
   *
   * Built offline: OpenFeedback reuses the session identifiers of the upstream
   * export, so the address is derived from the already cached program. `null` when
   * no talk is running, or with no project configured.
   */
  feedback: { url: string; qrSvg: string } | null
  /** The machine's pairing: the control app uses it to show the code. */
  pairing: {
    status: string
    userCode?: string
    verificationUri?: string
    message?: string
    rooms?: { id: string; name: string }[]
    requestedRoomId?: string | null
  } | null
}

/**
 * Lifetime of a notice.
 *
 * A banner that does not go away stops being read: the control app used to end
 * the day with five notices stacked above the commands, all long expired. Thirty
 * seconds is enough to catch a one-off fact — and what must stay consultable, the
 * state of the other rooms, is in the header flow anyway, which does not expire.
 */
export const NOTIFICATION_TTL_MS = 30_000

/**
 * Level of an audio input, in dBFS.
 *
 * OBS sends linear multipliers; we convert here because that is the scale a sound
 * engineer thinks on, and the one OBS itself displays. `-60` acts as the floor:
 * below that it is silence, and an `-Infinity` would break any bar-width
 * computation on the page side.
 */
export interface InputLevel {
  name: string
  /** One element per channel: mono has one, stereo two. */
  channels: { magnitude: number; peak: number }[]
}

/** Display floor, in dBFS. */
export const DB_FLOOR = -60

/**
 * Load of the control machine, read outside the state flow.
 *
 * Served separately on `/control/host`: the measurement is an average over its own
 * window, and a room whose control app is closed must emit no traffic.
 */
export interface HostLoad {
  /**
   * Share of the CPU used over the observed window, between 0 and 1.
   *
   * `null` while no window could be measured — at startup, or on a machine whose
   * counters Node cannot read. It is an admission, not a zero: showing "0%" for a
   * CPU we failed to read would do exactly the opposite of what we are after.
   */
  cpu: number | null
  cores: number
  /** Duration actually covered by the measurement, in ms — the tooltip quotes it. */
  windowMs: number
  /**
   * RAM used and total, in bytes. `null` if unreadable.
   *
   * The other way a machine gives way, and the sneakiest: the machine does not
   * slow down outright, it starts swapping to disk — the very disk writing the
   * rush.
   */
  memory: { usedBytes: number; totalBytes: number } | null
}

/** The pages served, each with different needs. */
export type DisplayView = 'projecteur' | 'overlay' | 'bandeau' | 'regie'

/**
 * What each view actually receives.
 *
 * The overlay only reads two fields out of nine: pushing it the room's whole
 * program, the sponsors and the wall QR code on every state change costs some
 * thirty kilobytes for nothing. The `vues-du-flux` test checks that these lists
 * really cover what each page consults — a field added to a page without being
 * added here would produce a silent render, not an error.
 */
export const FIELDS_BY_VIEW: Record<DisplayView, readonly (keyof DisplayPayload)[]> = {
  projecteur: [
    'state', 'roomName', 'event', 'timezone', 'sessions', 'sponsorTiers', 'wall', 'feedback',
    // Two fields for the waiting loop alone: they only move at a slot change and
    // at sync, so they cost the flow nothing.
    'otherRooms', 'socialLinks',
    // The event name: two words that only move at sync, and without which every
    // page would retitle itself with a compiled-in constant.
    'eventIdentity',
  ],
  overlay: ['state', 'event', 'eventIdentity'],
  // The banner only reads `state.liveMessage`: pushing it the program and the
  // sponsors would cost thirty kilobytes per screen change.
  bandeau: ['state', 'eventIdentity'],
  regie: [
    'state', 'roomName', 'timezone', 'sessions', 'diagnostics', 'pairing', 'eventIdentity',
    // The wall address, for the screens menu. The QR code travels with it, which
    // is waste — but it only changes at sync, and splitting the field in two would
    // cost more to read than it saves.
    'wall',
  ],
}

/*
 * The rushes as the control app sees them.
 *
 * Same reason as the rest of this file: these types describe what the machine
 * answers on `/control/recordings` and `/control/uploads`, and they now have two
 * readers — the machine that produces them, and the control app bundle that reads
 * them. Moved as is; the original files re-export them.
 */

/**
 * The two marks editing looks for, and cannot guess.
 *
 * An ordinary marker says "something happens here"; these two say where what we
 * publish starts and ends. The difference is not cosmetic: without them, trimming
 * the blank at the start and end is done by silence detection, on a room
 * microphone that never really goes down to zero — and cutting the first three
 * words of a talk is a defect that can only be repaired by re-editing the file by
 * hand.
 *
 * A field rather than an agreed label: editing reads `role`, and so does not have
 * to recognise "Début", "debut", "DÉBUT", nor the day somebody types "Départ".
 *
 * Unaccented, like `illisible`, `abandonne` and `termine`: these are keys read by
 * a machine, not labels — what the operator reads is written in the control app.
 * They are written into the sidecars on disk, so they do not change.
 */
export type MarkerRole = 'debut' | 'fin'

/** Where a take's two marks fall. `null`: that one was not set. */
export interface EditingMarks {
  startMs: number | null
  endMs: number | null
}

/**
 * No mark set.
 *
 * Named rather than repeated, like `DEFAULT_VOD_POLICY`: it is at once what a take
 * where nobody has set anything returns, and what a remotely held control app
 * shows — the hub only stores a recording boolean, it knows nothing of the marks.
 * The two must keep saying the same thing.
 */
export const NO_EDITING_MARKS: EditingMarks = { startMs: null, endMs: null }

export interface Marker {
  label: string
  /** Offset from the start of the recording — what editing works from. */
  offsetMs: number
  at: string
  /**
   * Editing role, absent on an ordinary chapter marker.
   *
   * Optional, and it will stay so: the sidecars written before the field was
   * introduced do not carry it, and those are already on the rooms' disks and in
   * the storage. Editing that finds no mark falls back on detection — that is the
   * behaviour from before, and it remains the safety net.
   */
  role?: MarkerRole
}

/** Metadata written next to the master, for editing and upload. */
export interface Sidecar {
  sessionId: string | null
  title: string
  speakers: { name: string; company: string | null }[]
  roomId: string | null
  trackTitle: string | null
  category: string | null
  startedAt: string
  endedAt: string
  durationMs: number
  markers: Marker[]
  /** Final name of the video file, once renamed. */
  videoFile: string | null
}


/**
 * What the control app can say about a file produced during the day.
 *
 * `illisible` is a technical finding — the container does not open, the video
 * track is missing, the file is empty; `suspect` means "look at it yourself": it
 * opens, but something does not match what the control app thought it was
 * recording. Both deserve to be seen before dismantling the room, not the day
 * before editing.
 *
 * The values are written into the verdicts file on the room's disk, so they stay
 * as they are.
 */
export type VodVerdict = 'ok' | 'suspect' | 'illisible'

/**
 * What ffprobe read from the file. Absent when the tool is not installed.
 *
 * Field names are those written into the verdicts file: they do not change.
 */
export interface VodProbe {
  /**
   * ffprobe recognised the container.
   *
   * When false, everything else is null — and it has to be said that way: "no
   * video track" suggests a valid file stripped of its picture, whereas it is the
   * whole container that does not open. The two are not repaired the same way.
   */
  ouvert: boolean
  durationMs: number | null
  video: { codec: string; width: number; height: number; fps: number | null } | null
  audio: { codec: string; channels: number } | null
  bitrateKbps: number | null
}

/**
 * A file's verdict, as written to the verdicts file on the room's disk.
 *
 * Field names are frozen for that reason: a rename would make every verdict
 * already written unreadable.
 */
export interface VodCheck {
  status: VodVerdict
  /** Instant of the check: a verdict from three hours ago is worth nothing. */
  at: string
  /** `auto` = the technical check; `operateur` = somebody opened the file. */
  by: 'auto' | 'operateur'
  /** What motivated the verdict, in plain words: a red badge with no reason serves nobody. */
  reasons: string[]
  probe: VodProbe | null
  /**
   * The file as it was when the verdict was made.
   *
   * A verdict is indexed by the file name, and that name gets reused: the format
   * asked of OBS is deterministic — date, room, time, title — so replaying the
   * same talk rewrites in the same place. Without this fingerprint, the previous
   * take's verdict showed on the new one, with the old ffprobe reading: "sidecar
   * missing" on a rush that had its own.
   *
   * Absent on verdicts written before it was introduced: those may no longer
   * describe anything and are not shown any more.
   */
  fichier?: { sizeBytes: number; modifiedAtMs: number }
}

export interface VodEntry {
  /** Path relative to the root, separators normalized — it is also the key. */
  file: string
  sizeBytes: number
  modifiedAtMs: number
  /**
   * The file moved a few seconds ago: the take is probably still running.
   * Checking it now would call a recording that is doing fine "truncated".
   */
  beingWritten: boolean
  sidecar: Sidecar | null
  check: VodCheck | null
}


/**
 * Why nothing is leaving.
 *
 * Rendered all the way to the control screen, and that is its reason to exist: a
 * wait with no motive reads as a failure, and the button you have just pressed
 * passes for dead. "waiting — talk in 6 min" needs no explanation.
 */
export type WaitReason =
  /**
   * No destination: the hub has no storage.
   *
   * The only refusal a manual request does not lift — it is not a bad moment, it
   * is the absence of anywhere to send to. The control app removes its buttons: a
   * button that fails on every click is worth less than an absent button.
   */
  | 'sans-stockage'
  /**
   * Storage exists, automation is off.
   *
   * **Distinct from the previous one, and that is the whole point of the split.**
   * The two long shared a single code, and the control app removed its buttons in
   * both cases — including on the default setting, which is precisely "nothing
   * leaves unless asked". A perfectly configured hub therefore offered no way to
   * send anything, while the regulator itself already accepted manual requests.
   */
  | 'auto-desactive'
  | 'enregistrement'
  | 'conference'
  | 'fenetre'
  | 'charge'
  | 'debit'

export interface UploadVerdict {
  allowed: boolean
  /** `null` when it is allowed: there is then nothing to explain. */
  reason: WaitReason | null
  /** Ceiling to apply, in bytes per second. `null` = no ceiling. */
  debitMaxOctetsS: number | null
  /** What the control app shows, in plain words. */
  text: string
}


/** What the control app shows for one file. */
export interface UploadRow {
  file: string
  state: string
  percent: number
  /**
   * What is left to send, in bytes.
   *
   * The percentage is not enough to derive a time from: rounded to an integer, it
   * is worth thirty megabytes per point on a three-gigabyte rush, and an estimate
   * computed on it would be off by as much. The remaining bytes are the only term
   * that, divided by a throughput, gives a duration.
   */
  remainingBytes: number
  debitOctetsS: number | null
  error: string | null
  manual: boolean
}

export interface UploadsView {
  entries: UploadRow[]
  verdict: UploadVerdict
}

/**
 * What the recordings dialog receives.
 *
 * `root` is passed through as is — null, the list is empty and the page must say
 * why rather than showing "no recording", which would read as a lost day.
 */
export interface VodList {
  root: string | null
  entries: VodEntry[]
  /**
   * External tools actually present on the machine.
   *
   * The page uses it so as not to offer a player that will never start: neither
   * ffmpeg nor ffprobe is a dependency of the machine.
   */
  tools: { ffmpeg: boolean; ffprobe: boolean }
}
