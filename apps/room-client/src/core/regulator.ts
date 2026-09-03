import type { HostLoad } from './host.js'
import type { VodPolicy } from '@cloudnord/contract'

/**
 * When a room is allowed to upload its rushes.
 *
 * Shipping back is an after-the-event comfort; the capture, on the other hand,
 * cannot be redone. This whole module rests on that hierarchy: at the slightest
 * doubt, we do not upload. A transfer reading the disk while OBS-B writes to it,
 * or saturating the uplink during a live stream, would be a remedy worse than the
 * disease — and the failure would be found at editing time, when the room is
 * dismantled.
 *
 * The module is **pure**: it reads neither disk, nor clock, nor network. That is
 * what makes it possible to run the whole day through a test, minute by minute,
 * without setting up a room.
 */
import type { WaitReason, UploadVerdict } from '@cloudnord/contract'

export type { WaitReason, UploadVerdict }

export interface RegulatorInputs {
  /** The hub has a ready storage. False: there is nowhere to send to. */
  storageReady: boolean
  policy: VodPolicy
  /** A human asked for this upload — here, or from the console. */
  manual: boolean
  /** OBS-B is recording right now. */
  recording: boolean
  /** A talk is being driven by this room (started, not ended). */
  talkRunning: boolean
  /**
   * Milliseconds before the start of this room's next talk.
   *
   * `null` when there is none left — end of day, or a room never synchronized.
   * Computed by the caller from the cached program and the hub's corrected clock,
   * never from the machine's: in development, the gap is counted in weeks.
   */
  msBeforeNext: number | null
  load: HostLoad
  /** The rate observed on the last part. `null` before the first one. */
  observedRateBytesS: number | null
}

/**
 * Below this rate, the network is visibly serving something else.
 *
 * Two hundred kilobytes per second: below that, a three-gigabyte rush would take
 * more than four hours, and we are in any case competing for bandwidth with
 * something. Better to come back later.
 */
export const RATE_FLOOR_BYTES_S = 200 * 1024

/** Above this, the machine swaps to the disk — the one writing the rush. */
const MAX_MEMORY = 0.9

const wait = (
  reason: WaitReason,
  text: string,
): UploadVerdict => ({ allowed: false, reason, debitMaxOctetsS: null, text })

const minutes = (ms: number): number => Math.max(0, Math.round(ms / 60_000))

/**
 * The verdict, in six ordered rules.
 *
 * The order carries the meaning: the first one that refuses gives the displayed
 * reason, and it is the one we want to read. A room that is recording *and* whose
 * machine is loaded must say "recording in progress", because that is what would
 * be least well explained otherwise.
 *
 * **A manual request overrides the last three** — window, load, rate. They protect
 * an automatism, and whoever presses the button is not one: they have the room in
 * front of them and know what they are doing. It never overrides the absence of
 * storage, which is not a bad moment but an absence of destination.
 *
 * Nor does it override the recording or the running talk, and that is deliberate:
 * those are the only two cases where carrying on would cost the capture itself.
 * The control app warns before sending the request, so that the refusal surprises
 * nobody.
 *
 * The `WaitReason` values and `debitMaxOctetsS` are contract names: they do not
 * get renamed.
 */
export function uploadVerdict(input: RegulatorInputs): UploadVerdict {
  if (!input.storageReady) {
    return wait('sans-stockage', 'aucun stockage configuré sur le hub')
  }
  if (!input.policy.actif && !input.manual) {
    return wait('auto-desactive', 'téléversement automatique désactivé')
  }
  if (input.recording) {
    return wait('enregistrement', 'enregistrement en cours')
  }
  if (input.talkRunning) {
    return wait('conference', 'conférence en cours')
  }

  const cap = input.policy.debitMaxOctetsS
  if (input.manual) {
    return { allowed: true, reason: null, debitMaxOctetsS: cap, text: 'demandé' }
  }

  const margin = input.policy.margeConferenceMinutes * 60_000
  if (input.msBeforeNext != null && input.msBeforeNext <= margin) {
    return wait('fenetre', `conférence dans ${minutes(input.msBeforeNext)} min`)
  }

  const { cpu, memory } = input.load
  // A null `cpu` is an admission, not a zero: we cannot read the counters, and
  // allowing ourselves to load the machine on that ignorance would be exactly the
  // wrong bet — it is the encoder that would pay.
  if (cpu == null || cpu > input.policy.cpuMax) {
    const said = cpu == null ? 'charge du poste illisible' : `poste à ${Math.round(cpu * 100)} %`
    return wait('charge', said)
  }
  if (memory != null && memory.usedBytes / memory.totalBytes > MAX_MEMORY) {
    return wait('charge', 'mémoire du poste saturée')
  }

  if (input.observedRateBytesS != null && input.observedRateBytesS < RATE_FLOOR_BYTES_S) {
    return wait('debit', 'réseau trop lent, nouvelle tentative plus tard')
  }

  return { allowed: true, reason: null, debitMaxOctetsS: cap, text: 'en cours' }
}

/**
 * How long to wait before retrying after a refusal.
 *
 * The rate is the only reason that **backs off exponentially**: the others lift
 * by themselves — a talk ends, a machine calms down — and coming back in fifteen
 * seconds only costs one read of the counters. A saturated network, on the other
 * hand, does not heal because one asks again, and insisting is precisely what
 * keeps it saturated.
 */
export function waitAfter(reason: WaitReason, failures: number): number {
  if (reason !== 'debit') return 15_000
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.min(failures, 5))
}
