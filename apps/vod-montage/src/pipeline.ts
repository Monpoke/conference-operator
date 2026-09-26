import { join } from 'node:path'
import type { Sidecar, VodHabillage } from '@conference-operator/contract'
import type { Chrome } from './chrome.js'
import { FFMPEG, run } from './ffmpeg.js'
import { inlineImages } from './images.js'
import { assembledMs, assemblyArgs, cutFromMarkers, probe, takeFiles } from './montage.js'
import { DEFAULT_FORMAT, renderClip, type ClipFormat } from './rendu.js'

/** Where a montage stands — what the hub shows in the console. */
export type Etape = 'telechargement' | 'intro' | 'outro' | 'assemblage' | 'envoi'

export interface MontageOptions {
  chrome: Chrome
  habillage: VodHabillage
  /** The take's sidecar, and the folder its files are in. */
  sidecar: Sidecar
  folder: string
  jingle: string | null
  workDir: string
  output: string
  onStep?: (etape: Etape, fraction: number) => void
  log?: (message: string) => void
}

export interface MontageResult {
  output: string
  durationMs: number
  /** The marks that were missing: the talk was then kept whole on that side. */
  missingMarks: ('debut' | 'fin')[]
}

/** The intro and outro only, in the default format — the CLI's first use. */
export async function renderClips(options: {
  chrome: Chrome
  habillage: VodHabillage
  jingle: string | null
  workDir: string
  format?: ClipFormat
  log?: (message: string) => void
}): Promise<{ intro: { file: string; durationMs: number }; outro: { file: string; durationMs: number } }> {
  const log = options.log ?? (() => {})
  const habillage = await inlineImages(options.habillage, (ref, error) =>
    log(`image illisible, remplacée par le nom : ${ref} (${error instanceof Error ? error.message : String(error)})`))
  const format = options.format ?? DEFAULT_FORMAT
  const intro = join(options.workDir, 'intro.mp4')
  const outro = join(options.workDir, 'outro.mp4')
  const i = await renderClip({ chrome: options.chrome, clip: 'intro', habillage, format, jingle: options.jingle, output: intro, workDir: options.workDir })
  const o = await renderClip({ chrome: options.chrome, clip: 'outro', habillage, format, jingle: null, output: outro, workDir: options.workDir })
  return { intro: { file: intro, durationMs: i.durationMs }, outro: { file: outro, durationMs: o.durationMs } }
}

/**
 * One talk, from its take to the published video.
 *
 * The clips are rendered in the take's own format (size, cadence, sample rate),
 * so the assembly converts nothing but the cut.
 */
export async function monter(options: MontageOptions): Promise<MontageResult> {
  const log = options.log ?? (() => {})
  const step = options.onStep ?? (() => {})
  const files = takeFiles(options.sidecar).map((f) => ({ ...f, path: join(options.folder, f.file) }))
  const probes = await Promise.all(files.map((f) => probe(f.path)))
  const first = probes[0]!
  const takeMs = files.length === 1
    ? first.durationMs
    : files.at(-1)!.offsetMs + probes.at(-1)!.durationMs
  const cut = cutFromMarkers(options.sidecar, takeMs)
  if (cut.missing.length > 0) log(`marques absentes (${cut.missing.join(', ')}) : prise gardée entière de ce côté`)

  const habillage = await inlineImages(options.habillage, (ref, error) =>
    log(`image illisible, remplacée par le nom : ${ref} (${error instanceof Error ? error.message : String(error)})`))
  const format = first.format

  const introFile = join(options.workDir, 'intro.mp4')
  const outroFile = join(options.workDir, 'outro.mp4')
  step('intro', 0)
  const intro = await renderClip({
    chrome: options.chrome, clip: 'intro', habillage, format, jingle: options.jingle, output: introFile,
    workDir: options.workDir, onProgress: (f) => step('intro', f),
  })
  step('outro', 0)
  const outro = await renderClip({
    chrome: options.chrome, clip: 'outro', habillage, format, jingle: null, output: outroFile,
    workDir: options.workDir, onProgress: (f) => step('outro', f),
  })

  step('assemblage', 0)
  const plan = {
    intro: { file: introFile, durationMs: intro.durationMs },
    take: { files: files.map((f) => f.path), hasAudio: probes.every((p) => p.hasAudio), startMs: cut.startMs, endMs: cut.endMs },
    outro: { file: outroFile, durationMs: outro.durationMs },
    format,
    output: options.output,
  }
  log(`coupe ${fmt(cut.startMs)} → ${fmt(cut.endMs)}, ${format.width}×${format.height} à ${format.fps} i/s`)
  await run(FFMPEG, assemblyArgs(plan))
  step('assemblage', 1)
  return { output: options.output, durationMs: assembledMs(plan), missingMarks: cut.missing }
}

const fmt = (ms: number) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export { DEFAULT_FORMAT }
