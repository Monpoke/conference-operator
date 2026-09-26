import { readFile, rm } from 'node:fs/promises'
import type { Frame } from './coupe.js'
import { FRAME_MS } from './coupe.js'
import { FFMPEG, run, stderrOf } from './ffmpeg.js'

/**
 * The talk's sound: measured, then brought to one loudness.
 *
 * Two passes, as EBU R128 asks: the first measures the kept part of the take,
 * the second applies one gain computed from it (`loudnorm` in linear mode). A
 * single dynamic pass would chase the level up and down — the room's hum
 * swelling under every pause. Every talk then plays as loud as the others, and
 * as loud as its jingle.
 */

/** One file of the take, where it sits in the take, and how long it lasts. */
export interface Segment {
  path: string
  offsetMs: number
  durationMs: number
}

export interface AudioOptions {
  /** Integrated loudness aimed at. -16: what YouTube plays back at. */
  lufs: number
  /** Highest true peak allowed. */
  truePeak: number
  /** Below this, rumble: air conditioning, a foot on the stand. 0 = off. */
  highpassHz: number
  /** `douce`: the audience's questions, far from the microphone, come up. */
  compression: 'non' | 'douce'
}

export const DEFAULT_AUDIO: AudioOptions = { lufs: -16, truePeak: -1.5, highpassHz: 80, compression: 'douce' }

/** Below this, there is no talk to bring up: a muted microphone, an empty track. */
export const NEAR_SILENT_LUFS = -50
const TARGET_LRA = 11

/** What `loudnorm` measured on the first pass. */
export interface Loudness {
  i: number
  tp: number
  lra: number
  thresh: number
  offset: number
}

/** `loudnorm`'s JSON report, the last `{…}` of ffmpeg's output. */
export function parseLoudnorm(stderr: string): Loudness {
  const start = stderr.lastIndexOf('{')
  const end = stderr.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('mesure du volume illisible : pas de rapport loudnorm')
  const report = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>
  const number = (key: string) => {
    const value = Number.parseFloat(report[key] ?? '')
    return Number.isFinite(value) ? value : -99
  }
  return {
    i: number('input_i'),
    tp: number('input_tp'),
    lra: number('input_lra'),
    thresh: number('input_thresh'),
    offset: number('target_offset'),
  }
}

/** What comes before the loudness: the same in both passes, or the measure lies. */
export function preChain(options: AudioOptions): string[] {
  const chain: string[] = []
  if (options.highpassHz > 0) chain.push(`highpass=f=${options.highpassHz}`)
  if (options.compression === 'douce') chain.push('acompressor=threshold=-24dB:ratio=2.5:attack=20:release=250')
  return chain
}

/**
 * Whether one gain is enough: the peaks, raised by the gain, stay under the
 * ceiling, and the range fits. Otherwise `loudnorm` falls back to riding the
 * level — said in the report, not silently.
 */
export function linearPossible(measured: Loudness, options: AudioOptions): boolean {
  return measured.tp + (options.lufs - measured.i) <= options.truePeak && measured.lra <= TARGET_LRA
}

/**
 * The talk's audio filters for the assembly: the pre-chain, then one gain.
 * `null` when the take is near silent — then nothing is brought up.
 */
export function talkAudioChain(options: AudioOptions, measured: Loudness | null): string {
  const chain = preChain(options)
  if (measured != null && measured.i > NEAR_SILENT_LUFS) {
    chain.push(
      `loudnorm=I=${options.lufs}:TP=${options.truePeak}:LRA=${TARGET_LRA}` +
        `:measured_I=${measured.i}:measured_TP=${measured.tp}:measured_LRA=${measured.lra}` +
        `:measured_thresh=${measured.thresh}:offset=${measured.offset}:linear=true`,
    )
  }
  return chain.join(',')
}

/**
 * Inputs reading only `[fromMs, toMs)` of the take, and the filter joining
 * their sound. Each file is sought into (`-ss` before `-i`): the end of a
 * two-hour take is read without decoding the two hours before it.
 */
export function windowInputs(segments: readonly Segment[], fromMs: number, toMs: number): { args: string[]; join: string } {
  const args: string[] = []
  let count = 0
  for (const segment of segments) {
    const start = Math.max(fromMs, segment.offsetMs)
    const end = Math.min(toMs, segment.offsetMs + segment.durationMs)
    if (end <= start) continue
    args.push('-ss', ((start - segment.offsetMs) / 1000).toFixed(3), '-t', ((end - start) / 1000).toFixed(3), '-i', segment.path)
    count += 1
  }
  if (count === 0) throw new Error(`rien à lire entre ${fromMs} et ${toMs} ms dans la prise`)
  const join = count === 1
    ? '[0:a]anull'
    : `${Array.from({ length: count }, (_, i) => `[${i}:a]`).join('')}concat=n=${count}:v=0:a=1`
  return { args, join }
}

/** First pass: the kept part's loudness, after the same pre-chain as the second. */
export async function measureLoudness(segments: readonly Segment[], fromMs: number, toMs: number, options: AudioOptions): Promise<Loudness> {
  const { args, join } = windowInputs(segments, fromMs, toMs)
  const chain = [...preChain(options), `loudnorm=I=${options.lufs}:TP=${options.truePeak}:LRA=${TARGET_LRA}:print_format=json`]
  const stderr = await stderrOf(FFMPEG, [
    '-hide_banner', '-nostats', '-loglevel', 'info', '-vn', ...args,
    '-filter_complex', `${join},${chain.join(',')}[a]`, '-map', '[a]', '-f', 'null', '-',
  ])
  return parseLoudnorm(stderr)
}

/** The level of every 50 ms of `[fromMs, toMs)`, in the take's time. */
export async function rmsFrames(segments: readonly Segment[], fromMs: number, toMs: number, scratch: string): Promise<Frame[]> {
  const { args, join } = windowInputs(segments, fromMs, toMs)
  const start = Math.max(0, fromMs)
  const samples = Math.round((48_000 * FRAME_MS) / 1000)
  await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error', '-vn', ...args,
    '-filter_complex',
    `${join},aresample=48000,aformat=channel_layouts=mono,asetnsamples=n=${samples}:p=0,` +
      `astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,` +
      `ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=${scratch.replace(/([\\:'])/g, '\\$1')}[a]`,
    '-map', '[a]', '-f', 'null', '-',
  ])
  const text = await readFile(scratch, 'utf8')
  await rm(scratch, { force: true })
  return parseFrames(text, start)
}

/** `ametadata`'s printout: a `pts_time` line, then the level, for every frame. */
export function parseFrames(text: string, startMs: number): Frame[] {
  const frames: Frame[] = []
  let time: number | null = null
  for (const line of text.split('\n')) {
    const at = /pts_time:([\d.]+)/.exec(line)
    if (at) {
      time = Number.parseFloat(at[1]!)
      continue
    }
    const level = /RMS_level=(-?[\d.]+|-inf|inf|nan)/.exec(line)
    if (level && time != null) {
      const db = Number.parseFloat(level[1]!)
      frames.push({ ms: Math.round(startMs + time * 1000), db: Number.isFinite(db) ? db : -120 })
      time = null
    }
  }
  return frames
}
