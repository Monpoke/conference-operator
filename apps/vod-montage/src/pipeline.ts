import { join } from 'node:path'
import type { MontageAudio, MontageCoupe, Sidecar, VodHabillage, MontageSortie } from '@conference-operator/contract'
import { analyser, audioReport, prepareTake, type Regie } from './analyse.js'
import { DEFAULT_AUDIO, measureLoudness, talkAudioChain, type AudioOptions, type Loudness } from './audio.js'
import type { Chrome } from './chrome.js'
import { renderCadre } from './cadre.js'
import { runWithProgress } from './ffmpeg.js'
import { inlineImages } from './images.js'
import { themeForCapture } from './theme.js'
import { assembledMs, assemblyArgs, sortieFormat } from './montage.js'
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
  /** Loudness and filters of the talk's sound. */
  audio?: AudioOptions
  /** The published format, from the console. Absent: the take's own. */
  sortie?: MontageSortie
  /** The speakers were corrected: their card is drawn again over the rush's. */
  cadre?: { salle: string | null } | null
  /**
   * The cut to edit on — validated in the console. Absent: analysed here,
   * from the marks (then the room's buttons, then the words heard).
   */
  coupe?: MontageCoupe | null
  /** The room's « Commencer » / « Terminer », for a take without marks. */
  regie?: Regie | null
  onStep?: (etape: Etape, fraction: number) => void
  log?: (message: string) => void
}

export interface MontageResult {
  output: string
  durationMs: number
  /** The marks that were missing: the talk was then cut from another source on that side. */
  missingMarks: ('debut' | 'fin')[]
  coupe: MontageCoupe
  /** `null`: a take without a sound track. */
  audio: MontageAudio | null
}

/** The intro and outro only, in the default format — the CLI's first use. */
export async function renderClips(options: {
  chrome: Chrome
  habillage: VodHabillage
  jingle: string | null
  workDir: string
  format?: ClipFormat
  lufs?: number
  log?: (message: string) => void
}): Promise<{ intro: { file: string; durationMs: number }; outro: { file: string; durationMs: number } }> {
  const log = options.log ?? (() => {})
  const habillage = await inlineImages(options.habillage, (ref, error) =>
    log(`image illisible, remplacée par le nom : ${ref} (${error instanceof Error ? error.message : String(error)})`))
  const theme = await themeForCapture(options.habillage.theme, options.workDir, (error) =>
    log(`thème illisible, clips au thème par défaut (${error instanceof Error ? error.message : String(error)})`))
  const format = options.format ?? DEFAULT_FORMAT
  const intro = join(options.workDir, 'intro.mp4')
  const outro = join(options.workDir, 'outro.mp4')
  const i = await renderClip({ chrome: options.chrome, clip: 'intro', habillage, theme, format, jingle: options.jingle, lufs: options.lufs, output: intro, workDir: options.workDir })
  const o = await renderClip({ chrome: options.chrome, clip: 'outro', habillage, theme, format, jingle: null, output: outro, workDir: options.workDir })
  return { intro: { file: intro, durationMs: i.durationMs }, outro: { file: outro, durationMs: o.durationMs } }
}

/**
 * One talk, from its take to the published video.
 *
 * The clips are rendered in the take's own format (size, cadence, sample rate),
 * so the assembly converts nothing but the cut — and the talk's sound, brought
 * to the same loudness as its jingle.
 */
export async function monter(options: MontageOptions): Promise<MontageResult> {
  const log = options.log ?? (() => {})
  const step = options.onStep ?? (() => {})
  const audioOptions = options.audio ?? DEFAULT_AUDIO

  // The cut: validated in the console, or analysed here. The loudness is
  // measured on the cut actually kept — a cut moved by hand is measured again.
  let take: Awaited<ReturnType<typeof prepareTake>>
  let coupe: MontageCoupe
  let loudness: Loudness | null
  if (options.coupe != null) {
    take = await prepareTake(options.sidecar, options.folder)
    coupe = options.coupe
    loudness = take.hasAudio ? await measureLoudness(take.segments, coupe.debutMs, coupe.finMs, audioOptions) : null
  } else {
    const analysed = await analyser({
      sidecar: options.sidecar, folder: options.folder, audio: audioOptions, scratchDir: options.workDir, regie: options.regie, log,
    })
    take = analysed
    coupe = analysed.coupe
    loudness = analysed.loudness
    for (const raison of analysed.raisons) log(raison)
  }
  const audio = loudness == null ? null : audioReport(loudness, audioOptions)
  const format = options.sortie == null ? take.format : sortieFormat(take.format, options.sortie)

  const habillage = await inlineImages(options.habillage, (ref, error) =>
    log(`image illisible, remplacée par le nom : ${ref} (${error instanceof Error ? error.message : String(error)})`))

  const theme = await themeForCapture(options.habillage.theme, options.workDir, (error) =>
    log(`thème illisible, clips au thème par défaut (${error instanceof Error ? error.message : String(error)})`))

  const introFile = join(options.workDir, 'intro.mp4')
  const outroFile = join(options.workDir, 'outro.mp4')
  step('intro', 0)
  const intro = await renderClip({
    chrome: options.chrome, clip: 'intro', habillage, theme, format, jingle: options.jingle, lufs: audioOptions.lufs, output: introFile,
    workDir: options.workDir, onProgress: (f) => step('intro', f),
  })
  step('outro', 0)
  const outro = await renderClip({
    chrome: options.chrome, clip: 'outro', habillage, theme, format, jingle: null, output: outroFile,
    workDir: options.workDir, onProgress: (f) => step('outro', f),
  })

  const cadre = options.cadre == null
    ? undefined
    : await renderCadre({ chrome: options.chrome, habillage, salle: options.cadre.salle, theme, takeWidth: take.format.width, workDir: options.workDir })

  step('assemblage', 0)
  const plan = {
    crf: options.sortie?.crf,
    intro: { file: introFile, durationMs: intro.durationMs },
    take: {
      files: take.segments.map((segment) => segment.path),
      hasAudio: take.hasAudio,
      startMs: coupe.debutMs,
      endMs: coupe.finMs,
      audioFilter: take.hasAudio ? talkAudioChain(audioOptions, loudness) : undefined,
      cadre,
    },
    outro: { file: outroFile, durationMs: outro.durationMs },
    format,
    output: options.output,
  }
  log(`coupe ${fmt(coupe.debutMs)} → ${fmt(coupe.finMs)}, ${format.width}×${format.height} à ${format.fps} i/s` +
    (audio == null ? ', sans son' : `, son ${audio.lufsAvant.toFixed(1)} → ${audio.lufsApres ?? audio.lufsAvant.toFixed(1)} LUFS`))
  await runWithProgress(assemblyArgs(plan), assembledMs(plan), (fraction) => step('assemblage', fraction))
  step('assemblage', 1)
  const missingMarks = (['debut', 'fin'] as const).filter((which) => coupe[which].source !== 'marque')
  return { output: options.output, durationMs: assembledMs(plan), missingMarks, coupe, audio }
}

const fmt = (ms: number) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export { DEFAULT_FORMAT }
