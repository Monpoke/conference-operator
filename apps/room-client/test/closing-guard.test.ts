import { describe, expect, it } from 'vitest'
import { closingWarning } from '../src/core/closing-guard.js'
import type { ObsState } from '../src/core/obs.js'

function obs(instance: 'A' | 'B', patch: Partial<ObsState> = {}): ObsState {
  return {
    instance,
    connected: true,
    currentSceneName: null,
    currentRole: null,
    unresolvedRoles: [],
    simulated: false,
    scenes: [],
    recording: false,
    streaming: false,
    ...patch,
  }
}

describe('closingWarning', () => {
  it('lets an idle room close without a word', () => {
    expect(closingWarning({ A: obs('A'), B: obs('B') })).toBeNull()
    expect(closingWarning({ A: null, B: null })).toBeNull()
  })

  it('names each thing OBS is doing', () => {
    const warning = closingWarning({
      A: obs('A', { streaming: true }),
      B: obs('B', { recording: true, streaming: true }),
    })
    expect(warning).not.toBeNull()
    expect(warning!.detail).toContain('Diffusion en direct — OBS-A')
    expect(warning!.detail).toContain('Enregistrement en cours — OBS-B')
    expect(warning!.detail).toContain('Diffusion en direct — OBS-B')
  })

  it('says where the capture runs on a single-OBS room', () => {
    const warning = closingWarning({ A: obs('A'), B: obs('B', { canvas: true, recording: true }) })
    expect(warning!.detail).toContain('Enregistrement en cours — captation (canevas d’OBS-A)')
  })

  // A dropped instance's snapshot is what it was doing before the cut.
  it('ignores an instance the room no longer reaches', () => {
    expect(closingWarning({ A: obs('A'), B: obs('B', { connected: false, recording: true }) })).toBeNull()
  })
})
