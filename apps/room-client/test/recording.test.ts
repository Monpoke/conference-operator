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

/** A simulated file system, to check the rename and the sidecar with no disk. */
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

describe('file name', () => {
  it('sorts naturally by date, room and time', () => {
    // 10:00 UTC → 11:00 in Paris: it is the local time that must appear, the one
    // the team reads on the paper program.
    expect(buildFilenameFormat(START)).toBe('2026-10-30_track1_1100_honeyswamp-active-defense-to-ruin-attackers')
  })

  it('produces names that survive Windows, macOS and YouTube', () => {
    expect(slugify('Déjeuner & pause café — 30 min !')).toBe('dejeuner-pause-cafe-30-min')
    expect(slugify('C++ / Rust : où va-t-on ?')).toBe('c-rust-ou-va-t-on')
    expect(slugify('...')).toBe('sans-titre')
  })

  it('bounds the length without leaving a trailing dash', () => {
    const long = slugify('a'.repeat(40) + ' ' + 'b'.repeat(40))
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long.endsWith('-')).toBe(false)
  })
})

describe('recording cycle', () => {
  it('sets the format before starting', async () => {
    const { fs } = fakeFs()
    const { session, calls } = makeSession(fs)

    await session.start(START)
    // OBS reads the format at start time: the order is not negotiable.
    expect(calls[0]).toContain('format:2026-10-30_track1_1100')
    expect(calls[1]).toBe('start')
    expect(session.active).toBe(true)
  })

  it('records even if OBS refuses the name format', async () => {
    const { fs } = fakeFs()
    const onLog = vi.fn()
    const { session, calls } = makeSession(fs, {
      setFilenameFormat: vi.fn(async () => {
        throw new Error('unknown parameter')
      }),
      onLog,
    })

    await session.start(START)
    // A badly named recording is infinitely better than an unrecorded talk.
    expect(calls).toContain('start')
    expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('renommage au stop'), expect.anything())
  })

  it('timestamps the markers from the start of the recording', async () => {
    const { fs } = fakeFs()
    const { session } = makeSession(fs)
    await session.start(START)

    clockMs += 90_000
    const first = session.mark('demo live')
    clockMs += 210_000
    const second = session.mark('questions')

    expect(first.offsetMs).toBe(90_000)
    expect(second.offsetMs).toBe(300_000)
    expect(session.markerCount).toBe(2)
  })

  /*
   * The two editing anchors, and the one rule that tells them from a chapter:
   * there is only one of each, and the last one laid down wins.
   *
   * What is at stake here plays out three weeks later. Editing reads the sidecar
   * long after the room has been dismantled: what it finds there must be readable
   * with no adjudication, because nobody will be able to say which of the two
   * "Début" markers was the right one.
   */
  it('keeps only one anchor of each kind, the last one laid down', async () => {
    const { fs } = fakeFs()
    const { session } = makeSession(fs)
    await session.start(START)

    clockMs += 30_000
    session.mark('Début', 'debut')
    // False start: the speaker begins again a minute later, we lay the start down anew.
    clockMs += 60_000
    session.mark('Début', 'debut')
    clockMs += 1_800_000
    session.mark('Fin', 'fin')

    expect(session.editing).toEqual({ startMs: 90_000, endMs: 1_890_000 })
  })

  it('does not count the anchors among the chapter markers', async () => {
    const { fs } = fakeFs()
    const { session } = makeSession(fs)
    await session.start(START)

    session.mark('Début', 'debut')
    session.mark('Fin', 'fin')
    // Otherwise the control app shows "2 marker(s)" with no chapter laid down
    // at all, right beside a line that already says the anchors are there.
    expect(session.markerCount).toBe(0)

    session.mark('Questions')
    expect(session.markerCount).toBe(1)
  })

  it('orders the markers by offset when an anchor is laid down again', async () => {
    const { fs } = fakeFs()
    const { session } = makeSession(fs)
    await session.start(START)

    session.mark('Début', 'debut')
    clockMs += 60_000
    session.mark('Introduction')
    // The start goes back behind the chapter: laid down last, it falls first. A
    // sidecar out of order would ask editing to repair over there what is put in
    // order here.
    clockMs += 60_000
    session.mark('Début', 'debut')

    const result = await session.stop(async () => null)
    expect(result.sidecar.markers.map((marker) => marker.offsetMs)).toEqual([60_000, 120_000])
  })

  it('refuses a marker outside a recording', () => {
    const { fs } = fakeFs()
    const { session } = makeSession(fs)
    expect(() => session.mark('perdu')).toThrow(/Aucun enregistrement/)
  })

  it('refuses to start twice', async () => {
    const { fs } = fakeFs()
    const { session } = makeSession(fs)
    await session.start(START)
    await expect(session.start(START)).rejects.toThrow(/déjà en cours/)
  })
})

describe('sidecar', () => {
  it('writes the metadata editing needs', async () => {
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

  it('carries the anchors\' role, and nothing at all on a chapter', async () => {
    const { fs, files } = fakeFs(['/rec/prise.mkv'])
    const { session } = makeSession(fs)

    await session.start(START)
    clockMs += 40_000
    session.mark('Début', 'debut')
    clockMs += 200_000
    session.mark('Questions')
    clockMs += 400_000
    session.mark('Fin', 'fin')

    const result = await session.stop(async () => '/rec/prise.mkv')
    const sidecar = JSON.parse(files.get(result.sidecarPath!)!) as Sidecar

    /*
     * What editing reads, and the field's reason for being: a role, not a label
     * to recognise. "Début", "debut", "DÉBUT" and the day somebody types "Départ"
     * are too much alike to bet on.
     */
    expect(sidecar.markers.map((marker) => [marker.role ?? null, marker.offsetMs])).toEqual([
      ['debut', 40_000],
      [null, 240_000],
      ['fin', 640_000],
    ])
    // Absent, and not null: a `"role": null` on every chapter would suggest a
    // role that had been erased.
    expect(Object.keys(sidecar.markers[1]!)).not.toContain('role')
  })

  it('renames when OBS ignored the format', async () => {
    const { fs, files } = fakeFs(['/rec/2026-10-30 12-00-00.mkv'])
    const { session } = makeSession(fs)

    await session.start(START)
    const result = await session.stop(async () => '/rec/2026-10-30 12-00-00.mkv')

    // Safety net: `RecordStateChanged` gives the real path, we repair.
    expect(result.videoPath).toBe(
      '/rec/2026-10-30_track1_1100_honeyswamp-active-defense-to-ruin-attackers.mkv',
    )
    expect(files.has(result.videoPath!)).toBe(true)
    expect(files.has('/rec/2026-10-30 12-00-00.mkv')).toBe(false)
  })

  it('does not overwrite a file already present under the target name', async () => {
    const target = '/rec/2026-10-30_track1_1100_honeyswamp-active-defense-to-ruin-attackers.mkv'
    const { fs } = fakeFs(['/rec/brut.mkv', target])
    const { session } = makeSession(fs)

    await session.start(START)
    const result = await session.stop(async () => '/rec/brut.mkv')

    // A talk played again must not erase the first take.
    expect(result.videoPath).toBe('/rec/brut.mkv')
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('reports loudly a recording with no output path', async () => {
    const { fs } = fakeFs()
    const onLog = vi.fn()
    const { session } = makeSession(fs, { onLog })

    await session.start(START)
    const result = await session.stop(async () => null)

    expect(result.sidecarPath).toBeNull()
    expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('aucun sidecar'))
    // The content stays available to the caller, which can report it to the hub.
    expect(result.sidecar.title).toContain('HoneySwamp')
  })

  it('finds the master when OBS announces a path from another OS', async () => {
    /*
     * The case seen in the open: OBS on Windows recording into a WSL folder, and
     * announcing `//wsl.localhost/distro/home/…`. The file really was there, at an
     * ordinary Linux path; the sidecar went off beside a path that does not exist
     * on this side, the write failed, and every take of the day lost its title,
     * its speakers and its markers.
     */
    const attendu = buildFilenameFormat(START)
    // The "(2)" comes from OBS: it adds it when the name is taken — the first
    // take of the same talk is there, and that is what forbids renaming. OBS
    // stays the source of the name; only the folder changes sides.
    const { fs, files } = fakeFs([`/rec/${attendu}.mp4`, `/rec/${attendu} (2).mp4`])
    const onLog = vi.fn()
    const { session } = makeSession(fs, { onLog, recordingRoot: async () => '/rec' })

    await session.start(START)
    const result = await session.stop(
      async () => `//wsl.localhost/distro/ailleurs/${attendu} (2).mp4`,
    )

    expect(result.videoPath).toBe(`/rec/${attendu} (2).mp4`)
    expect(result.sidecarPath).toBe(`/rec/${attendu} (2).json`)
    const written = JSON.parse(files.get(result.sidecarPath!)!) as Sidecar
    expect(written.title).toContain('HoneySwamp')
    expect(onLog).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('sous la racine des captations'),
      expect.anything(),
    )
  })

  it('also splits a Windows path, which `basename` would return whole', async () => {
    // Node's `basename` only knows the current platform's separator: on Linux it
    // returns `C:\prises\talk.mkv` whole.
    const attendu = buildFilenameFormat(START)
    const { fs } = fakeFs([`/rec/${attendu}.mkv`])
    const { session } = makeSession(fs, { recordingRoot: async () => '/rec' })

    await session.start(START)
    const result = await session.stop(async () => `C:\\prises\\${attendu}.mkv`)

    expect(result.sidecarPath).toBe(`/rec/${attendu}.json`)
  })

  it('keeps the announced path when it names a file we can see', async () => {
    // The most common case — OBS and the room on the same machine — and the exact
    // answer: it alone knows what was written.
    const { fs } = fakeFs(['/ailleurs/brut.mkv'])
    const racine = vi.fn(async () => '/rec')
    const { session } = makeSession(fs, { recordingRoot: racine })

    await session.start(START)
    const result = await session.stop(async () => '/ailleurs/brut.mkv')

    expect(result.videoPath).toBe(`/ailleurs/${buildFilenameFormat(START)}.mkv`)
    expect(racine).not.toHaveBeenCalled()
  })

  it('finds the master by its name when OBS announces nothing', async () => {
    /*
     * OBS's event can get lost, arrive too late, or carry no path. The file, for
     * its part, is there and carries the name OBS was asked to write: losing
     * title, speakers and markers over a missing event would be paying very dearly
     * for one second of waiting.
     */
    const attendu = buildFilenameFormat(START)
    const { fs, files } = fakeFs([`/rec/${attendu}.mp4`])
    const onLog = vi.fn()
    const { session } = makeSession(fs, { onLog, recordingRoot: async () => '/rec' })

    await session.start(START)
    const result = await session.stop(async () => null)

    expect(result.videoPath).toBe(`/rec/${attendu}.mp4`)
    expect(result.sidecarPath).toBe(`/rec/${attendu}.json`)
    const written = JSON.parse(files.get(result.sidecarPath!)!) as Sidecar
    expect(written.title).toContain('HoneySwamp')
    expect(written.videoFile).toBe(`${attendu}.mp4`)
    expect(onLog).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('sous la racine des captations'),
      expect.anything(),
    )
  })

  it('writes no orphan sidecar when no master carries that name', async () => {
    // With no file to settle beside, we give up: scattering a lone sidecar in the
    // recordings folder would mislead the editing chain.
    const { fs, files } = fakeFs(['/rec/autre-chose.mkv'])
    const { session } = makeSession(fs, { recordingRoot: async () => '/rec' })

    await session.start(START)
    const result = await session.stop(async () => null)

    expect(result.sidecarPath).toBeNull()
    expect(files.has('/rec/autre-chose.json')).toBe(false)
  })



  it('follows the simulated clock in development', async () => {
    /*
     * We run through a day by pushing the hub's clock: 09:00, we start the take,
     * we jump to 09:50 to simulate the end. The take announced "0 min" — the time
     * really spent in front of the screen — while the timeline showed a
     * fifty-minute slot. Two figures for the same recording, and they did not look
     * alike.
     */
    const { fs, files } = fakeFs(['/rec/talk.mkv'])
    let decalage = 0
    const { session } = makeSession(fs, {
      correctedNow: () => clockMs + decalage,
      followsClock: true,
    })

    await session.start(START)
    // The hub moves fifty minutes ahead; real time does not move.
    decalage = 50 * 60_000
    const result = await session.stop(async () => '/rec/talk.mkv')

    expect(result.sidecar.durationMs).toBe(50 * 60_000)
    const sidecar = JSON.parse(files.get(result.sidecarPath!)!) as Sidecar
    expect(sidecar.durationMs).toBe(50 * 60_000)
  })

  it('puts the markers on the same clock as the duration', async () => {
    // Otherwise a marker laid down after a clock jump would fall past the end of
    // the file it annotates.
    const { fs } = fakeFs(['/rec/talk.mkv'])
    let decalage = 0
    const { session } = makeSession(fs, {
      correctedNow: () => clockMs + decalage,
      followsClock: true,
    })

    await session.start(START)
    decalage = 12 * 60_000
    const marker = session.mark('demo')
    decalage = 30 * 60_000
    const result = await session.stop(async () => '/rec/talk.mkv')

    expect(marker.offsetMs).toBe(12 * 60_000)
    expect(marker.offsetMs).toBeLessThan(result.sidecar.durationMs)
  })

  it('ignores the clock in production, where monotonic time is authoritative', async () => {
    // A take's duration must not move because the machine resynchronised its
    // clock mid-talk: a three-minute talk lasts three minutes, whatever the wall
    // clock says.
    const { fs } = fakeFs(['/rec/talk.mkv'])
    let decalage = 0
    const { session } = makeSession(fs, { correctedNow: () => clockMs + decalage })

    await session.start(START)
    clockMs += 3 * 60_000
    decalage = 50 * 60_000
    const result = await session.stop(async () => '/rec/talk.mkv')

    expect(result.sidecar.durationMs).toBe(3 * 60_000)
  })

  it('never returns a negative duration when the clock is wound back', async () => {
    // Winding the development clock back brings the take to zero. That is the
    // accepted consequence of following it — and it beats a negative duration that
    // would break everything reading it downstream.
    const { fs } = fakeFs(['/rec/talk.mkv'])
    let decalage = 0
    const { session } = makeSession(fs, {
      correctedNow: () => clockMs + decalage,
      followsClock: true,
    })

    await session.start(START)
    decalage = -24 * 60 * 60_000
    const result = await session.stop(async () => '/rec/talk.mkv')

    expect(result.sidecar.durationMs).toBe(0)
  })

  it('produces a usable sidecar even with no session in the program', async () => {
    const { fs, files } = fakeFs(['/rec/hors-programme.mkv'])
    const { session } = makeSession(fs)

    // An improvised talk, or a program not synchronised yet.
    await session.start({ ...START, session: null as unknown as Session })
    const result = await session.stop(async () => '/rec/hors-programme.mkv')

    const sidecar = JSON.parse(files.get(result.sidecarPath!)!) as Sidecar
    expect(sidecar.title).toBe('Sans titre')
    expect(sidecar.sessionId).toBeNull()
    expect(sidecar.speakers).toEqual([])
  })
})
