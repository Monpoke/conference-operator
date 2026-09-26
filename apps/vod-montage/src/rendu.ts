import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { VodClip, VodHabillage } from '@conference-operator/contract'
import { availableFonts, renderVodDocument, resolveFontsFolder } from '@conference-operator/projector/server'
import type { Chrome } from './chrome.js'
import { FFMPEG, start, write } from './ffmpeg.js'

/**
 * The picture and sound the clips are rendered in — the rush's, so that the
 * assembly joins three pieces of one format rather than converting two.
 */
export interface ClipFormat {
  width: number
  height: number
  /** As ffmpeg writes it: `30`, `25`, `30000/1001`. */
  fps: string
  sampleRate: number
}

export const DEFAULT_FORMAT: ClipFormat = { width: 1920, height: 1080, fps: '30', sampleRate: 48_000 }

/** `30000/1001` → 29.97…, for counting frames. */
export function fpsValue(fps: string): number {
  const [num, den] = fps.split('/').map(Number)
  const value = den ? num! / den : num!
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Cadence illisible : ${fps}`)
  return value
}

/** How many frames a clip of `ms` holds at this cadence. */
export const frameCount = (ms: number, fps: string) => Math.round((ms / 1000) * fpsValue(fps))

/**
 * ffmpeg's arguments for one clip: JPEG frames on stdin, the jingle (or silence)
 * as sound, cut to the clip's length.
 *
 * The jingle is padded when shorter, cut and faded out when longer, and brought
 * to the loudness YouTube normalises to — a jingle mastered hot would otherwise
 * be louder than the room microphone that follows. Pure, to be tested.
 */
export function clipEncodeArgs(options: {
  format: ClipFormat
  durationMs: number
  jingle: string | null
  output: string
}): string[] {
  const { format, output } = options
  const seconds = (options.durationMs / 1000).toFixed(3)
  const fade = Math.min(0.8, options.durationMs / 1000 / 4).toFixed(3)
  const fadeStart = (options.durationMs / 1000 - Number(fade)).toFixed(3)
  const audioInput = options.jingle == null
    ? ['-f', 'lavfi', '-i', `anullsrc=r=${format.sampleRate}:cl=stereo`]
    : ['-i', options.jingle]
  const audioFilter = options.jingle == null
    ? `[1:a]atrim=0:${seconds}[a]`
    : `[1:a]aresample=${format.sampleRate},aformat=channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=11,` +
      `apad,atrim=0:${seconds},afade=t=out:st=${fadeStart}:d=${fade}[a]`
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', format.fps, '-c:v', 'mjpeg', '-i', '-',
    ...audioInput,
    '-filter_complex', `[0:v]scale=${format.width}:${format.height},setsar=1,format=yuv420p[v];${audioFilter}`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-r', format.fps,
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(format.sampleRate), '-ac', '2',
    '-t', seconds,
    '-movflags', '+faststart',
    output,
  ]
}

export interface RenderClipOptions {
  chrome: Chrome
  clip: VodClip
  /** Images already inlined (`inlineImages`): nothing is fetched during capture. */
  habillage: VodHabillage
  format?: ClipFormat
  /** An audio file under the clip, or `null` for silence. */
  jingle?: string | null
  output: string
  /** Where the page is written, to be opened as a file. */
  workDir: string
  onProgress?: (fraction: number) => void
}

/**
 * One clip, captured frame by frame and encoded.
 *
 * Each frame is the page frozen at its own timestamp (`__vod.figer`), then
 * photographed: the result is the same on a loaded workstation and on a
 * dedicated machine, only slower.
 */
export async function renderClip(options: RenderClipOptions): Promise<{ durationMs: number }> {
  const format = options.format ?? DEFAULT_FORMAT
  const folder = resolveFontsFolder()
  const html = renderVodDocument({
    clip: options.clip,
    habillage: options.habillage,
    capture: true,
    fonts: folder == null ? undefined : { base: pathToFileURL(folder).href, files: availableFonts(folder) },
  })
  const page = join(options.workDir, `${options.clip}.html`)
  await writeFile(page, html, 'utf8')

  const { cdp } = options.chrome
  const { targetId, sessionId } = await cdp.tab('about:blank')
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: format.width,
      height: format.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url: pathToFileURL(page).href }, sessionId)
    const durationMs = await waitReady(options.chrome, sessionId)

    const frames = frameCount(durationMs, format.fps)
    const step = 1000 / fpsValue(format.fps)
    const encoder = start(FFMPEG, clipEncodeArgs({ format, durationMs, jingle: options.jingle ?? null, output: options.output }))
    try {
      for (let i = 0; i < frames; i++) {
        await cdp.evaluate(sessionId, `(window.__vod.figer(${(i * step).toFixed(3)}),
          new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`)
        const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 92,
          optimizeForSpeed: true,
        }, sessionId)
        await write(encoder.stdin, Buffer.from(data, 'base64'))
        options.onProgress?.((i + 1) / frames)
      }
    } finally {
      encoder.stdin.end()
    }
    await encoder.done
    return { durationMs }
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined)
  }
}

/** Waits for the page's typefaces and images; returns the clip's length. */
async function waitReady(chrome: Chrome, sessionId: string): Promise<number> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const ready = await chrome.cdp
      .evaluate<number | null>(sessionId, 'window.__vod ? window.__vod.pret.then(() => window.__vod.dureeMs) : null')
      .catch(() => null)
    if (ready != null) return ready
    if (Date.now() > deadline) throw new Error('La page du clip ne s’est pas chargée en 30 s')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
