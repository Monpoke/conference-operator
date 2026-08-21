import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeProgram, sessionsForRoom, type Session } from '@cloudnord/program'
import {
  RecordingSession,
  buildFilenameFormat,
  slugify,
  type RecordingDeps,
  type RecordingFs,
  type Sidecar,
} from '../src/core/recording.js'

const program = normalizeProgram(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
      'utf8',
    ),
  ),
)

const TRACK_1 = 'track-1-teilhard-de-chardin'
const honeySwamp = sessionsForRoom(program, TRACK_1).find((s) => s.id === 'cmqav0qto03qe01nsitbr18cn')!

/** Système de fichiers simulé, pour vérifier renommage et sidecar sans disque. */
function fakeFs(existing: string[] = []) {
  const files = new Map<string, string>(existing.map((path) => [path, '']))
  const fs: RecordingFs = {
    rename: vi.fn(async (from, to) => {
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    }),
    writeFile: vi.fn(async (path, contents) => {
      files.set(path, contents)
    }),
    exists: async (path) => files.has(path),
  }
  return { fs, files }
}

let clockMs: number
const OFFSET = 0

function makeSession(fs: RecordingFs, overrides: Partial<RecordingDeps> = {}) {
  const calls: string[] = []
  const session = new RecordingSession({
    setFilenameFormat: vi.fn(async (format) => {
      calls.push(`format:${format}`)
    }),
    startRecord: vi.fn(async () => {
      calls.push('start')
    }),
    stopRecord: vi.fn(async () => {
      calls.push('stop')
    }),
    fs,
    now: () => clockMs,
    correctedNow: () => clockMs + OFFSET,
    ...overrides,
  })
  return { session, calls }
}

const START = { session: honeySwamp, roomId: TRACK_1, roomSlug: 'track1', timezone: 'Europe/Paris' }

beforeEach(() => {
  clockMs = Date.parse('2026-10-30T10:00:00.000Z')
})

describe('nom de fichier', () => {
  it('trie naturellement par date, salle et heure', () => {
    // 10:00 UTC → 11:00 à Paris : c'est l'heure locale qui doit apparaître,
    // celle que l'équipe lit sur le programme papier.
    expect(buildFilenameFormat(START)).toBe('2026-10-30_track1_1100_honeyswamp-active-defense-to-ruin-attackers')
  })

  it('produit des noms traversant Windows, macOS et YouTube', () => {
    expect(slugify('Déjeuner & pause café — 30 min !')).toBe('dejeuner-pause-cafe-30-min')
    expect(slugify('C++ / Rust : où va-t-on ?')).toBe('c-rust-ou-va-t-on')
    expect(slugify('...')).toBe('sans-titre')
  })

  it('borne la longueur sans laisser de tiret final', () => {
    const long = slugify('a'.repeat(40) + ' ' + 'b'.repeat(40))
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long.endsWith('-')).toBe(false)
  })
})

describe('cycle d\'enregistrement', () => {
  it('pose le format avant de démarrer', async () => {
    const { fs } = fakeFs()
    const { session, calls } = makeSession(fs)

    await session.start(START)
    // OBS lit le format au démarrage : l'ordre n'est pas négociable.
    expect(calls[0]).toContain('format:2026-10-30_track1_1100')
    expect(calls[1]).toBe('start')
    expect(session.active).toBe(true)
  })

  it('enregistre même si OBS refuse le format de nom', async () => {
    const { fs } = fakeFs()
    const onLog = vi.fn()
    const { session, calls } = makeSession(fs, {
      setFilenameFormat: vi.fn(async () => {
        throw new Error('paramètre inconnu')
      }),
      onLog,
    })

    await session.start(START)
    // Un enregistrement mal nommé vaut infiniment mieux qu'un talk non enregistré.
    expect(calls).toContain('start')
    expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('renommage au stop'), expect.anything())
  })

  it('horodate les marqueurs depuis le début de l\'enregistrement', async () => {
    const { fs } = fakeFs()
    const { session } = makeSession(fs)
    await session.start(START)

    clockMs += 90_000
    const premier = session.mark('démo live')
    clockMs += 210_000
    const second = session.mark('questions')

    expect(premier.offsetMs).toBe(90_000)
    expect(second.offsetMs).toBe(300_000)
    expect(session.markerCount).toBe(2)
  })

  it('refuse un marqueur hors enregistrement', () => {
    const { fs } = fakeFs()
    const { session } = makeSession(fs)
    expect(() => session.mark('perdu')).toThrow(/Aucun enregistrement/)
  })

  it('refuse de démarrer deux fois', async () => {
    const { fs } = fakeFs()
    const { session } = makeSession(fs)
    await session.start(START)
    await expect(session.start(START)).rejects.toThrow(/déjà en cours/)
  })
})

describe('sidecar', () => {
  it('écrit les métadonnées nécessaires au montage', async () => {
    const { fs, files } = fakeFs(['/rec/2026-10-30_track1_1100_honeyswamp-active-defense-to-ruin-attackers.mkv'])
    const { session } = makeSession(fs)

    await session.start(START)
    clockMs += 60_000
    session.mark('début démo')
    clockMs += 2_940_000

    const result = await session.stop(async () => '/rec/2026-10-30_track1_1100_honeyswamp-active-defense-to-ruin-attackers.mkv')

    expect(result.sidecarPath).toBe(
      '/rec/2026-10-30_track1_1100_honeyswamp-active-defense-to-ruin-attackers.json',
    )
    const sidecar = JSON.parse(files.get(result.sidecarPath!)!) as Sidecar
    expect(sidecar.sessionId).toBe(honeySwamp.id)
    expect(sidecar.title).toContain('HoneySwamp')
    expect(sidecar.speakers).toHaveLength(1)
    expect(sidecar.durationMs).toBe(3_000_000)
    expect(sidecar.markers).toEqual([
      expect.objectContaining({ label: 'début démo', offsetMs: 60_000 }),
    ])
    expect(sidecar.videoFile).toMatch(/\.mkv$/)
  })

  it('renomme quand OBS a ignoré le format', async () => {
    const { fs, files } = fakeFs(['/rec/2026-10-30 12-00-00.mkv'])
    const { session } = makeSession(fs)

    await session.start(START)
    const result = await session.stop(async () => '/rec/2026-10-30 12-00-00.mkv')

    // Filet de sécurité : `RecordStateChanged` donne le vrai chemin, on répare.
    expect(result.videoPath).toBe(
      '/rec/2026-10-30_track1_1100_honeyswamp-active-defense-to-ruin-attackers.mkv',
    )
    expect(files.has(result.videoPath!)).toBe(true)
    expect(files.has('/rec/2026-10-30 12-00-00.mkv')).toBe(false)
  })

  it('n\'écrase pas un fichier déjà présent au nom cible', async () => {
    const cible = '/rec/2026-10-30_track1_1100_honeyswamp-active-defense-to-ruin-attackers.mkv'
    const { fs } = fakeFs(['/rec/brut.mkv', cible])
    const { session } = makeSession(fs)

    await session.start(START)
    const result = await session.stop(async () => '/rec/brut.mkv')

    // Un talk rejoué ne doit pas effacer la première prise.
    expect(result.videoPath).toBe('/rec/brut.mkv')
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('signale bruyamment un enregistrement sans chemin de sortie', async () => {
    const { fs } = fakeFs()
    const onLog = vi.fn()
    const { session } = makeSession(fs, { onLog })

    await session.start(START)
    const result = await session.stop(async () => null)

    expect(result.sidecarPath).toBeNull()
    expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('aucun sidecar'))
    // Le contenu reste disponible pour l'appelant, qui peut le remonter au hub.
    expect(result.sidecar.title).toContain('HoneySwamp')
  })

  it('produit un sidecar exploitable même sans session au programme', async () => {
    const { fs, files } = fakeFs(['/rec/hors-programme.mkv'])
    const { session } = makeSession(fs)

    // Talk improvisé, ou programme pas encore synchronisé.
    await session.start({ ...START, session: null as unknown as Session })
    const result = await session.stop(async () => '/rec/hors-programme.mkv')

    const sidecar = JSON.parse(files.get(result.sidecarPath!)!) as Sidecar
    expect(sidecar.title).toBe('Sans titre')
    expect(sidecar.sessionId).toBeNull()
    expect(sidecar.speakers).toEqual([])
  })
})
