import { join } from 'node:path'
import type { CutSide, CutSource, MontageAudio, MontageCoupe, Sidecar } from '@conference-operator/contract'
import { linearPossible, measureLoudness, NEAR_SILENT_LUFS, rmsFrames, type AudioOptions, type Loudness, type Segment } from './audio.js'
import { silencesOf, snapCut, snapEnd, snapStart, type Frame, type Silence, type Snapped } from './coupe.js'
import { cutFromMarkers, probe, takeFiles, type Probe } from './montage.js'

/**
 * Where the talk starts and ends in its take, how sure we are, and how loud it is.
 *
 * Each end is taken from the surest source there is: the operator's mark, else
 * the room's « Commencer » / « Terminer » converted into the take's time, else
 * the first or last words heard, else the edge of the take. Whatever the
 * source, the end is then moved onto the silence next to it. What cannot be
 * made sure is said — the confidence, and its reasons in words — so that a
 * doubtful cut goes to somebody before it goes to YouTube.
 */

/** The room's lifecycle for this talk, in the hub's clock. */
export interface Regie {
  startedAt: string | null
  endedAt: string | null
  /** Closed by the schedule rather than by somebody: a weaker hint. */
  auto: boolean
  /** Room clock minus hub clock, when the hub could measure it. */
  decalageMs: number | null
}

export type Confiance = 'haute' | 'moyenne' | 'basse'

export interface AnalyseResult {
  segments: Segment[]
  takeMs: number
  format: Probe['format']
  hasAudio: boolean
  coupe: MontageCoupe
  loudness: Loudness | null
  audio: MontageAudio | null
  confiance: Confiance
  raisons: string[]
}

/** Around a mark: enough to find the pause it sits next to. */
const MARK_WINDOW_MS = 8_000
/** Around the room's button: the operator presses it a few seconds off. */
const REGIE_WINDOW_MS = 15_000
/** Looked into for the first and last words when nothing else says. */
const SPEECH_SCAN_MS = 10 * 60_000
/** Shorter than this, a "talk" is more likely a mistaken cut. */
const MIN_TALK_MS = 10 * 60_000
/** Marks and the room's buttons disagreeing by more than this is worth a look. */
const DISAGREE_MS = 2 * 60_000

/** A lifecycle instant, in the take's time. `null` when it cannot be placed. */
export function regieOffsetMs(eventIso: string | null, takeStartRoomIso: string, decalageMs: number | null): number | null {
  if (eventIso == null) return null
  const event = Date.parse(eventIso)
  const takeStart = Date.parse(takeStartRoomIso)
  if (!Number.isFinite(event) || !Number.isFinite(takeStart)) return null
  return event + (decalageMs ?? 0) - takeStart
}

/**
 * The first — or last — sustained speech: five seconds in which most frames
 * stand well above the room's floor. A weak hint, used only when nothing
 * better is there.
 */
export function speechEdge(frames: readonly Frame[], floorDb: number, which: 'first' | 'last', frameMs = 50): number | null {
  const threshold = floorDb + 10
  const span = Math.round(5_000 / frameMs)
  const order = which === 'first' ? frames.map((_, i) => i) : frames.map((_, i) => frames.length - 1 - i)
  for (const i of order) {
    const from = which === 'first' ? i : i - span + 1
    if (from < 0 || from + span > frames.length) continue
    let loud = 0
    for (let k = from; k < from + span; k++) if (frames[k]!.db > threshold) loud += 1
    if (loud / span < 0.7) continue
    // The window is mostly speech: the edge is its first (or last) loud frame,
    // not the window's own edge, which may sit on the silence before it.
    if (which === 'first') {
      for (let k = from; k < from + span; k++) if (frames[k]!.db > threshold) return frames[k]!.ms
    } else {
      for (let k = from + span - 1; k >= from; k--) if (frames[k]!.db > threshold) return frames[k]!.ms + frameMs
    }
  }
  return null
}

/** The confidence of a cut, and why — pure, the decision the console shows. */
export function judge(
  debut: CutSide,
  fin: CutSide,
  context: { durationMs: number; regieAuto: boolean; disagreeMs: number | null },
): { confiance: Confiance; raisons: string[] } {
  const raisons: string[] = []
  const describe = (side: CutSide, name: string) => {
    const where = { marque: 'marque posée en régie', regie: `bouton de la régie${context.regieAuto ? ' (fermé par l’horaire)' : ''}`, parole: 'premiers ou derniers mots détectés', prise: 'bord de la prise', manuel: 'réglée à la main' }[side.source]
    const snapped = side.calee ? `calée sur un silence (${(side.deplacementMs / 1000).toFixed(1)} s)` : 'non calée'
    raisons.push(`${name} : ${where}, ${snapped}`)
  }
  describe(debut, 'Début')
  describe(fin, 'Fin')

  const rank = (side: CutSide): Confiance => {
    if (side.source === 'manuel') return 'haute'
    if (side.source === 'marque') return side.calee && Math.abs(side.deplacementMs) < 2_000 ? 'haute' : 'moyenne'
    if (side.source === 'regie') return context.regieAuto ? 'basse' : 'moyenne'
    return 'basse'
  }
  const levels: Confiance[] = ['basse', 'moyenne', 'haute']
  let confiance = levels[Math.min(levels.indexOf(rank(debut)), levels.indexOf(rank(fin)))]!

  if (context.durationMs < MIN_TALK_MS) {
    raisons.push(`durée courte : ${Math.round(context.durationMs / 60_000)} min`)
    confiance = 'basse'
  }
  if (context.disagreeMs != null && context.disagreeMs > DISAGREE_MS) {
    raisons.push(`marques et boutons de la régie en désaccord de ${Math.round(context.disagreeMs / 60_000)} min`)
    if (confiance === 'haute') confiance = 'moyenne'
  }
  return { confiance, raisons }
}

/** The take's files, probed: where each sits, how long the take is, its format. */
export async function prepareTake(sidecar: Sidecar, folder: string): Promise<{
  segments: Segment[]
  takeMs: number
  format: Probe['format']
  hasAudio: boolean
}> {
  const files = takeFiles(sidecar).map((f) => ({ ...f, path: join(folder, f.file) }))
  const probes = await Promise.all(files.map((f) => probe(f.path)))
  const segments: Segment[] = files.map((f, i) => ({ path: f.path, offsetMs: f.offsetMs, durationMs: probes[i]!.durationMs }))
  const takeMs = files.length === 1 ? probes[0]!.durationMs : files.at(-1)!.offsetMs + probes.at(-1)!.durationMs
  return { segments, takeMs, format: probes[0]!.format, hasAudio: probes.every((p) => p.hasAudio) }
}

/** What the loudness measure says of a cut, for the console. */
export function audioReport(loudness: Loudness, options: AudioOptions): MontageAudio {
  const quasiMuet = loudness.i <= NEAR_SILENT_LUFS
  return {
    lufsAvant: loudness.i,
    lufsApres: quasiMuet ? null : options.lufs,
    truePeak: loudness.tp,
    lra: loudness.lra,
    lineaire: !quasiMuet && linearPossible(loudness, options),
    quasiMuet,
  }
}

export async function analyser(options: {
  sidecar: Sidecar
  folder: string
  audio: AudioOptions
  scratchDir: string
  regie?: Regie | null
  log?: (message: string) => void
}): Promise<AnalyseResult> {
  const log = options.log ?? (() => {})
  const { segments, takeMs, format, hasAudio } = await prepareTake(options.sidecar, options.folder)
  const marked = cutFromMarkers(options.sidecar, takeMs)
  const within = (ms: number | null) => (ms != null && ms >= 0 && ms <= takeMs ? ms : null)

  const regie = options.regie ?? null
  const regieStart = regie == null ? null : within(regieOffsetMs(regie.startedAt, options.sidecar.startedAt, regie.decalageMs))
  const regieEnd = regie == null ? null : within(regieOffsetMs(regie.endedAt, options.sidecar.startedAt, regie.decalageMs))

  let scratch = 0
  const frames = (fromMs: number, toMs: number) =>
    rmsFrames(segments, Math.max(0, fromMs), Math.min(takeMs, toMs), join(options.scratchDir, `niveaux-${scratch++}.txt`))
  const pauses = async (aroundMs: number, halfMs: number): Promise<Silence[]> =>
    hasAudio ? silencesOf(await frames(aroundMs - halfMs, aroundMs + halfMs)).silences : []

  /** One end: its source, then the silence next to it. */
  const side = async (which: 'debut' | 'fin'): Promise<{ ms: number; source: CutSource; snapped: Snapped | null }> => {
    const isStart = which === 'debut'
    // A mark sits just after the pause (start) or just before it (end): searched
    // mostly on one side. The room's button is pressed a few seconds off either
    // way: searched wide, on both sides.
    const snap = (ms: number, found: Silence[], wide: boolean) => {
      if (wide) return (isStart ? snapStart : snapEnd)(ms, found, { beforeMs: REGIE_WINDOW_MS, afterMs: REGIE_WINDOW_MS, nearest: true })
      return isStart ? snapStart(ms, found) : snapEnd(ms, found)
    }
    if (!marked.missing.includes(which)) {
      const ms = isStart ? marked.startMs : marked.endMs
      return { ms, source: 'marque', snapped: snap(ms, await pauses(ms, MARK_WINDOW_MS), false) }
    }
    const fromRegie = isStart ? regieStart : regieEnd
    if (fromRegie != null) {
      return { ms: fromRegie, source: 'regie', snapped: snap(fromRegie, await pauses(fromRegie, REGIE_WINDOW_MS), true) }
    }
    if (hasAudio) {
      const from = isStart ? 0 : Math.max(0, takeMs - SPEECH_SCAN_MS)
      const scan = await frames(from, isStart ? Math.min(takeMs, SPEECH_SCAN_MS) : takeMs)
      const { floorDb, silences: found } = silencesOf(scan)
      const edge = speechEdge(scan, floorDb, isStart ? 'first' : 'last')
      if (edge != null) return { ms: edge, source: 'parole', snapped: snap(edge, found, false) }
    }
    return { ms: isStart ? 0 : takeMs, source: 'prise', snapped: null }
  }

  const start = await side('debut')
  const end = await side('fin')
  const raw = { startMs: start.ms, endMs: end.ms }
  const cut = snapCut(raw, start.snapped, end.snapped)
  const crossed = cut === raw && (start.snapped?.calee || end.snapped?.calee)
  const sideOf = (s: typeof start, finalMs: number): CutSide => ({
    source: s.source,
    calee: !crossed && (s.snapped?.calee ?? false),
    deplacementMs: Math.round(finalMs - s.ms),
  })
  const coupe: MontageCoupe = {
    debutMs: Math.round(cut.startMs),
    finMs: Math.round(cut.endMs),
    debut: sideOf(start, cut.startMs),
    fin: sideOf(end, cut.endMs),
  }

  const disagreements = [
    start.source === 'marque' && regieStart != null ? Math.abs(start.ms - regieStart) : null,
    end.source === 'marque' && regieEnd != null ? Math.abs(end.ms - regieEnd) : null,
  ].filter((d): d is number => d != null)
  const verdict = judge(coupe.debut, coupe.fin, {
    durationMs: coupe.finMs - coupe.debutMs,
    regieAuto: regie?.auto ?? false,
    disagreeMs: disagreements.length > 0 ? Math.max(...disagreements) : null,
  })

  let loudness: Loudness | null = null
  let audio: MontageAudio | null = null
  if (hasAudio) {
    loudness = await measureLoudness(segments, coupe.debutMs, coupe.finMs, options.audio)
    audio = audioReport(loudness, options.audio)
    const quasiMuet = audio.quasiMuet
    if (quasiMuet) verdict.raisons.push(`son quasi absent (${loudness.i.toFixed(1)} LUFS) : laissé tel quel`)
  }
  log(`coupe proposée ${coupe.debutMs} → ${coupe.finMs} ms, confiance ${verdict.confiance}`)
  return { segments, takeMs, format, hasAudio, coupe, loudness, audio, ...verdict }
}
