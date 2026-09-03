import { z } from 'zod'
import {
  isoDateTimeSchema,
  obsInstanceSchema,
  roomIdSchema,
  sessionIdSchema,
} from './primitives.js'

/**
 * Shipping the rushes back to S3 storage.
 *
 * The split is clean, and it is what holds the security of everything else: the
 * **hub** holds the bucket keys and never hands them over; the **room** holds the
 * files and knows nothing about the storage. It asks, receives short-lived signed
 * addresses, uploads to them, and reports where it stands. A stolen room machine
 * gives access to no bucket.
 *
 * The field names of the schemas below stay French: they travel on the wire and
 * are stored as JSON, and renaming them would break a room already in the field.
 */

/**
 * What gets uploaded for a talk.
 *
 * The two go together, extension aside: the sidecar carries title, speakers,
 * category and markers, and without it the rush reaches editing as an anonymous
 * three-gigabyte file.
 */
export const vodKindSchema = z.enum(['rush', 'sidecar'])
export type VodKind = z.infer<typeof vodKindSchema>

/**
 * Where an upload stands.
 *
 * `abandonne` and `echoue` say two different things: the first was interrupted —
 * room switched off, hub housekeeping — and resumes as is; the second was refused
 * by the storage, and gets looked at before being restarted.
 */
export const uploadStateSchema = z.enum([
  'attente',
  'en-cours',
  'termine',
  'abandonne',
  'echoue',
])
export type UploadState = z.infer<typeof uploadStateSchema>

/**
 * The work plan the hub hands back to a room.
 *
 * Two modes, because two very different files travel through here. The sidecar
 * weighs a few kilobytes: one address, one request, done. The rush weighs several
 * gigabytes over an event network, which is to say it *will* be cut off — so it
 * leaves in parts, and an outage only loses the part in flight.
 */
export const uploadPlanSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('direct'),
    uploadId: z.string(),
    url: z.url(),
    /** Past this time the address is worth nothing: another one has to be asked for. */
    expiresAt: isoDateTimeSchema,
  }),
  z.object({
    mode: z.literal('multipart'),
    uploadId: z.string(),
    taillePartOctets: z.number().int().positive(),
    parts: z.number().int().positive(),
    /**
     * Numbers of the parts that have already reached the storage.
     *
     * This is what makes `vod.begin` a **resumption** and not a restart: a machine
     * rebooted mid-upload asks for its plan again and picks up where it was.
     * Without this field, an outage at 90% of a three-gigabyte rush would cost the
     * three gigabytes.
     */
    recues: z.array(z.number().int().positive()).default([]),
  }),
])
export type UploadPlan = z.infer<typeof uploadPlanSchema>

/** A signed address for one part, and its expiry date. */
export const signedPartSchema = z.object({
  numero: z.number().int().positive(),
  url: z.url(),
  expiresAt: isoDateTimeSchema,
})
export type SignedPart = z.infer<typeof signedPartSchema>

/**
 * When a room is allowed to upload, and at what pace.
 *
 * A hub setting and not a per-room one: it is an operations decision — "the event
 * network is loaded, calm down" — and taking it three times, machine by machine,
 * on an event day, would never happen. It comes down at sync and lives in the
 * local cache, so that the regulator of a disconnected room keeps deciding.
 */
export const vodPolicySchema = z.object({
  /**
   * Automatic upload.
   *
   * Off by default: the default must be the case where nothing leaves unless
   * asked. A manual request works either way, enabled or not.
   */
  actif: z.boolean().default(false),
  /**
   * Throughput ceiling, in bytes per second. `null` = no ceiling.
   *
   * The only setting that protects the event's uplink, and the only one you want
   * to correct during the day — hence its place here rather than in an
   * environment variable.
   */
  debitMaxOctetsS: z.number().int().positive().nullable().default(null),
  /** Beyond this, we leave the CPU to the encoder. */
  cpuMax: z.number().min(0).max(1).default(0.7),
  /** Minutes before the next talk during which we stop uploading. */
  margeConferenceMinutes: z.number().int().min(0).max(120).default(10),
  /**
   * Part size, in megabytes.
   *
   * It is also the granularity of the throughput ceiling and of the resumption:
   * too large, an outage is expensive and the throughput is regulated in jolts;
   * too small, we multiply round trips. Eight is a compromise, and S3 accepts no
   * less than five.
   */
  taillePartMo: z.number().int().min(5).max(64).default(8),
})
export type VodPolicy = z.infer<typeof vodPolicySchema>
export type VodPolicyInput = z.input<typeof vodPolicySchema>

/**
 * The policy when nobody has configured anything.
 *
 * A named constant rather than a repeated literal: it serves as the default for
 * the hub settings *and* as the fallback for a room that has never synced, and
 * the two must say the same thing. Nothing leaves automatically — that is the
 * cautious default, the one you want to find on a hub you have just switched on.
 */
export const DEFAULT_VOD_POLICY: VodPolicy = vodPolicySchema.parse({})

/** What the hub sends down to the rooms at sync. */
export const vodSyncSchema = z.object({
  /** The hub knows where to send: otherwise none of this makes sense. */
  actif: z.boolean().default(false),
  politique: vodPolicySchema,
  /**
   * Certificate authority to add in order to reach the storage, in PEM format.
   *
   * `null` — the normal case — relies on the public CAs Node ships with. The field
   * exists for internal storage whose certificate is signed by a corporate CA:
   * Node does not use the system store, and a room would refuse the connection
   * with an unexplained `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.
   *
   * Sent down by the hub rather than set on each machine: setting an environment
   * variable on three Electron machines on an event morning is a gesture you
   * forget on the third, and the omission is only discovered in the evening, when
   * the rushes do not leave. A CA certificate is public by construction — it is
   * not a secret you distribute, it is what lets you verify one.
   *
   * It only applies to uploads towards the storage: nothing here changes what the
   * room accepts elsewhere.
   */
  caCert: z.string().nullable().default(null),
})
export type VodSync = z.infer<typeof vodSyncSchema>

/** One row of the "uploads" view, for the console and the control app. */
export const uploadViewSchema = z.object({
  roomId: roomIdSchema,
  roomName: z.string().nullable(),
  file: z.string(),
  kind: vodKindSchema,
  sessionId: sessionIdSchema.nullable(),
  objectKey: z.string(),
  state: uploadStateSchema,
  sizeBytes: z.number().int().nonnegative(),
  bytesSent: z.number().int().nonnegative(),
  /** Last observed throughput, in bytes per second. `null` before the first part. */
  debitOctetsS: z.number().int().nonnegative().nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  lastProgressAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
})
export type UploadView = z.infer<typeof uploadViewSchema>

/**
 * A take, as the hub reconstructs it from what the room reported.
 *
 * The hub has never seen the control machine's disk, and has no way to read it:
 * rooms call, never the other way round. What it knows comes from the two events
 * the room emits while recording — `recording.started` and `recording.stopped` —,
 * and those two are enough: the second carries the path of the written file, its
 * duration, and whether the sidecar could be written alongside. So a row here
 * means "a file exists on the room's machine", not "a file exists somewhere".
 */
export const captureViewSchema = z.object({
  roomId: roomIdSchema,
  /** Which of the two OBS instances recorded. */
  obs: obsInstanceSchema,
  startedAt: isoDateTimeSchema,
  /** `null` while the take is running: that is exactly what `enCours` says. */
  endedAt: isoDateTimeSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /**
   * Path returned by OBS, after renaming.
   *
   * `null` on a take OBS refused to name — full disk, process killed mid-stop.
   * That is precisely the case you want to see before dismantling the room: the
   * take happened, the file is nowhere to be found.
   */
  file: z.string().nullable(),
  /**
   * The sidecar was written next to the master.
   *
   * Without it the rush reaches editing as an anonymous file: no title, no
   * speakers, no markers. Saying so here saves discovering it at editing time.
   */
  sidecarWritten: z.boolean(),
  enCours: z.boolean(),
  /**
   * The take was never closed, and another started after it.
   *
   * This is not "running": it is a take whose stop the hub never heard — OBS
   * restarted, room machine killed, reset in the middle of a recording. Showing
   * them all as active gave, on a three-day development room, a pile of false
   * "recording in progress" on top of the one row that said something.
   *
   * They stay listed: the hub knows OBS wrote, and an orphan file on a disk you
   * are about to unplug deserves to be seen. But they say what they are.
   */
  finInconnue: z.boolean().default(false),
  /**
   * How the take was attached to the slot.
   *
   * `session`: the control app stamped it itself, the normal case and the only one
   * beyond dispute. `horaire`: the take carries no slot — recording launched by
   * hand, outside the lifecycle — but it covers that slot's time in the same room.
   * Saying so rather than staying silent: a rush exists, it is probably the right
   * one, and nobody would find it if it appeared nowhere.
   */
  rattachement: z.enum(['session', 'horaire']),
})
export type CaptureView = z.infer<typeof captureViewSchema>

/**
 * A talk's VOD folder: what was captured, what was uploaded.
 *
 * The two halves answer two questions asked one after the other on an event day —
 * "do we have it?", then "has it left?" — and they cannot be derived from each
 * other: a recorded rush may never be uploaded, and an upload may be running on a
 * file whose take ended badly.
 */
export const vodFolderSchema = z.object({
  sessionId: sessionIdSchema,
  roomId: roomIdSchema.nullable(),
  roomName: z.string().nullable(),
  /**
   * Does the hub know how to upload.
   *
   * When false, "nothing uploaded" means nothing: it is not a delay, it is a
   * feature that is not wired up on this hub. The console does not say the same
   * thing in the two cases.
   */
  stockageConfigure: z.boolean(),
  captations: z.array(captureViewSchema),
  televersements: z.array(uploadViewSchema),
})
export type VodFolder = z.infer<typeof vodFolderSchema>

/**
 * The four steps of a connection check, in the order in which they fail.
 *
 * A boolean would be useless: "it does not work" is precisely what we already
 * knew. What we need is *where* it stops, because the four are not fixed in the
 * same place — a firewall, a key, a right on the bucket, a signature.
 */
export const checkStepSchema = z.enum(['joindre', 'authentifier', 'signer', 'nettoyer'])
export type CheckStep = z.infer<typeof checkStepSchema>

export const storageCheckSchema = z.object({
  ok: z.boolean(),
  etapes: z.array(
    z.object({
      nom: checkStepSchema,
      ok: z.boolean(),
      /** What happened, in plain words. The storage's code is quoted verbatim. */
      detail: z.string().nullable(),
    }),
  ),
})
export type StorageCheck = z.infer<typeof storageCheckSchema>
