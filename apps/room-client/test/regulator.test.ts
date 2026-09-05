import { describe, expect, it } from 'vitest'
import { DEFAULT_VOD_POLICY, type VodPolicy } from '@conference-operator/contract'
import {
  waitAfter,
  uploadVerdict,
  RATE_FLOOR_BYTES_S,
  type RegulatorInputs,
} from '../src/core/regulator.js'

/**
 * What the regulator protects, and why the order of the rules matters.
 *
 * Footage not brought home tonight is brought home tomorrow. A take damaged
 * because the disk was being read while OBS was writing to it can never be made
 * again: the room is dismantled, the speaker has left, and the only possible
 * answer is "we do not have it". The whole hierarchy of rules comes from that.
 *
 * The order is not cosmetic either: the first rule that refuses is the one whose
 * reason the operator reads in the control app. A room that is recording *and*
 * whose machine is loaded must say "enregistrement en cours" — that is the fact
 * that explains itself least well on its own.
 */

const CALM_LOAD = { cpu: 0.2, cores: 8, windowMs: 2000, memory: null }

function entries(patch: Partial<RegulatorInputs> = {}): RegulatorInputs {
  return {
    storageReady: true,
    policy: { ...DEFAULT_VOD_POLICY, actif: true },
    manual: false,
    recording: false,
    talkRunning: false,
    msBeforeNext: 60 * 60_000,
    load: CALM_LOAD,
    observedRateBytesS: null,
    ...patch,
  }
}

describe('what forbids uploading', () => {
  it('allows it when nothing stands in the way', () => {
    const verdict = uploadVerdict(entries())
    expect(verdict.allowed).toBe(true)
    expect(verdict.reason).toBeNull()
  })

  it('never leaves on its own while automatic mode is off', () => {
    // The hub's default, and the right one: no byte leaves a room without
    // somebody having decided it.
    expect(uploadVerdict(entries({ policy: DEFAULT_VOD_POLICY }))).toMatchObject({
      allowed: false,
      reason: 'auto-desactive',
    })
  })

  it('lets a manual request through when automatic mode is off', () => {
    // The reason is distinct from having no storage, and that is what lets the
    // control app keep its buttons on the hub's default setting.
    expect(
      uploadVerdict(entries({ policy: DEFAULT_VOD_POLICY, manual: true })),
    ).toMatchObject({ allowed: true, reason: null })
  })

  it('goes nowhere when the hub has no storage', () => {
    expect(
      uploadVerdict(entries({ storageReady: false, manual: true })),
    ).toMatchObject({ allowed: false, reason: 'sans-stockage' })
  })

  it('refuses during a recording, before any other reason', () => {
    // The case that costs a VOD: reading the disk OBS is writing the master to.
    const verdict = uploadVerdict(
      entries({ recording: true, load: { ...CALM_LOAD, cpu: 0.95 }, msBeforeNext: 0 }),
    )
    expect(verdict.reason).toBe('enregistrement')
    expect(verdict.text).toContain('enregistrement')
  })

  it('refuses during a driven talk', () => {
    // The uplink may be serving the live stream, and the machine is encoding.
    expect(uploadVerdict(entries({ talkRunning: true }))).toMatchObject({
      reason: 'conference',
    })
  })

  it('stops a quarter of an hour before the next talk if asked to', () => {
    const policy: VodPolicy = {
      ...DEFAULT_VOD_POLICY,
      actif: true,
      margeConferenceMinutes: 15,
    }
    expect(
      uploadVerdict(entries({ policy, msBeforeNext: 14 * 60_000 })),
    ).toMatchObject({ allowed: false, reason: 'fenetre' })
    expect(uploadVerdict(entries({ policy, msBeforeNext: 16 * 60_000 })).allowed).toBe(
      true,
    )
  })

  it('says how many minutes are left, not merely that it is waiting', () => {
    // "en attente" with no figure reads as a failure; "conférence dans 6 min"
    // reads as a decision.
    const verdict = uploadVerdict(entries({ msBeforeNext: 6 * 60_000 }))
    expect(verdict.text).toBe('conférence dans 6 min')
  })

  it('uploads to the very end of a finished day', () => {
    // No talk left in the program: this is the ideal moment, not an edge case. A
    // room dismantled at 7 pm has the whole evening ahead of it.
    expect(uploadVerdict(entries({ msBeforeNext: null })).allowed).toBe(true)
  })

  it('leaves the processor to the encoder', () => {
    expect(
      uploadVerdict(entries({ load: { ...CALM_LOAD, cpu: 0.85 } })),
    ).toMatchObject({ reason: 'charge' })
  })

  it('treats an unreadable load as a heavy load, not as zero', () => {
    // `cpu: null` is an admission — we failed to read the counters. Allowing
    // ourselves to load the machine on that ignorance is the wrong bet: the
    // encoder would pay for it, and in silence.
    const verdict = uploadVerdict(entries({ load: { ...CALM_LOAD, cpu: null } }))
    expect(verdict).toMatchObject({ allowed: false, reason: 'charge' })
    expect(verdict.text).toContain('illisible')
  })

  it('also watches memory, the other way a machine gives out', () => {
    // The machine does not slow down outright: it starts swapping to disk — the
    // very one writing the footage.
    const memory = { usedBytes: 95, totalBytes: 100 }
    expect(uploadVerdict(entries({ load: { ...CALM_LOAD, memory } }))).toMatchObject({
      reason: 'charge',
    })
  })

  it('eases off when the network collapses', () => {
    expect(
      uploadVerdict(entries({ observedRateBytesS: RATE_FLOOR_BYTES_S - 1 })),
    ).toMatchObject({ reason: 'debit' })
    expect(
      uploadVerdict(entries({ observedRateBytesS: RATE_FLOOR_BYTES_S + 1 })).allowed,
    ).toBe(true)
  })

  it('carries the hub\'s throughput ceiling down to the uploader', () => {
    const policy = { ...DEFAULT_VOD_POLICY, actif: true, debitMaxOctetsS: 1_500_000 }
    expect(uploadVerdict(entries({ policy })).debitMaxOctetsS).toBe(1_500_000)
  })
})

describe('the manual request', () => {
  it('overrides the window, the load and the throughput', () => {
    // Whoever presses the button has the room in front of them. Those three
    // rules protect an automation; a person is not one.
    const verdict = uploadVerdict(
      entries({
        manual: true,
        policy: DEFAULT_VOD_POLICY,
        msBeforeNext: 60_000,
        load: { ...CALM_LOAD, cpu: 0.99 },
        observedRateBytesS: 1,
      }),
    )
    expect(verdict.allowed).toBe(true)
  })

  it('overrides neither the recording nor the running talk', () => {
    // The only two cases where going on would cost the take itself. The control
    // app warns before sending the request: the refusal surprises nobody.
    expect(uploadVerdict(entries({ manual: true, recording: true })).allowed).toBe(false)
    expect(uploadVerdict(entries({ manual: true, talkRunning: true })).allowed).toBe(
      false,
    )
  })

  it('still honours the throughput ceiling', () => {
    // Overriding the wait is not overriding the event's network: the ceiling
    // protects the other rooms, not this one.
    const policy = { ...DEFAULT_VOD_POLICY, debitMaxOctetsS: 800_000 }
    expect(uploadVerdict(entries({ manual: true, policy })).debitMaxOctetsS).toBe(800_000)
  })
})

describe('when to retry', () => {
  it('comes back quickly on what lifts by itself', () => {
    // A talk ends, a machine calms down: asking again costs one read of the
    // counters, and waiting ten minutes would miss the window.
    expect(waitAfter('conference', 9)).toBe(15_000)
    expect(waitAfter('charge', 9)).toBe(15_000)
    expect(waitAfter('fenetre', 0)).toBe(15_000)
  })

  it('backs off exponentially on throughput, and no further than a quarter hour', () => {
    // A saturated network does not heal because one asks again — insisting is
    // what keeps it saturated. But the room must not fall asleep for the night.
    expect(waitAfter('debit', 0)).toBe(30_000)
    expect(waitAfter('debit', 1)).toBe(60_000)
    expect(waitAfter('debit', 20)).toBe(15 * 60_000)
  })
})
