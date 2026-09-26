import type { Sidecar } from '@conference-operator/contract'
import { FFPROBE, output } from './ffmpeg.js'
import type { ClipFormat } from './rendu.js'

/** What ffprobe says of a file, as far as the assembly needs it. */
export interface Probe {
  durationMs: number
  format: ClipFormat
  hasAudio: boolean
}

export async function probe(file: string): Promise<Probe> {
  const json = JSON.parse(await output(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ])) as {
    format?: { duration?: string }
    streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; sample_rate?: string }[]
  }
  const video = json.streams?.find((s) => s.codec_type === 'video')
  const audio = json.streams?.find((s) => s.codec_type === 'audio')
  if (video?.width == null || video.height == null) throw new Error(`${file} : pas de piste vidéo`)
  const fps = usableFps(video.avg_frame_rate) ?? usableFps(video.r_frame_rate) ?? '30'
  return {
    durationMs: Math.round(Number(json.format?.duration ?? 0) * 1000),
    format: {
      width: even(video.width),
      height: even(video.height),
      fps,
      sampleRate: Number(audio?.sample_rate) || 48_000,
    },
    hasAudio: audio != null,
  }
}

/** `0/0` is ffprobe for "unknown"; a variable-rate capture reports its average. */
function usableFps(rate: string | undefined): string | null {
  if (rate == null) return null
  const [num, den] = rate.split('/').map(Number)
  if (!num || !den) return null
  const value = num / den
  if (value < 10 || value > 120) return null
  // OBS writes 30 as 30/1, 29.97 as 30000/1001: both kept as they are.
  return rate.endsWith('/1') ? String(num) : rate
}

const even = (n: number) => n - (n % 2)

/** The take's files, in order, with where each starts in the take. */
export interface TakeFile {
  file: string
  offsetMs: number
}

export function takeFiles(sidecar: Pick<Sidecar, 'videoFile' | 'segments'>): TakeFile[] {
  if (sidecar.segments != null && sidecar.segments.length > 0) {
    return [...sidecar.segments].sort((a, b) => a.offsetMs - b.offsetMs).map((s) => ({ file: s.file, offsetMs: s.offsetMs }))
  }
  if (sidecar.videoFile == null) throw new Error('Le sidecar ne nomme aucun fichier vidéo')
  return [{ file: sidecar.videoFile, offsetMs: 0 }]
}

/**
 * Where the published talk starts and ends in the take.
 *
 * The operator's two marks when they are set. A mark missing gives the take's
 * edge instead, and says so: cutting by silence detection on a room microphone
 * that never really goes quiet would risk the first words — a longer video is
 * the safer default, and the console shows the take as « sans marques ».
 */
export function cutFromMarkers(
  sidecar: Pick<Sidecar, 'markers'>,
  takeMs: number,
): { startMs: number; endMs: number; missing: ('debut' | 'fin')[] } {
  // The last one set wins: an operator who marks again is correcting the first.
  const last = (role: 'debut' | 'fin') =>
    sidecar.markers.filter((m) => m.role === role).at(-1)
  const debut = last('debut')
  const fin = last('fin')
  const missing: ('debut' | 'fin')[] = []
  let startMs = debut?.offsetMs ?? 0
  let endMs = fin?.offsetMs ?? takeMs
  if (debut == null) missing.push('debut')
  if (fin == null) missing.push('fin')
  // A « fin » set before the « début » (a mis-click) is not a cut: the whole take.
  if (endMs <= startMs) {
    startMs = 0
    endMs = takeMs
    if (!missing.includes('debut')) missing.push('debut')
    if (!missing.includes('fin')) missing.push('fin')
  }
  return { startMs: Math.max(0, startMs), endMs: Math.min(takeMs, endMs), missing }
}

/** The crossfade between the three pieces, in seconds. */
export const CROSSFADE_S = 0.5

export interface AssemblyPlan {
  intro: { file: string; durationMs: number }
  /** The take's files, in order; the cut is in the take's own time. */
  take: { files: string[]; hasAudio: boolean; startMs: number; endMs: number }
  outro: { file: string; durationMs: number }
  format: ClipFormat
  output: string
}

/**
 * ffmpeg's arguments for the published video: intro, the talk cut on its
 * marks, outro, crossfaded.
 *
 * Every piece is brought to one picture and one sound — size, cadence, time
 * base, sample rate — because `xfade` refuses to join two that differ, and a
 * take split by OBS is joined first (`concat`), then cut, in the take's time
 * as the markers are. Pure, to be tested.
 */
export function assemblyArgs(plan: AssemblyPlan): string[] {
  const { format, take } = plan
  const s = (ms: number) => (ms / 1000).toFixed(3)
  const n = take.files.length
  const video = `scale=${format.width}:${format.height}:force_original_aspect_ratio=decrease,` +
    `pad=${format.width}:${format.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${format.fps},format=yuv420p,settb=AVTB`
  const audio = `aresample=${format.sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,asettb=AVTB`

  const inputs = ['-i', plan.intro.file, ...take.files.flatMap((file) => ['-i', file]), '-i', plan.outro.file]
  const outroIndex = n + 1
  const silenceIndex = n + 2
  if (!take.hasAudio) inputs.push('-f', 'lavfi', '-i', `anullsrc=r=${format.sampleRate}:cl=stereo`)

  const talkAudio = (i: number) => (take.hasAudio ? `[${i + 1}:a]` : `[${silenceIndex}:a]`)
  const filters: string[] = []
  if (n === 1) {
    filters.push(`[1:v]null[tv]`, `${talkAudio(0)}anull[ta]`)
  } else {
    // Without a sound track, the silence is only one input: it cannot be joined n times.
    if (take.hasAudio) {
      filters.push(`${take.files.map((_, i) => `[${i + 1}:v]${talkAudio(i)}`).join('')}concat=n=${n}:v=1:a=1[tv][ta]`)
    } else {
      filters.push(`${take.files.map((_, i) => `[${i + 1}:v]`).join('')}concat=n=${n}:v=1:a=0[tv]`, `[${silenceIndex}:a]anull[ta]`)
    }
  }
  const talkS = (take.endMs - take.startMs) / 1000
  filters.push(
    `[tv]trim=start=${s(take.startMs)}:end=${s(take.endMs)},setpts=PTS-STARTPTS,${video}[t_v]`,
    `[ta]atrim=start=${s(take.startMs)}:end=${s(take.endMs)},asetpts=PTS-STARTPTS,${audio}[t_a]`,
    `[0:v]${video}[i_v]`,
    `[0:a]${audio}[i_a]`,
    `[${outroIndex}:v]${video}[o_v]`,
    `[${outroIndex}:a]${audio}[o_a]`,
  )
  const introS = plan.intro.durationMs / 1000
  const first = introS - CROSSFADE_S
  const second = introS + talkS - 2 * CROSSFADE_S
  filters.push(
    `[i_v][t_v]xfade=transition=fade:duration=${CROSSFADE_S}:offset=${first.toFixed(3)}[it_v]`,
    `[it_v][o_v]xfade=transition=fade:duration=${CROSSFADE_S}:offset=${second.toFixed(3)}[v]`,
    `[i_a][t_a]acrossfade=d=${CROSSFADE_S}[it_a]`,
    `[it_a][o_a]acrossfade=d=${CROSSFADE_S}[a]`,
  )

  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', format.fps,
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(format.sampleRate), '-ac', '2',
    '-movflags', '+faststart',
    plan.output,
  ]
}

/** How long the published video lasts: the three pieces, less the two crossfades. */
export function assembledMs(plan: Pick<AssemblyPlan, 'intro' | 'take' | 'outro'>): number {
  return plan.intro.durationMs + (plan.take.endMs - plan.take.startMs) + plan.outro.durationMs - 2 * CROSSFADE_S * 1000
}
