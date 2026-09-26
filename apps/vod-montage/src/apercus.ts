import { join } from 'node:path'
import type { MontageCoupe } from '@conference-operator/contract'
import { windowInputs, type Segment } from './audio.js'
import { FFMPEG, run } from './ffmpeg.js'

/**
 * What the console shows of an analysed cut, to check it without the take.
 *
 * A waveform of the whole take, to see where the talk sits in it; four stills
 * around each end, to see the speaker arrive and leave; fifteen seconds of
 * sound around each end, to hear whether the first words are all there.
 */

/** Where the stills are taken, around each end. */
export const STILLS = {
  debut: [-2_000, 0, 2_000, 5_000],
  fin: [-5_000, -2_000, 0, 2_000],
} as const

/** The excerpts: mostly on the talk's side of the cut. */
export const EXCERPTS = {
  debut: { beforeMs: 5_000, afterMs: 10_000 },
  fin: { beforeMs: 10_000, afterMs: 5_000 },
} as const

/** A still at `ms` of the take: the file it falls in, and where in it. */
export function locate(segments: readonly Segment[], ms: number): { path: string; localMs: number } | null {
  for (const segment of segments) {
    if (ms >= segment.offsetMs && ms < segment.offsetMs + segment.durationMs) return { path: segment.path, localMs: ms - segment.offsetMs }
  }
  return null
}

/** The files, written into `dir`; returns their names — those that could be made. */
export async function makeApercus(options: {
  segments: readonly Segment[]
  takeMs: number
  hasAudio: boolean
  coupe: MontageCoupe
  dir: string
  log?: (message: string) => void
}): Promise<string[]> {
  const { segments, takeMs, coupe, dir } = options
  const made: string[] = []
  const attempt = async (name: string, args: string[]) => {
    try {
      await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args, join(dir, name)])
      made.push(name)
    } catch (error) {
      options.log?.(`aperçu ${name} impossible : ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (options.hasAudio) {
    const whole = windowInputs(segments, 0, takeMs)
    await attempt('forme.png', [
      ...whole.args,
      // Drawn from a levelled copy: a take recorded quiet — the room mixer set
      // low — would otherwise draw a flat line, and nobody could see where the
      // talk sits. The sound itself is not touched.
      '-filter_complex', `${whole.join},aformat=channel_layouts=mono,dynaudnorm=f=250:g=15,showwavespic=s=1600x200:colors=0x8b5cf6:scale=sqrt[w]`,
      '-map', '[w]', '-frames:v', '1',
    ])
  }

  for (const side of ['debut', 'fin'] as const) {
    const at = side === 'debut' ? coupe.debutMs : coupe.finMs
    for (const [i, delta] of STILLS[side].entries()) {
      const where = locate(segments, Math.min(takeMs - 100, Math.max(0, at + delta)))
      if (where == null) continue
      await attempt(`${side}-${i + 1}.jpg`, [
        '-ss', (where.localMs / 1000).toFixed(3), '-i', where.path,
        '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4',
      ])
    }
    if (options.hasAudio) {
      const span = EXCERPTS[side]
      const excerpt = windowInputs(segments, Math.max(0, at - span.beforeMs), Math.min(takeMs, at + span.afterMs))
      await attempt(`${side}.mp3`, [
        ...excerpt.args,
        '-filter_complex', `${excerpt.join}[a]`, '-map', '[a]', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k',
      ])
    }
  }
  return made
}

/** Uploads the files to the hub's signed addresses. */
export async function uploadApercus(dir: string, urls: readonly { nom: string; url: string }[], fetcher: typeof fetch = fetch): Promise<void> {
  const { readFile } = await import('node:fs/promises')
  for (const { nom, url } of urls) {
    const bytes = await readFile(join(dir, nom))
    const response = await fetcher(url, { method: 'PUT', body: new Uint8Array(bytes) })
    if (!response.ok) throw new Error(`envoi de ${nom} refusé (HTTP ${response.status})`)
  }
}
