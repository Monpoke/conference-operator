import { mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import {
  ffprobeProbe,
  inspectRecording,
  parseFfprobeOutput,
  listRecordings,
  nodeVodFs,
  toolAvailable,
  openExcerpt,
  openFile,
  setVerdict,
  type VodProbe,
  type VodIndexDeps,
} from '../src/core/vod-index.js'
import type { Sidecar } from '../src/core/recording.js'

/**
 * Checking the footage.
 *
 * What these tests protect fits in one sentence: on the event's evening the room
 * is dismantled and nobody can redo anything. An empty or truncated file must
 * show up during the day, and show up *as such* — a green badge on unusable
 * footage is worse than no check at all.
 */
let racine: string

const SIDECAR: Sidecar = {
  sessionId: 'ses-1',
  title: 'HoneySwamp',
  speakers: [{ name: 'Steven', company: null }],
  roomId: 'track-1',
  trackTitle: 'track-1',
  category: null,
  startedAt: '2026-10-30T10:00:00.000Z',
  endedAt: '2026-10-30T10:45:00.000Z',
  durationMs: 45 * 60_000,
  markers: [{ label: 'demo', offsetMs: 60_000, at: '2026-10-30T10:01:00.000Z' }],
  videoFile: null,
}

/** One hour later: nothing written here is "still being written". */
const PLUS_TARD = () => Date.now() + 3_600_000

/**
 * The two clocks, moved forward together.
 *
 * `now` dates the verdicts, `realNow` judges the `mtime`s — and it is the second
 * that decides the writing window. These tests' files are written this instant:
 * without moving it forward too, all of them would be "still being written" and
 * no check would say anything else.
 */
function deps(options: Partial<VodIndexDeps> = {}): VodIndexDeps {
  return { root: racine, fs: nodeVodFs(), now: PLUS_TARD, realNow: PLUS_TARD, ...options }
}

/**
 * Footage of the announced size, without writing one useful byte.
 *
 * The average bitrate is part of the verdict — a three-kilobyte file for
 * forty-five minutes is unusable, and the check must say so. So a credible size
 * is needed: `truncate` gives one without filling the disk.
 */
function video(nom: string, octets = 2_700_000_000): string {
  const path = join(racine, nom)
  writeFileSync(path, '')
  truncateSync(path, octets)
  return path
}

function sidecar(nom: string, patch: Partial<Sidecar> = {}): void {
  writeFileSync(join(racine, nom), JSON.stringify({ ...SIDECAR, ...patch }, null, 2))
}

/** Sonde factice : ce que ffprobe aurait lu, sans ffprobe. */
function sonde(patch: Partial<VodProbe> = {}): (path: string) => Promise<VodProbe | null> {
  return async () => ({
    ouvert: true,
    durationMs: 45 * 60_000,
    video: { codec: 'h264', width: 1920, height: 1080, fps: 25 },
    audio: { codec: 'aac', channels: 2 },
    bitrateKbps: 8_000,
    ...patch,
  })
}

beforeEach(() => {
  racine = mkdtempSync(join(tmpdir(), 'vod-'))
})

afterEach(() => {
  rmSync(racine, { recursive: true, force: true })
})

describe('listing the recordings', () => {
  it('pairs each video with its sidecar, newest first', async () => {
    video('2026-10-30_track1_1000_honeyswamp.mkv')
    sidecar('2026-10-30_track1_1000_honeyswamp.json')
    video('2026-10-30_track1_1100_blind-ops.mkv')
    utimesSync(join(racine, '2026-10-30_track1_1000_honeyswamp.mkv'), new Date(1e9), new Date(1e9))

    const entries = await listRecordings(deps())

    expect(entries.map((entry) => entry.file)).toEqual([
      '2026-10-30_track1_1100_blind-ops.mkv',
      '2026-10-30_track1_1000_honeyswamp.mkv',
    ])
    expect(entries[1]!.sidecar?.title).toBe('HoneySwamp')
    // Footage with no sidecar stays listed: it is exactly the one we are after.
    expect(entries[0]!.sidecar).toBeNull()
  })

  it('ignores anything that is not a video', async () => {
    video('prise.mkv')
    writeFileSync(join(racine, 'notes.txt'), 'rien')
    writeFileSync(join(racine, 'prise.json'), '{}')

    const entries = await listRecordings(deps())

    expect(entries.map((entry) => entry.file)).toEqual(['prise.mkv'])
  })

  it('descends into a dated folder', async () => {
    mkdirSync(join(racine, '2026-10-30'))
    writeFileSync(join(racine, '2026-10-30', 'prise.mp4'), 'x')

    const entries = await listRecordings(deps())

    expect(entries.map((entry) => entry.file)).toEqual(['2026-10-30/prise.mp4'])
  })

  it('reports a file still being written rather than judging it', async () => {
    video('prise.mkv')

    const entry = (await listRecordings(deps({ realNow: () => Date.now() })))[0]!

    expect(entry.beingWritten).toBe(true)
  })

  it('judges the writing window on the machine\'s time, not the hub\'s', async () => {
    /*
     * The defect that made a running take look like finished footage.
     *
     * The `mtime`s come from the file system, so from the machine's time; the
     * room's clock, on the other hand, is corrected against the hub's. Of no
     * consequence on the day, where the gap is measured in milliseconds —
     * devastating in development, where the hub runs through an October day from a
     * machine that is in September: the gap was worth weeks, the window was never
     * reached, and the control app offered to send a file OBS was writing.
     */
    video('prise.mkv')

    const entry = (
      await listRecordings(
        deps({ now: () => Date.now() + 60 * 24 * 3_600_000, realNow: () => Date.now() }),
      )
    )[0]!

    expect(entry.beingWritten).toBe(true)
  })

  it('does not judge a running take, and accuses it of nothing', async () => {
    /*
     * The check went on, and what it returned was true but misleading: the
     * sidecar is only written on stop, so "sidecar absent" is certain; the bitrate
     * is computed on a half-written file. Three reasons for a single cause, and
     * the first — the only one that explains the other two — read as one among
     * them.
     */
    video('prise.mkv')
    const sonde = vi.fn(async () => null)

    const check = await inspectRecording(
      deps({ realNow: () => Date.now(), probe: sonde }),
      'prise.mkv',
    )

    expect(check.status).toBe('suspect')
    expect(check.reasons).toEqual(['prise en cours : à contrôler une fois l’enregistrement arrêté'])
    // No probe either: opening the container OBS is writing into costs I/O on the
    // master's disk, for a reading that is wrong.
    expect(sonde).not.toHaveBeenCalled()
    expect(check.probe).toBeNull()
  })

  it('does not break on a missing folder', async () => {
    expect(await listRecordings(deps({ root: join(racine, 'jamais') }))).toEqual([])
  })
})

describe('technical check', () => {
  it('declares an empty file unreadable', async () => {
    writeFileSync(join(racine, 'prise.mkv'), '')

    const check = await inspectRecording(deps({ probe: sonde() }), 'prise.mkv')

    expect(check.status).toBe('illisible')
    expect(check.reasons[0]).toContain('vide')
  })

  it('declares a complete take usable', async () => {
    video('prise.mkv')
    sidecar('prise.json')

    const check = await inspectRecording(deps({ probe: sonde() }), 'prise.mkv')

    expect(check.status).toBe('ok')
    expect(check.probe?.video?.height).toBe(1080)
  })

  it('declares a take with no audio track unreadable', async () => {
    video('prise.mkv')
    sidecar('prise.json')

    const check = await inspectRecording(
      deps({ probe: sonde({ audio: null }) }),
      'prise.mkv',
    )

    expect(check.status).toBe('illisible')
    expect(check.reasons.join(' ')).toContain('muette')
  })

  it('spots the gap between the stopwatch and the file', async () => {
    // The symptom of an OBS killed along the way: forty-five minutes timed in the
    // control app, twelve minutes on disk.
    video('prise.mkv')
    sidecar('prise.json')

    const check = await inspectRecording(
      deps({ probe: sonde({ durationMs: 12 * 60_000 }) }),
      'prise.mkv',
    )

    expect(check.status).toBe('suspect')
    expect(check.reasons.join(' ')).toContain('fin manquante')
  })

  it('makes a missing sidecar visible without crying unreadable', async () => {
    video('prise.mkv')

    const check = await inspectRecording(deps({ probe: sonde() }), 'prise.mkv')

    expect(check.status).toBe('suspect')
    expect(check.reasons.join(' ')).toContain('sidecar absent')
  })

  it('says the check is partial when ffprobe is missing', async () => {
    video('prise.mkv')
    sidecar('prise.json')

    const check = await inspectRecording(deps({ probe: async () => null }), 'prise.mkv')

    // With no tool, a plausible take stays "ok" — but the page must be able to
    // say what that "ok" really rests on.
    expect(check.status).toBe('ok')
    expect(check.reasons.join(' ')).toContain('sonde ffprobe indisponible')
    expect(check.probe).toBeNull()
  })

  it('does not go track by track on a file ffprobe refuses', async () => {
    // The case of a file that is not a video at all. "Aucune piste vidéo" suggests
    // a valid container stripped of its picture, and sends people looking in the
    // wrong place: the two are not repaired the same way.
    video('prise.mkv', 5_000)
    sidecar('prise.json')

    const check = await inspectRecording(
      deps({ probe: async () => ({ ouvert: false, durationMs: null, video: null, audio: null, bitrateKbps: null }) }),
      'prise.mkv',
    )

    expect(check.status).toBe('illisible')
    expect(check.reasons).toEqual(['conteneur illisible : ffprobe ne reconnaît pas ce fichier'])
  })

  it('refuses to leave the recordings folder', async () => {
    await expect(inspectRecording(deps(), '../../etc/passwd')).rejects.toThrow(/hors du dossier/)
  })
})

describe('the operator\'s verdict', () => {
  it('survives the modal being closed and outranks the probe', async () => {
    video('prise.mkv')
    sidecar('prise.json')
    await inspectRecording(deps({ probe: sonde() }), 'prise.mkv')

    await setVerdict(deps(), 'prise.mkv', 'illisible')
    const entry = (await listRecordings(deps()))[0]!

    expect(entry.check?.status).toBe('illisible')
    expect(entry.check?.by).toBe('operateur')
    // What the probe had read stays in view: the verdict completes it.
    expect(entry.check?.probe?.video?.codec).toBe('h264')
  })

  it('can be cleared, to take back a slip', async () => {
    video('prise.mkv')
    await setVerdict(deps(), 'prise.mkv', 'ok')

    expect(await setVerdict(deps(), 'prise.mkv', null)).toBeNull()
    expect((await listRecordings(deps()))[0]!.check).toBeNull()
  })

  it('does not lose the other verdicts while saving its own', async () => {
    video('a.mkv')
    video('b.mkv')
    await setVerdict(deps(), 'a.mkv', 'ok')
    await setVerdict(deps(), 'b.mkv', 'illisible')

    const entries = await listRecordings(deps())

    expect(entries.find((entry) => entry.file === 'a.mkv')?.check?.status).toBe('ok')
    expect(entries.find((entry) => entry.file === 'b.mkv')?.check?.status).toBe('illisible')
  })
})

/**
 * A verdict describes **a take**, not a file name.
 *
 * The format asked of OBS is deterministic — date, room, time, title — so playing
 * the same talk again writes to the same place. The first take's verdict then
 * showed on the second, with the first's ffprobe reading: "sidecar absent" on
 * footage that had its own.
 */
describe('a verdict going stale', () => {
  it('does not outlive the take it judged', async () => {
    video('prise.mkv')
    await inspectRecording(deps({ probe: sonde() }), 'prise.mkv')
    expect((await listRecordings(deps()))[0]!.check?.status).toBe('suspect')

    // Second take of the same talk: OBS writes again under the same name.
    video('prise.mkv', 1_900_000_000)
    sidecar('prise.json')

    expect((await listRecordings(deps()))[0]!.check).toBeNull()
  })

  it('does not outlive it either when the operator laid it down', async () => {
    video('prise.mkv')
    await setVerdict(deps(), 'prise.mkv', 'ok')
    expect((await listRecordings(deps()))[0]!.check?.status).toBe('ok')

    video('prise.mkv', 1_900_000_000)

    // "Relu en régie" must not carry over to the next take: it is the one verdict
    // nobody would think to question.
    expect((await listRecordings(deps()))[0]!.check).toBeNull()
  })

  it('holds as long as the file does not move', async () => {
    video('prise.mkv')
    sidecar('prise.json')
    await inspectRecording(deps({ probe: sonde() }), 'prise.mkv')

    expect((await listRecordings(deps()))[0]!.check?.status).toBe('ok')
  })

  it('discards a verdict written before the fingerprint existed', async () => {
    video('prise.mkv')
    // The previous format: no way to know what it was about, so the row goes back
    // to "non vérifié" rather than show a blind judgement.
    writeFileSync(
      join(racine, '.controles-vod.json'),
      JSON.stringify({
        version: 1,
        entries: {
          'prise.mkv': { status: 'suspect', at: '2026-10-30T08:00:00.000Z', by: 'auto', reasons: ['sidecar absent'], probe: null },
        },
      }),
    )

    expect((await listRecordings(deps()))[0]!.check).toBeNull()
  })
})

describe('reading ffprobe', () => {
  it('keeps the tracks, the duration and the bitrate', () => {
    const sondage = parseFfprobeOutput(
      JSON.stringify({
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001' },
          { codec_type: 'audio', codec_name: 'aac', channels: 2 },
        ],
        format: { duration: '2700.5', bit_rate: '8000000' },
      }),
    )

    expect(sondage.durationMs).toBe(2_700_500)
    expect(sondage.video?.fps).toBe(29.97)
    expect(sondage.audio?.channels).toBe(2)
    expect(sondage.bitrateKbps).toBe(8000)
  })

  it('falls back to the video track\'s duration', () => {
    // Matroska files written as a stream — OBS's — announce no container
    // duration: reading it where it is avoids declaring them all truncated.
    const sondage = parseFfprobeOutput(
      JSON.stringify({
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, duration: '600' }],
        format: {},
      }),
    )

    expect(sondage.durationMs).toBe(600_000)
    expect(sondage.audio).toBeNull()
  })

  it('returns null when the tool is not installed', async () => {
    expect(await ffprobeProbe('ffprobe-qui-n-existe-pas')(join(racine, 'prise.mkv'))).toBeNull()
  })

  it('does not accuse the file when it is the probe that did not answer', async () => {
    /**
     * The confusion to avoid: a machine with no ffprobe — or with an ffprobe one
     * is not allowed to run — would declare "conteneur illisible" on perfectly
     * sound footage. That is the diagnostic error this check exists to avoid, and
     * it would cost a day of doubt.
     */
    const faux = join(racine, 'ffprobe-non-executable')
    writeFileSync(faux, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    video('prise.mkv')
    sidecar('prise.json')

    expect(await ffprobeProbe(faux)(join(racine, 'prise.mkv'))).toBeNull()

    const check = await inspectRecording(deps({ probe: ffprobeProbe(faux) }), 'prise.mkv')
    expect(check.status).toBe('ok')
    expect(check.reasons.join(' ')).toContain('sonde ffprobe indisponible')
    expect(check.reasons.join(' ')).not.toContain('conteneur illisible')
  })
})

/**
 * Makes real three-second footage, picture and sound.
 *
 * With no real file there is nothing to repackage: the only test that proves a
 * Matroska comes back out as an MP4 a browser can read needs a Matroska. `null`
 * when the machine has nothing to produce one with — the test then stands down,
 * rather than go red for a reason that has nothing to do with the code.
 */
async function fabriquerRush(nom: string): Promise<string | null> {
  if (!(await toolAvailable('ffmpeg'))) return null
  const path = join(racine, nom)
  const fait = await new Promise<boolean>((termine) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10',
       '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast',
       '-c:a', 'aac', '-y', path],
      { timeout: 60_000 },
      (error) => termine(error == null),
    )
  })
  return fait ? path : null
}

/**
 * Closes a stream we did not read.
 *
 * Without this the file opens after `afterEach`'s cleanup and the `ENOENT`
 * surfaces outside any test, where nobody is expecting it any more.
 */
function fermer(flux: { on: (e: string, h: () => void) => unknown; destroy: () => void }): void {
  flux.on('error', () => {})
  flux.destroy()
}

async function avaler(flux: NodeJS.ReadableStream): Promise<Buffer> {
  const morceaux: Buffer[] = []
  for await (const morceau of flux) morceaux.push(Buffer.from(morceau as Buffer))
  return Buffer.concat(morceaux)
}

describe('reading footage', () => {
  it('serves the whole file when nothing is asked for', async () => {
    video('prise.mkv', 5_000)

    const flux = (await openFile(deps(), 'prise.mkv'))!

    expect(flux.size).toBe(5_000)
    expect([flux.start, flux.end]).toEqual([0, 4_999])
    expect(flux.type).toBe('video/x-matroska')
    fermer(flux.stream)
  })

  it('serves the requested range', async () => {
    // What makes a three-gigabyte file seekable: with no ranges, a player
    // downloads everything before the first frame.
    video('prise.mp4', 5_000)

    const flux = (await openFile(deps(), 'prise.mp4', 'bytes=1000-1999'))!

    expect([flux.start, flux.end]).toEqual([1_000, 1_999])
    expect(flux.type).toBe('video/mp4')
    expect((await avaler(flux.stream)).length).toBe(1_000)
  })

  it('serves the end of the file, where players look for the index', async () => {
    video('prise.mkv', 5_000)

    const flux = (await openFile(deps(), 'prise.mkv', 'bytes=-500'))!

    expect([flux.start, flux.end]).toEqual([4_500, 4_999])
    fermer(flux.stream)
  })

  it('returns null on a missing file, and refuses to leave the folder', async () => {
    expect(await openFile(deps(), 'jamais.mkv')).toBeNull()
    await expect(openFile(deps(), '../../etc/passwd')).rejects.toThrow(/hors du dossier/)
  })
})

describe('preview', () => {
  it('says no rather than open a player that will never start', async () => {
    video('prise.mkv')

    expect(
      await openExcerpt(deps(), 'prise.mkv', { command: 'ffmpeg-qui-n-existe-pas' }),
    ).toBeNull()
  })

  it('repackages a Matroska into MP4 without touching the file', async () => {
    const path = await fabriquerRush('essai.mkv')
    if (path == null) return

    const extrait = (await openExcerpt(deps({ probe: ffprobeProbe() }), 'essai.mkv', {
      atMs: 0,
      durationMs: 5_000,
    }))!
    const octets = await avaler(extrait.stream)
    extrait.stop()

    // `ftyp` up front: it is an MP4, and that is all a browser asks for to show a
    // frame from a container it cannot open.
    expect(octets.length).toBeGreaterThan(1_000)
    expect(octets.subarray(0, 12).toString('latin1')).toContain('ftyp')
    // The original footage is intact: we never write over what was captured.
    expect((await listRecordings(deps()))[0]!.file).toBe('essai.mkv')
  }, 90_000)
})
