import { basename, dirname, extname, join } from 'node:path'
import type { Session } from '@conference-operator/program'

import type {
  Marker,
  MarkerRole,
  EditingMarks,
  Sidecar,
  SidecarSegment,
} from '@conference-operator/contract'

export type { Marker, MarkerRole, EditingMarks, Sidecar, SidecarSegment }

export interface RecordingFs {
  rename(from: string, to: string): Promise<void>
  writeFile(path: string, contents: string): Promise<void>
  exists(path: string): Promise<boolean>
}

export interface RecordingDeps {
  /** Applies the file name format before `StartRecord`. */
  setFilenameFormat: (format: string) => Promise<void>
  startRecord: () => Promise<void>
  stopRecord: () => Promise<void>
  fs: RecordingFs
  /**
   * Where OBS writes its masters.
   *
   * Serves **only as a fallback**, when OBS has not announced the file produced.
   * The path it announces stays the source: it alone says what was really
   * written, including when the name format did not take.
   */
  recordingRoot?: () => Promise<string | null>
  now: () => number
  /** The clock corrected by the server offset: the timecodes depend on it. */
  correctedNow: () => number
  /**
   * Measure the duration on the corrected clock rather than on real time.
   * **Development only.**
   *
   * In production it is monotonic time that is authoritative, and it is the right
   * choice: a capture's duration must not move because the machine resynchronized
   * its clock in the middle of a talk. A fifty-minute talk lasts fifty minutes,
   * whatever `Date.now()` says.
   *
   * In development, the same rule makes the simulation illegible. There one runs
   * through a day by pushing the hub's clock — 09:00, start the capture, jump to
   * 09:50 to simulate the end — and the take announced "3 min", the time actually
   * spent in front of the screen, while the timeline showed a fifty-minute slot.
   * Both figures described the same recording and did not look alike.
   *
   * The start and the end already followed the corrected clock: only the duration
   * stayed on real time, and it is that disagreement this lifts.
   */
  followsClock?: boolean
  onLog?: (level: 'info' | 'warn' | 'error', message: string, context?: unknown) => void
}

/**
 * The containers OBS knows how to write, in the order we look for them.
 *
 * Used by the fallback: without the announced path, we know the expected name but
 * not the extension, which depends on OBS's output setting.
 */
const MASTER_EXTENSIONS = ['.mkv', '.mp4', '.mov', '.flv', '.ts', '.m4v', '.webm']

export interface StartInput {
  session: Session | null
  roomId: string | null
  /** The room's short label used in the file name (`track1`). */
  roomSlug: string
  timezone: string
}

export interface StopResult {
  sidecarPath: string | null
  /**
   * The take's first file — the one the sidecar sits next to.
   *
   * `null` when nothing could be located, and then no sidecar was written.
   */
  videoPath: string | null
  /**
   * Every file the take was written into, in order. One entry in the ordinary
   * case, several when OBS was set to split.
   */
  videoPaths: string[]
  sidecar: Sidecar
}

export interface StopOptions {
  /**
   * OBS has already stopped by itself: do not ask it again.
   *
   * The case of the operator who presses "Stop recording" in OBS rather than in
   * the control app. `StopRecord` on an already inactive output is an OBS error,
   * and that error would carry away all the rest of the stop — the sidecar first,
   * which is precisely what we came to save.
   *
   * False by default, and it has to stay that way: swallowing `StopRecord`'s
   * failure on the normal path would write the sidecar of a take still running.
   */
  alreadyStopped?: boolean
}

/**
 * Drives a talk's recording and produces its sidecar.
 *
 * The sidecar is what makes the editing and the upload nearly automatic after the
 * event — and it is written **locally**, so produced even if the hub is
 * unreachable all day.
 */
export class RecordingSession {
  private startedAtMs: number | null = null
  /** The same start, read on the corrected clock: the base of capture time in dev. */
  private startedAtCorrectedMs: number | null = null
  private startedAtIso: string | null = null
  private markers: Marker[] = []
  private input: StartInput | null = null
  /**
   * The files the take has been written into so far, in order.
   *
   * Fed by OBS as it goes — the start announces the first container, each split
   * announces the next. It is the only place they are known: the stop only ever
   * gives the last one, and the segments closed along the way would leave no
   * trace at all.
   */
  private segments: { path: string; offsetMs: number }[] = []
  /**
   * The file OBS announced between our `StartRecord` and the take becoming
   * active.
   *
   * A real OBS emits `RecordStateChanged` on the heels of the request, sometimes
   * before it has answered it — and that event carries the take's **first**
   * container, the one no later event ever names again. Refusing it because the
   * session was not active yet made every split take begin at its second file.
   *
   * Cleared at each start, before the request: what it holds can then only
   * concern the take being opened, never the previous one.
   */
  private announcedAtStart: string | null = null

  constructor(private readonly deps: RecordingDeps) {}

  get active(): boolean {
    return this.startedAtMs != null
  }

  /**
   * The chapter markers, the two editing markers excluded.
   *
   * That count is displayed in the control app right next to the state of the
   * markers: including the start and the end made "no marker" become
   * "2 marker(s)" without a single chapter having been placed, next to a line that
   * already said both markers were there.
   */
  get markerCount(): number {
    return this.markers.filter((marker) => marker.role == null).length
  }

  /** The start instant, for the stopwatch displayed in the control app. */
  get startedAt(): number | null {
    return this.startedAtMs
  }

  /**
   * The same start on the corrected clock — or `null` if it is not authoritative.
   *
   * A single field carrying both the value and the rule: `null` tells the control
   * app "count in real time", a number says "count on the hub's clock, the one
   * that can jump". Otherwise the stopwatch displayed during the take would keep
   * counting the minutes spent in front of the screen while the recorded duration
   * followed the simulated day — two figures for the same recording, again.
   */
  get correctedStartedAt(): number | null {
    return this.deps.followsClock === true ? this.startedAtCorrectedMs : null
  }

  /**
   * Starts the recording.
   *
   * The name format is set *before* `StartRecord`: OBS reads it at that moment. If
   * that fails, we do not cancel for all that — a badly named recording is
   * infinitely better than an unrecorded talk.
   */
  async start(input: StartInput): Promise<void> {
    if (this.active) throw new Error('Un enregistrement est déjà en cours')

    const format = buildFilenameFormat(input)
    try {
      await this.deps.setFilenameFormat(format)
    } catch (cause) {
      this.deps.onLog?.('warn', 'format de nom refusé par OBS, renommage au stop', {
        format,
        message: (cause as Error).message,
      })
    }

    this.announcedAtStart = null
    await this.deps.startRecord()
    this.startedAtMs = this.deps.now()
    const correctedStart = this.deps.correctedNow()
    this.startedAtCorrectedMs = correctedStart
    this.startedAtIso = new Date(correctedStart).toISOString()
    this.markers = []
    this.segments = this.announcedAtStart == null ? [] : [{ path: this.announcedAtStart, offsetMs: 0 }]
    this.announcedAtStart = null
    this.input = input
  }

  /**
   * OBS says the take is now being written into `path`.
   *
   * Called for the container announced at the start as well as for each split,
   * and that is why it takes the offset from the take's own stopwatch: a segment
   * is defined by where it begins in the talk, not by the order the events
   * happened to arrive in.
   *
   * Idempotent on the same path: a real OBS announces the start's file twice —
   * once on `RecordStateChanged`, once at the connection of an application that
   * adopts a capture already running — and counting it twice would invent a
   * zero-length segment right in the middle of the take.
   */
  noteSegment(path: string): void {
    if (path === '') return
    if (!this.active) {
      this.announcedAtStart = path
      return
    }
    if (this.segments.some((segment) => segment.path === path)) return
    this.segments.push({ path, offsetMs: this.elapsedMs() })
    if (this.segments.length > 1) {
      this.deps.onLog?.('info', 'la captation continue dans un nouveau fichier', {
        path,
        segment: this.segments.length,
      })
    }
  }

  /**
   * The time elapsed since the take began.
   *
   * Two clocks, one per mode. Monotonic time in production: a capture's duration
   * must not move because the machine resynchronized its clock in the middle of a
   * talk. The corrected clock in development: it is by pushing it that one runs
   * through a day there, and the take must follow what it says rather than the
   * time spent in front of the screen.
   *
   * Never negative. Moving the development clock back therefore brings the take
   * to zero — that is the accepted consequence of following it, and it beats a
   * negative duration that would break everything reading it downstream.
   */
  private elapsedMs(): number {
    if (this.startedAtMs == null) return 0
    if (this.deps.followsClock === true && this.startedAtCorrectedMs != null) {
      return Math.max(0, this.deps.correctedNow() - this.startedAtCorrectedMs)
    }
    return Math.max(0, this.deps.now() - this.startedAtMs)
  }

  /**
   * Places a marker at the current instant.
   *
   * `role` tells the two editing markers apart from an ordinary chapter, and they
   * do not behave the same: **placing a marker again replaces the previous one**.
   * It is the gesture one actually makes — one places the start again because the
   * speaker had a false start, one places the end again because the questions
   * resumed after what one thought was the closing word. Stacking two would leave
   * the editing, three weeks later, an arbitration only the control room could
   * settle, on the spot.
   *
   * The `debut` and `fin` role values are contract values.
   */
  mark(label: string, role: MarkerRole | null = null): Marker {
    if (this.startedAtMs == null) throw new Error('Aucun enregistrement en cours')
    const marker: Marker = {
      label,
      // The same clock as the duration: a marker placed after a clock jump must
      // fall in the same place as what the take claims to last.
      offsetMs: this.elapsedMs(),
      at: new Date(this.deps.correctedNow()).toISOString(),
      // The field does not appear on a chapter: a sidecar where every marker
      // carries `"role": null` would suggest a role one had erased.
      ...(role == null ? {} : { role }),
    }
    if (role != null) this.markers = this.markers.filter((placed) => placed.role !== role)
    this.markers.push(marker)
    /*
     * Sorted by offset, and not by the order they were placed in.
     *
     * The two coincide as long as one stacks, and diverge as soon as a marker is
     * placed again: a start moved to 2 min ended up behind the chapter at 1 min.
     * The sidecar is read by an editing that draws chapters from it — handing it a
     * list out of order amounts to asking it to repair over there what is sorted
     * here in one line.
     */
    this.markers.sort((a, b) => a.offsetMs - b.offsetMs)
    return marker
  }

  /**
   * Where the two markers fall, so that the control app can show them.
   *
   * The marker count did not answer the question one asks before stopping a take
   * — "did I place the start?" — since three markers can be three chapters.
   */
  get editing(): EditingMarks {
    const at = (role: MarkerRole): number | null =>
      this.markers.find((marker) => marker.role === role)?.offsetMs ?? null
    return { startMs: at('debut'), endMs: at('fin') }
  }

  /**
   * Stops the recording and writes the sidecar.
   *
   * `resolveOutputPath` is called **after** `StopRecord`, and that is essential:
   * OBS only announces the file's path in the `RecordStateChanged` event that
   * follows the stop. Reading it before would always give `null`, and no sidecar
   * would ever be written.
   *
   * That path says what OBS really wrote, the name format possibly not having
   * applied — but it says it **in the namespace of the machine running OBS**,
   * which is not always ours. See `resolveMaster`.
   */
  async stop(
    resolveOutputPath: () => Promise<string | null>,
    options: StopOptions = {},
  ): Promise<StopResult> {
    if (this.startedAtMs == null || this.input == null) {
      throw new Error('Aucun enregistrement en cours')
    }

    if (options.alreadyStopped !== true) await this.deps.stopRecord()
    const outputPath = await resolveOutputPath()
    const endedAtIso = new Date(this.deps.correctedNow()).toISOString()
    const durationMs = this.elapsedMs()
    const input = this.input
    const session = input.session

    // The file being written at the moment of the stop closes the list. On a take
    // OBS never split it is also the only one, and on a room whose OBS announces
    // nothing at the start it is all we have.
    if (outputPath != null) this.noteSegment(outputPath)

    const located = await this.locateSegments(input, durationMs)
    const renamed = await this.rename(located, input)
    const videoPath = renamed[0]?.path ?? null

    const sidecar: Sidecar = {
      sessionId: session?.id ?? null,
      title: session?.title ?? 'Sans titre',
      speakers: (session?.speakers ?? []).map((speaker) => ({
        name: speaker.name,
        company: speaker.company,
      })),
      roomId: input.roomId,
      trackTitle: session?.roomId ?? null,
      category: session?.category?.name ?? null,
      startedAt: this.startedAtIso!,
      endedAt: endedAtIso,
      durationMs,
      markers: this.markers,
      videoFile: videoPath == null ? null : basename(videoPath),
      /*
       * Only listed when the take really was split.
       *
       * A single-file take is the ordinary case, and its `segments: [the file]`
       * would say nothing `videoFile` does not already say — while forcing every
       * reader of the sidecars already on the rooms' disks to handle two shapes
       * for the same thing.
       */
      ...(renamed.length > 1
        ? {
            segments: renamed.map((segment) => ({
              file: basename(segment.path),
              offsetMs: segment.offsetMs,
              durationMs: segment.durationMs,
            })),
          }
        : {}),
    }

    let sidecarPath: string | null = null
    if (videoPath != null) {
      sidecarPath = videoPath.replace(new RegExp(`${escapeRegExp(extname(videoPath))}$`), '.json')
      try {
        await this.deps.fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2))
      } catch (cause) {
        this.deps.onLog?.('error', "sidecar non écrit : le montage devra être fait à la main", {
          path: sidecarPath,
          message: (cause as Error).message,
        })
        sidecarPath = null
      }
    } else {
      this.deps.onLog?.('warn', "OBS n'a pas rendu de chemin de sortie, aucun sidecar écrit")
    }

    this.startedAtMs = null
    this.startedAtCorrectedMs = null
    this.startedAtIso = null
    this.input = null
    this.segments = []
    return { sidecarPath, videoPath, videoPaths: renamed.map((segment) => segment.path), sidecar }
  }

  /**
   * The take's files, as **we** can open them, with their place in the take.
   *
   * A segment's duration is read from the next one's start, and the last one's
   * from the take's total: OBS says when it changes file, never how long the one
   * it just closed lasted. The figures are therefore those of the control room's
   * stopwatch, which is exactly what the check downstream wants to compare the
   * containers against.
   *
   * A segment we cannot locate is dropped rather than guessed at: a sidecar
   * naming a file that is not there would send editing looking for a piece of
   * talk that never existed under that name.
   */
  private async locateSegments(
    input: StartInput,
    totalMs: number,
  ): Promise<Segment[]> {
    const announced = this.segments
    const located: Segment[] = []

    for (const [index, segment] of announced.entries()) {
      const path = await this.locate(segment.path)
      if (path == null) {
        this.deps.onLog?.('warn', 'fichier annoncé par OBS introuvable sur le disque', {
          announced: segment.path,
        })
        continue
      }
      if (path !== segment.path) {
        this.deps.onLog?.('info', 'master retrouvé sous la racine des captations', {
          announced: segment.path,
          kept: path,
        })
      }
      located.push({
        path,
        offsetMs: segment.offsetMs,
        durationMs: Math.max(0, (announced[index + 1]?.offsetMs ?? totalMs) - segment.offsetMs),
      })
    }

    if (located.length > 0) return located

    // Nothing announced, or nothing announced that we can see: the name we
    // dictated to OBS is the last thing left to go on.
    const fallback = await this.fromExpectedName(input)
    if (fallback == null) return []
    this.deps.onLog?.('info', 'master retrouvé sous la racine des captations', {
      announced: announced[announced.length - 1]?.path ?? null,
      kept: fallback,
    })
    return [{ path: fallback, offsetMs: 0, durationMs: totalMs }]
  }

  /**
   * Brings the files back to the name we asked OBS for.
   *
   * Split, they are numbered — `…_01.mkv`, `…_02.mkv` — and that is the whole
   * point: OBS names the segments of a take by appending the `(2)` it uses
   * against collisions, which sorts badly and does not say whether the take has
   * two pieces or four. Picking up three SD cards at the end of the day, the
   * order of the pieces has to be readable without opening anything.
   *
   * A target that already exists is left alone: it is somebody else's file — most
   * often a first take of the same talk — and overwriting it would trade a badly
   * named recording for a lost one.
   */
  private async rename(segments: Segment[], input: StartInput): Promise<Segment[]> {
    const base = buildFilenameFormat(input)
    const renamed: Segment[] = []

    for (const [index, segment] of segments.entries()) {
      const suffix = segments.length > 1 ? `_${String(index + 1).padStart(2, '0')}` : ''
      const expected = base + suffix + extname(segment.path)
      const target = join(dirname(segment.path), expected)
      if (basename(segment.path) === expected || (await this.deps.fs.exists(target))) {
        renamed.push(segment)
        continue
      }
      try {
        await this.deps.fs.rename(segment.path, target)
        renamed.push({ ...segment, path: target })
      } catch (cause) {
        this.deps.onLog?.('warn', 'renommage impossible, chemin OBS conservé', {
          from: segment.path,
          message: (cause as Error).message,
        })
        renamed.push(segment)
      }
    }
    return renamed
  }

  /**
   * A file OBS announced, as **we** can open it.
   *
   * OBS announces a path in the namespace of the machine running it, and that is
   * not always ours. The case was seen in the open: OBS under Windows recording
   * into a WSL folder, and announcing
   * `//wsl.localhost/distro/home/…/take.mp4`. The file was indeed there, at a
   * perfectly ordinary Linux path; we wrote the sidecar next to a path that does
   * not exist on this side, the write failed, and every take of the day lost its
   * title, speakers and markers. The same happens with a network folder mounted
   * differently on the two machines.
   *
   * Two sources, in this order, and the order carries the meaning:
   *
   * 1. **The announced path, if it designates a file we can see.** It is by far
   *    the most common case — OBS and the room on the same machine — and it is the
   *    exact answer: it alone knows what was written.
   * 2. **The announced name, under the capture root.** OBS stays the source of the
   *    *name* — including the "(2)" it adds on a collision — but the *folder*
   *    comes from the room's setting, which is a path on our side.
   *
   * Cautious end to end: failing to find a container, we give up rather than
   * scatter an orphan sidecar into the captures folder.
   */
  private async locate(announced: string): Promise<string | null> {
    if (await this.deps.fs.exists(announced)) return announced

    const root = await this.root()
    if (root == null) return null

    const name = fileNameOf(announced)
    if (name === '') return null
    const candidate = join(root, name)
    return (await this.deps.fs.exists(candidate)) ? candidate : null
  }

  /**
   * The take found by the name we dictated to OBS, when it announced nothing.
   *
   * The last resort, and it only knows how to find a take in one piece: a split
   * one has files we never heard of, under names OBS chose alone. Better one
   * segment with its sidecar than a sidecar claiming a whole take it cannot
   * enumerate.
   */
  private async fromExpectedName(input: StartInput): Promise<string | null> {
    const root = await this.root()
    if (root == null) return null

    const expected = buildFilenameFormat(input)
    for (const extension of MASTER_EXTENSIONS) {
      const candidate = join(root, expected + extension)
      if (await this.deps.fs.exists(candidate)) return candidate
    }
    return null
  }

  private async root(): Promise<string | null> {
    try {
      return (await this.deps.recordingRoot?.()) ?? null
    } catch {
      return null
    }
  }
}

/** A located file of the take, and where it falls in it. */
interface Segment {
  path: string
  offsetMs: number
  durationMs: number
}

/**
 * The last segment of a path, whatever OS wrote it.
 *
 * Node's `basename` only knows the current platform's separator: under Linux it
 * returns `C:\prises\talk.mkv` whole, seeing no slash in it at all. Yet the path
 * we cut up here comes from **OBS's** machine, not from ours.
 */
function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * `2026-10-30_track1_1100_titre-du-talk`
 *
 * Sorted naturally by date and room, and readable without opening the file —
 * which counts when picking up three SD cards at the end of the day.
 */
export function buildFilenameFormat(input: StartInput): string {
  const session = input.session
  const reference = session?.startsAt ?? new Date().toISOString()
  const date = formatInTimezone(reference, input.timezone, { year: 'numeric', month: '2-digit', day: '2-digit' })
  const time = formatInTimezone(reference, input.timezone, { hour: '2-digit', minute: '2-digit' })

  const title = slugify(session?.title ?? 'sans-titre')
  return `${date}_${input.roomSlug}_${time}_${title}`
}

function formatInTimezone(iso: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  const parts = new Intl.DateTimeFormat('fr-FR', { ...options, timeZone }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  if (options.hour != null) return `${get('hour')}${get('minute')}`
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** No accents and no dubious characters: these files cross Windows, macOS and YouTube. */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '') || 'sans-titre'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
