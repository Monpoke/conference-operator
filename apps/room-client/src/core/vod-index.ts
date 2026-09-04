import { createReadStream } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import type {
  VodCheck,
  VodEntry,
  VodProbe,
  Sidecar,
  VodVerdict,
} from '@cloudnord/contract'

export type { VodCheck, VodEntry, VodProbe, VodVerdict }

/** The containers OBS knows how to write. The rest of the folder is not our business. */
const EXTENSIONS = new Set(['.mkv', '.mp4', '.mov', '.flv', '.ts', '.m4v', '.webm', '.mpegts'])

/**
 * The verdicts live in a separate file, not in the sidecars.
 *
 * The sidecar is what the editing chain consumes, and it describes the talk, not
 * the review one made of it. Above all: a rush whose sidecar was never written —
 * OBS killed mid-stop, precisely the case we are looking for — is exactly the one
 * that has to be markable.
 *
 * The `ouvert`, `fichier`, `operateur` and the status values are contract names:
 * they do not get renamed.
 */
const CHECKS_FILE = '.controles-vod.json'

/** The file has just been touched: we do not judge a take in progress. */
const WRITE_WINDOW_MS = 30_000

/** Scan depth: OBS writes flat, a dated folder stays possible. */
const MAX_DEPTH = 2

export interface VodFs {
  readdir(path: string): Promise<{ name: string; isDirectory: boolean }[]>
  stat(path: string): Promise<{ size: number; mtimeMs: number } | null>
  readFile(path: string): Promise<string | null>
  writeFile(path: string, contents: string): Promise<void>
}

export interface VodIndexDeps {
  /** The recordings' root. Without it, there is nothing to list. */
  root: string
  fs: VodFs
  /**
   * The room's clock, corrected against the hub's.
   *
   * It dates the verdicts, and that is what we want: "reviewed three minutes ago"
   * is read next to a stopwatch and a program that are on that time. It serves
   * **only for that**.
   */
  now: () => number
  /**
   * The machine's real time, the only one that counts against the disk.
   *
   * The `mtime`s come from the file system: they are on the machine's time, not
   * on the hub's. Comparing them to the corrected clock amounted to subtracting
   * two times that do not measure the same thing — of no consequence on the day,
   * where the gap is counted in milliseconds, but devastating in development,
   * where the hub runs an October day from a machine that is in September. The
   * gap was then worth weeks, the write window was never reached, and **a take in
   * progress showed in the control app as a finished rush, ready to leave**, with
   * a verdict returned on a file OBS was still writing.
   *
   * `Date.now` by default: it is the right answer everywhere except in a test.
   */
  realNow?: () => number

  /**
   * A technical read of the container. `null` = no tool available, the check then
   * falls back on what the disk and the sidecar say.
   */
  probe?: (path: string) => Promise<VodProbe | null>
  onLog?: (level: 'info' | 'warn' | 'error', message: string, context?: unknown) => void
}

/**
 * Lists the files produced under the root, from the most recent to the oldest.
 *
 * Purely descriptive: nothing is opened, nothing is probed. Opening the modal
 * must not launch half a dozen ffprobes on two-hour rushes while a talk is
 * running.
 */
export async function listRecordings(deps: VodIndexDeps): Promise<VodEntry[]> {
  const root = resolve(deps.root)
  const checks = await readChecks(deps, root)
  const entries: VodEntry[] = []

  const scan = async (directory: string, depth: number): Promise<void> => {
    let contents: { name: string; isDirectory: boolean }[]
    try {
      contents = await deps.fs.readdir(directory)
    } catch (cause) {
      deps.onLog?.('warn', 'dossier des enregistrements illisible', {
        path: directory,
        message: (cause as Error).message,
      })
      return
    }

    for (const entry of contents) {
      const path = join(directory, entry.name)
      if (entry.isDirectory) {
        if (depth < MAX_DEPTH) await scan(path, depth + 1)
        continue
      }
      if (!EXTENSIONS.has(extname(entry.name).toLowerCase())) continue

      const stat = await deps.fs.stat(path)
      if (stat == null) continue

      const key = normalize(relative(root, path))
      entries.push({
        file: key,
        sizeBytes: stat.size,
        modifiedAtMs: stat.mtimeMs,
        beingWritten: beingWritten(deps, stat),
        sidecar: await readSidecar(deps, path),
        check: checkStillValid(checks[key], stat),
      })
    }
  }

  await scan(root, 1)
  entries.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
  return entries
}

/**
 * Checks a file and keeps the verdict.
 *
 * The order of the rules matters: what forbids using the file comes before what
 * only makes it doubtful, and the first reason displayed is the one that explains
 * the badge.
 */
export async function inspectRecording(
  deps: VodIndexDeps,
  file: string,
): Promise<VodCheck> {
  const root = resolve(deps.root)
  const path = pathUnder(root, file)
  const stat = await deps.fs.stat(path)
  const at = new Date(deps.now()).toISOString()

  if (stat == null || stat.size === 0) {
    const check: VodCheck = {
      status: 'illisible',
      at,
      by: 'auto',
      reasons: [stat == null ? 'fichier absent du disque' : 'fichier vide : OBS n’a rien écrit'],
      probe: null,
    }
    await remember(deps, root, file, check)
    return check
  }

  /**
   * A take in progress is not judged, and we stop there.
   *
   * The check carried on, and what it returned was true but misleading: the
   * sidecar is only written at the stop, so "sidecar missing" is certain; the
   * bitrate is computed on a half-written file, so "picture probably unusable" is
   * too. Three reasons for a single cause, the first of which — the only one that
   * explains the other two — was read in the middle of the others.
   *
   * No probe either: opening with ffprobe the container OBS is writing into costs
   * I/O on the master's disk, mid-capture, for a read that will be wrong anyway.
   */
  if (beingWritten(deps, stat)) {
    const check: VodCheck = {
      status: 'suspect',
      at,
      by: 'auto',
      reasons: ['prise en cours : à contrôler une fois l’enregistrement arrêté'],
      probe: null,
      fichier: { sizeBytes: stat.size, modifiedAtMs: stat.mtimeMs },
    }
    await remember(deps, root, file, check)
    return check
  }

  const reasons: string[] = []
  let status: VodVerdict = 'ok'
  const downgrade = (to: VodVerdict, reason: string): void => {
    reasons.push(reason)
    if (to === 'illisible' || status === 'ok') status = to
  }

  const sidecar = await readSidecar(deps, path)
  if (sidecar == null) {
    downgrade('suspect', 'sidecar absent : titre, intervenants et marqueurs manquent au montage')
  }

  const probe = deps.probe == null ? null : await deps.probe(path)
  if (probe == null) {
    reasons.push('sonde ffprobe indisponible : contrôle limité à la taille et au sidecar')
  } else if (!probe.ouvert) {
    // A single reason, and the right one: detailing the tracks of a file ffprobe
    // refuses to open would send one looking in the wrong place.
    downgrade('illisible', 'conteneur illisible : ffprobe ne reconnaît pas ce fichier')
  } else {
    if (probe.video == null) downgrade('illisible', 'aucune piste vidéo dans le conteneur')
    if (probe.audio == null) downgrade('illisible', 'aucune piste audio : la VOD serait muette')
    if (probe.durationMs == null) {
      downgrade('illisible', 'durée illisible : conteneur tronqué, OBS a probablement été tué')
    } else if (probe.durationMs < 5_000) {
      downgrade('suspect', 'moins de cinq secondes de contenu')
    }
  }

  // What the control app's stopwatch said, against what the file contains. The
  // gap is the symptom of an abrupt stop, and it shows nowhere else.
  const expected = sidecar?.durationMs ?? null
  const actual = probe?.durationMs ?? null
  if (expected != null && actual != null && expected > 60_000 && actual < expected * 0.9) {
    downgrade(
      'suspect',
      `${minutes(actual)} enregistrées pour ${minutes(expected)} chronométrées : fin manquante`,
    )
  }

  const duration = actual ?? expected
  const bitrate = duration != null && duration > 1_000 ? Math.round((stat.size * 8) / duration) : null
  // On an unreadable container, the "bitrate" measures nothing: it is the file's
  // size divided by a duration that comes from elsewhere.
  if (bitrate != null && bitrate < 200 && probe?.ouvert !== false) {
    downgrade('suspect', `débit moyen de ${bitrate} kb/s : image probablement inexploitable`)
  }

  if (status === 'ok' && reasons.length === 0) {
    reasons.push(
      probe == null
        ? 'taille et sidecar cohérents'
        : `${probe.video?.width ?? '?'}×${probe.video?.height ?? '?'}, ${probe.audio?.channels ?? '?'} canal(aux), ${minutes(actual ?? 0)}`,
    )
  }

  const check: VodCheck = {
    status,
    at,
    by: 'auto',
    reasons,
    probe: probe == null ? null : { ...probe, bitrateKbps: probe.bitrateKbps ?? bitrate },
    fichier: { sizeBytes: stat.size, modifiedAtMs: stat.mtimeMs },
  }
  await remember(deps, root, file, check)
  return check
}

/**
 * A verdict placed by hand.
 *
 * The last word goes to whoever opened the file: no probe says whether the camera
 * was on the wrong shot or the microphone in a pocket. `null` clears the check and
 * puts the row back to "to be verified".
 */
export async function setVerdict(
  deps: VodIndexDeps,
  file: string,
  status: VodVerdict | null,
): Promise<VodCheck | null> {
  const root = resolve(deps.root)
  const path = pathUnder(root, file)
  if (status == null) {
    await remember(deps, root, file, null)
    return null
  }

  const previous = (await readChecks(deps, root))[file] ?? null
  const stat = await deps.fs.stat(path)
  const check: VodCheck = {
    status,
    at: new Date(deps.now()).toISOString(),
    by: 'operateur',
    reasons: [status === 'ok' ? 'relu en régie' : 'signalé en régie'],
    // What the probe had read stays displayed: the human verdict completes it, it
    // does not erase it.
    probe: previous?.probe ?? null,
    // Stamped like the automatic verdict: "reviewed in the control room" must not
    // outlive the take that was reviewed.
    fichier: stat == null ? undefined : { sizeBytes: stat.size, modifiedAtMs: stat.mtimeMs },
  }
  await remember(deps, root, file, check)
  return check
}

/** Writes the verdict into the index. `null` removes it. */
async function remember(
  deps: VodIndexDeps,
  root: string,
  file: string,
  check: VodCheck | null,
): Promise<void> {
  const checks = await readChecks(deps, root)
  if (check == null) delete checks[file]
  else checks[file] = check

  try {
    await deps.fs.writeFile(
      join(root, CHECKS_FILE),
      JSON.stringify({ version: 1, entries: checks }, null, 2),
    )
  } catch (cause) {
    // The verdict comes back on screen anyway: losing the trace on reload beats
    // making one believe the check did not happen.
    deps.onLog?.('warn', 'verdicts de contrôle non écrits sur le disque', {
      message: (cause as Error).message,
    })
  }
}

async function readChecks(
  deps: VodIndexDeps,
  root: string,
): Promise<Record<string, VodCheck>> {
  const raw = await deps.fs.readFile(join(root, CHECKS_FILE)).catch(() => null)
  if (raw == null) return {}
  try {
    const body = JSON.parse(raw) as { entries?: Record<string, VodCheck> }
    return body.entries ?? {}
  } catch {
    return {}
  }
}

/**
 * Is OBS still writing into it?
 *
 * On the modification date, and on the **machine's** time: both come from the
 * same file system. Recognizing the take in progress by its name along the way
 * was tried and removed — the format dictated to OBS depends only on the talk, so
 * a second take of the same talk carries the first one's name, and the first one,
 * finished, ended up marked as being written.
 */
function beingWritten(deps: VodIndexDeps, stat: { mtimeMs: number }): boolean {
  const now = (deps.realNow ?? Date.now)()
  return now - stat.mtimeMs < WRITE_WINDOW_MS
}

/**
 * Does the verdict still describe the file that is there?
 *
 * A master's name gets reused: the format asked of OBS is deterministic — date,
 * room, time, title — so replaying the same talk rewrites in the same place. The
 * previous take's verdict then showed on the new one, with the old one's ffprobe
 * read: "sidecar missing" on a rush that did have its own, and a duration that was
 * not its own.
 *
 * The size and the modification date are enough to decide — and that is
 * deliberately strict: a file rewritten to the byte and to the second does not
 * exist here, whereas a verdict outliving its take does.
 *
 * With no fingerprint — a verdict written before that field existed — we can claim
 * nothing: the row goes back to "not verified" rather than showing a judgement
 * whose subject is unknown.
 */
function checkStillValid(
  check: VodCheck | undefined,
  stat: { size: number; mtimeMs: number },
): VodCheck | null {
  if (check == null) return null
  const fingerprint = check.fichier
  if (fingerprint == null) return null
  if (fingerprint.sizeBytes !== stat.size || fingerprint.modifiedAtMs !== stat.mtimeMs) return null
  return check
}

async function readSidecar(deps: VodIndexDeps, videoPath: string): Promise<Sidecar | null> {
  const path = videoPath.slice(0, videoPath.length - extname(videoPath).length) + '.json'
  const raw = await deps.fs.readFile(path).catch(() => null)
  if (raw == null) return null
  try {
    return JSON.parse(raw) as Sidecar
  } catch {
    return null
  }
}

/**
 * Resolves a name coming from the page under the root, and refuses everything
 * else.
 *
 * The control page is served over HTTP on the machine: a `..` in the file's name
 * would get out of the captures folder.
 */
export function pathUnder(root: string, file: string): string {
  const path = resolve(root, file)
  if (path === root || !path.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new Error('Fichier hors du dossier des enregistrements')
  }
  return path
}

const normalize = (path: string): string => path.split(sep).join('/')

const minutes = (ms: number): string => {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`
}

/**
 * An excerpt playable in the browser, produced on the fly.
 *
 * `stop` counts as much as the stream: a control app that closes the modal must
 * not leave an ffmpeg running on the machine that is recording.
 */
export interface Excerpt {
  stream: Readable
  stop(): void
}

/** A rush served as it is, possibly by range. */
export interface FileStream {
  stream: Readable
  /** The file's total size, whether we serve all of it or a range. */
  size: number
  start: number
  end: number
  type: string
}

const TYPES: Record<string, string> = {
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.mpegts': 'video/mp2t',
}

/**
 * The codecs one can repackage into MP4 without re-encoding.
 *
 * The normal case for OBS's rushes, and it changes everything: repackaging costs
 * a few milliseconds, re-encoding mobilizes the processor of the machine that is
 * precisely recording the next talk.
 */
const COPYABLE = { video: new Set(['h264', 'hevc']), audio: new Set(['aac', 'mp3']) }

/** What an external tool answered, kept for the session. */
const tools = new Map<string, Promise<boolean>>()

/**
 * The presence of an external tool, asked once.
 *
 * Neither ffmpeg nor ffprobe is a dependency of the machine: they come with most
 * OBS installations, and not with all of them. The page must be able to say so in
 * advance rather than display a player that will never start.
 */
export async function toolAvailable(command: string): Promise<boolean> {
  const known = tools.get(command)
  if (known != null) return await known

  const probe = (async () => {
    const { execFile } = await import('node:child_process')
    return await new Promise<boolean>((done) => {
      execFile(command, ['-version'], { timeout: 5_000, windowsHide: true }, (error) =>
        done(error == null),
      )
    })
  })()
  tools.set(command, probe)
  return await probe
}

/**
 * A few seconds' excerpt, as fragmented MP4.
 *
 * Fragmented, so playable while it is being written: the browser does not wait
 * for the end of the file to show a picture. That is what makes it possible to
 * serve a Matroska — which no browser knows how to open — to an ordinary
 * `<video>`, without writing anything to disk.
 *
 * `null` means "ffmpeg absent": the page says so, it does not pretend.
 */
export async function openExcerpt(
  deps: VodIndexDeps,
  file: string,
  options: { atMs?: number; durationMs?: number; command?: string } = {},
): Promise<Excerpt | null> {
  const command = options.command ?? 'ffmpeg'
  if (!(await toolAvailable(command))) return null

  const path = pathUnder(resolve(deps.root), file)
  if ((await deps.fs.stat(path)) == null) throw new Error('Fichier absent du disque')

  const start = Math.max(0, Math.round((options.atMs ?? 0) / 1000))
  const duration = Math.min(120, Math.max(5, Math.round((options.durationMs ?? 20_000) / 1000)))

  const probed = deps.probe == null ? null : await deps.probe(path)
  const copyable =
    probed != null &&
    probed.video != null &&
    probed.audio != null &&
    COPYABLE.video.has(probed.video.codec) &&
    COPYABLE.audio.has(probed.audio.codec)

  const output = copyable
    ? ['-c', 'copy']
    : // The fallback: small, fast, and enough to answer "is there a picture and
      // some sound". Nobody edits from this preview.
      ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-vf', 'scale=-2:480', '-c:a', 'aac', '-b:a', '96k']

  const { spawn } = await import('node:child_process')
  const child = spawn(
    command,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      // `-ss` before `-i`: ffmpeg jumps straight to the nearest keyframe instead
      // of decoding two hours to keep twenty seconds.
      '-ss',
      String(start),
      '-i',
      path,
      '-t',
      String(duration),
      ...output,
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      'pipe:1',
    ],
    { windowsHide: true },
  )

  let errors = ''
  child.stderr.on('data', (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-2_000)
  })
  child.on('close', (code) => {
    if (code !== 0 && code != null) {
      deps.onLog?.('warn', 'aperçu VOD interrompu', { file, code, message: errors.trim() })
    }
  })
  child.on('error', (cause) => {
    deps.onLog?.('warn', 'aperçu VOD impossible', { file, message: (cause as Error).message })
    child.stdout.destroy()
  })

  return {
    stream: child.stdout,
    stop: () => {
      child.kill('SIGKILL')
    },
  }
}

/**
 * The rush itself, possibly by range.
 *
 * Used to open it in a player that does know how to read Matroska — or to fetch
 * it onto another machine, which the modal will never replace. The ranges
 * (`Range`) are what makes a three-gigabyte file navigable instead of downloading
 * whole before the first frame.
 */
export async function openFile(
  deps: VodIndexDeps,
  file: string,
  range?: string | null,
): Promise<FileStream | null> {
  const path = pathUnder(resolve(deps.root), file)
  const stat = await deps.fs.stat(path)
  if (stat == null) return null

  let start = 0
  let end = Math.max(0, stat.size - 1)
  const requested = /^bytes=(\d*)-(\d*)$/.exec((range ?? '').trim())
  if (requested != null && stat.size > 0) {
    const [, first, last] = requested
    if (first !== '') {
      start = Math.min(Number(first), end)
      if (last !== '') end = Math.min(Number(last), end)
    } else if (last !== '') {
      // `bytes=-500`: the last five hundred bytes, which is what the players ask
      // for to go and fetch the index at the end of the container.
      start = Math.max(0, stat.size - Number(last))
    }
  }

  return {
    stream: createReadStream(path, { start, end }),
    size: stat.size,
    start,
    end,
    type: TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
  }
}

/** Real disk access. Injected, so replaceable in a test. */
export function nodeVodFs(): VodFs {
  return {
    async readdir(path: string) {
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(path, { withFileTypes: true })
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
    },
    async stat(path: string) {
      const { stat } = await import('node:fs/promises')
      return stat(path).then(
        (info) => ({ size: info.size, mtimeMs: info.mtimeMs }),
        () => null,
      )
    },
    async readFile(path: string) {
      const { readFile } = await import('node:fs/promises')
      return readFile(path, 'utf8').then(
        (contents) => contents,
        () => null,
      )
    },
    async writeFile(path: string, contents: string) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(path, contents, 'utf8')
    },
  }
}

/**
 * Probes the container with ffprobe.
 *
 * ffprobe is not a dependency of the machine: it comes with OBS on most
 * installations, and not at all on others. Its absence is therefore not an error
 * — it reduces the check, and the control app says so rather than pretending to
 * have looked.
 */
export function ffprobeProbe(command = 'ffprobe') {
  return async (path: string): Promise<VodProbe | null> => {
    const { execFile } = await import('node:child_process')
    const result = await new Promise<{ error: ProcessFailure | null; stdout: string }>((resolve) => {
      execFile(
        command,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
        { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error, stdout) => resolve({ error: error as ProcessFailure | null, stdout }),
      )
    })

    /**
     * Telling "the tool did not answer" from "the file is bad".
     *
     * Only one case accuses the file: ffprobe went all the way and returned a
     * non-zero exit code — `code` is then a **number**. A binary absent or not
     * executable, a timeout, an output too large: `code` is a string or the process
     * was killed, and we know nothing about the file. Confusing the two would
     * accuse an intact rush because the machine did not have ffprobe — exactly the
     * diagnostic error this check is meant to avoid.
     */
    const error = result.error
    if (error != null) {
      const refusedByFfprobe = typeof error.code === 'number' && error.killed !== true
      return refusedByFfprobe ? CONTAINER_REFUSED : null
    }

    try {
      return parseFfprobeOutput(result.stdout)
    } catch {
      return CONTAINER_REFUSED
    }
  }
}

/** What `execFile` returns on failure: an exit code **or** a system code. */
interface ProcessFailure extends Error {
  code?: number | string
  killed?: boolean
}

/** ffprobe ran fine, and recognized nothing in the file. */
const CONTAINER_REFUSED: VodProbe = {
  ouvert: false,
  durationMs: null,
  video: null,
  audio: null,
  bitrateKbps: null,
}

/** Extracts from ffprobe's output the only things that decide the verdict. */
export function parseFfprobeOutput(raw: string): VodProbe {
  const body = JSON.parse(raw) as {
    streams?: {
      codec_type?: string
      codec_name?: string
      width?: number
      height?: number
      channels?: number
      avg_frame_rate?: string
      duration?: string
    }[]
    format?: { duration?: string; bit_rate?: string }
  }

  const streams = body.streams ?? []
  const video = streams.find((track) => track.codec_type === 'video')
  const audio = streams.find((track) => track.codec_type === 'audio')

  // The container's duration is missing on Matroska written as a stream: the video
  // track's then answers, and that is precisely the case of OBS's rushes.
  const duration = numberOf(body.format?.duration) ?? numberOf(video?.duration) ?? null

  return {
    ouvert: true,
    durationMs: duration == null ? null : Math.round(duration * 1000),
    video:
      video == null
        ? null
        : {
            codec: video.codec_name ?? 'inconnu',
            width: video.width ?? 0,
            height: video.height ?? 0,
            fps: fraction(video.avg_frame_rate),
          },
    audio: audio == null ? null : { codec: audio.codec_name ?? 'inconnu', channels: audio.channels ?? 0 },
    bitrateKbps: (() => {
      const bits = numberOf(body.format?.bit_rate)
      return bits == null ? null : Math.round(bits / 1000)
    })(),
  }
}

const numberOf = (value: string | undefined): number | null => {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const fraction = (value: string | undefined): number | null => {
  if (value == null) return null
  const [top, bottom] = value.split('/')
  const numerator = Number(top)
  const denominator = bottom == null ? 1 : Number(bottom)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null
  const fps = numerator / denominator
  return fps > 0 ? Math.round(fps * 100) / 100 : null
}
