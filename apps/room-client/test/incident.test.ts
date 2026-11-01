import { roomEventPayloadSchema } from '@conference-operator/contract'
import { describe, expect, it } from 'vitest'
import { incidentReporter, INCIDENT_REPEAT_MS } from '../src/core/incident.js'

describe('telling the hub what went wrong', () => {
  it('sends a failure the hub accepts, with its file and its cause', () => {
    const report = incidentReporter('televersement', () => 0)('error', 'téléversement en échec', { file: 'a.mp4', error: 'HTTP 503' })
    expect(report).toMatchObject({ niveau: 'error', source: 'televersement', fichier: 'a.mp4', detail: 'HTTP 503' })
    expect(roomEventPayloadSchema.parse(report).type).toBe('room.incident')
  })

  it('keeps the routine out, and a repeated failure to once per period', () => {
    let at = 0
    const report = incidentReporter('televersement', () => at)
    expect(report('info', 'rush téléversé', { file: 'a.mp4' })).toBeNull()
    expect(report('warn', 'échec', { file: 'a.mp4' })).not.toBeNull()
    at = 60_000
    expect(report('warn', 'échec', { file: 'a.mp4' })).toBeNull()
    expect(report('warn', 'échec', { file: 'b.mp4' })).not.toBeNull()
    at = INCIDENT_REPEAT_MS
    expect(report('warn', 'échec', { file: 'a.mp4' })).not.toBeNull()
  })
})
