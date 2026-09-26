import { describe, expect, it } from 'vitest'
import { judge, regieOffsetMs, speechEdge } from '../src/analyse.js'
import { DEFAULT_AUDIO, linearPossible, parseFrames, parseLoudnorm, talkAudioChain, windowInputs } from '../src/audio.js'
import { locate } from '../src/apercus.js'
import { noiseFloor, silences, silencesOf, snapCut, snapEnd, snapStart, type Frame } from '../src/coupe.js'

/** 50 ms frames: speech (-20 dB) for 3 s, pause (-60 dB) for 1 s, from `fromMs` to `toMs`. */
function speech(fromMs: number, toMs: number): Frame[] {
  const frames: Frame[] = []
  for (let ms = fromMs; ms < toMs; ms += 50) frames.push({ ms, db: ms % 4_000 < 3_000 ? -20 : -60 })
  return frames
}

describe('the silence around a mark', () => {
  it('is measured from the room itself', () => {
    const frames = speech(0, 16_000)
    expect(noiseFloor(frames)).toBe(-60)
    expect(silences(frames, -54).map((s) => [s.startMs, s.endMs])).toEqual([[3_000, 4_000], [7_000, 8_000], [11_000, 12_000], [15_000, 16_000]])
  })

  it('ignores the gap between two words', () => {
    const frames = speech(0, 4_000).map((f) => (f.ms >= 1_000 && f.ms < 1_200 ? { ...f, db: -60 } : f))
    expect(silencesOf(frames).silences.map((s) => s.startMs)).toEqual([3_000])
  })

  it('moves a late start back to where the words began', () => {
    const { silences: found } = silencesOf(speech(2_500, 18_500))
    // Pressed 2.5 s into the sentence that started at 8 s.
    expect(snapStart(10_500, found)).toEqual({ ms: 7_750, calee: true, shiftMs: -2_750 })
  })

  it('moves an early end on to the pause after the last words', () => {
    const { silences: found } = silencesOf(speech(52_500, 68_500))
    expect(snapEnd(60_500, found)).toEqual({ ms: 63_400, calee: true, shiftMs: 2_900 })
  })

  it('keeps the mark when no pause is close enough', () => {
    expect(snapStart(10_000, [{ startMs: 1_000, endMs: 2_000 }])).toEqual({ ms: 10_000, calee: false, shiftMs: 0 })
  })

  it('takes the nearest pause for an instant known roughly', () => {
    const found = [{ startMs: 3_000, endMs: 4_000 }, { startMs: 19_000, endMs: 20_000 }]
    expect(snapStart(18_000, found, { beforeMs: 15_000, afterMs: 15_000, nearest: true }).ms).toBe(19_750)
    expect(snapStart(18_000, found, { beforeMs: 15_000, afterMs: 15_000 }).ms).toBe(19_750)
    expect(snapStart(6_000, found, { beforeMs: 15_000, afterMs: 15_000, nearest: true }).ms).toBe(3_750)
  })

  it('never crosses the two ends', () => {
    const cut = { startMs: 10_000, endMs: 11_000 }
    expect(snapCut(cut, { ms: 12_000, calee: true, shiftMs: 2_000 }, { ms: 11_500, calee: true, shiftMs: 500 })).toBe(cut)
  })
})

describe('the sound', () => {
  const report = `[Parsed_loudnorm_0 @ 0x5]
{
	"input_i" : "-27.31",
	"input_tp" : "-9.02",
	"input_lra" : "6.40",
	"input_thresh" : "-37.80",
	"output_i" : "-16.10",
	"target_offset" : "0.10"
}`

  it('reads loudnorm’s report', () => {
    expect(parseLoudnorm(report)).toEqual({ i: -27.31, tp: -9.02, lra: 6.4, thresh: -37.8, offset: 0.1 })
  })

  it('applies one gain from the measure, after the same pre-chain', () => {
    const chain = talkAudioChain(DEFAULT_AUDIO, parseLoudnorm(report))
    expect(chain).toMatch(/^highpass=f=80,acompressor=.*,loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-27.31:.*:linear=true$/)
  })

  it('does not bring up a near-silent take', () => {
    expect(talkAudioChain({ ...DEFAULT_AUDIO, compression: 'non', highpassHz: 0 }, { i: -62, tp: -50, lra: 1, thresh: -72, offset: 0 })).toBe('')
  })

  it('says when one gain would clip', () => {
    expect(linearPossible({ i: -30, tp: -3, lra: 5, thresh: -40, offset: 0 }, DEFAULT_AUDIO)).toBe(false)
    expect(linearPossible({ i: -30, tp: -20, lra: 5, thresh: -40, offset: 0 }, DEFAULT_AUDIO)).toBe(true)
  })

  it('reads only the window it needs, across the files of a split take', () => {
    const segments = [{ path: 'a.mkv', offsetMs: 0, durationMs: 35_000 }, { path: 'b.mkv', offsetMs: 35_000, durationMs: 25_000 }]
    const { args, join } = windowInputs(segments, 30_000, 40_000)
    expect(args).toEqual(['-ss', '30.000', '-t', '5.000', '-i', 'a.mkv', '-ss', '0.000', '-t', '5.000', '-i', 'b.mkv'])
    expect(join).toBe('[0:a][1:a]concat=n=2:v=0:a=1')
    expect(locate(segments, 36_000)).toEqual({ path: 'b.mkv', localMs: 1_000 })
  })

  it('reads the level printout, silence included', () => {
    const text = 'frame:0    pts:0       pts_time:0\nlavfi.astats.Overall.RMS_level=-42.5\nframe:1    pts:2400    pts_time:0.05\nlavfi.astats.Overall.RMS_level=-inf\n'
    expect(parseFrames(text, 10_000)).toEqual([{ ms: 10_000, db: -42.5 }, { ms: 10_050, db: -120 }])
  })
})

describe('a take without marks', () => {
  it('places the room’s buttons in the take', () => {
    expect(regieOffsetMs('2026-10-30T09:02:30Z', '2026-10-30T09:00:00Z', null)).toBe(150_000)
    expect(regieOffsetMs('2026-10-30T09:02:30Z', '2026-10-30T09:00:00Z', 40_000)).toBe(190_000)
    expect(regieOffsetMs(null, '2026-10-30T09:00:00Z', null)).toBeNull()
  })

  it('finds the first and last sustained words', () => {
    const frames: Frame[] = []
    for (let ms = 0; ms < 60_000; ms += 50) frames.push({ ms, db: ms >= 20_000 && ms < 45_000 ? -20 : -60 })
    expect(speechEdge(frames, -60, 'first')).toBe(20_000)
    expect(speechEdge(frames, -60, 'last')).toBe(45_000)
  })
})

describe('the confidence of a cut', () => {
  const side = (source: 'marque' | 'regie' | 'parole' | 'prise', calee = true, deplacementMs = -800) => ({ source, calee, deplacementMs })

  it('is high for two marks snapped close by', () => {
    expect(judge(side('marque'), side('marque', true, 900), { durationMs: 40 * 60_000, regieAuto: false, disagreeMs: null }).confiance).toBe('haute')
  })

  it('is medium from the room’s buttons, low if the schedule closed the talk', () => {
    const context = { durationMs: 40 * 60_000, disagreeMs: null }
    expect(judge(side('marque'), side('regie'), { ...context, regieAuto: false }).confiance).toBe('moyenne')
    expect(judge(side('marque'), side('regie'), { ...context, regieAuto: true }).confiance).toBe('basse')
  })

  it('drops for a short talk, and says why', () => {
    const verdict = judge(side('marque'), side('marque'), { durationMs: 4 * 60_000, regieAuto: false, disagreeMs: null })
    expect(verdict.confiance).toBe('basse')
    expect(verdict.raisons.at(-1)).toMatch(/durée courte/)
  })

  it('stops being high when marks and buttons disagree', () => {
    expect(judge(side('marque'), side('marque'), { durationMs: 40 * 60_000, regieAuto: false, disagreeMs: 5 * 60_000 }).confiance).toBe('moyenne')
  })
})
