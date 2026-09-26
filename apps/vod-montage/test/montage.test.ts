import { describe, expect, it } from 'vitest'
import type { Marker } from '@conference-operator/contract'
import { assembledMs, assemblyArgs, cutFromMarkers, takeFiles, type AssemblyPlan } from '../src/montage.js'
import { clipEncodeArgs, DEFAULT_FORMAT, fpsValue, frameCount } from '../src/rendu.js'

const marker = (offsetMs: number, role?: 'debut' | 'fin'): Marker => ({ label: role ?? 'chapitre', offsetMs, at: '2026-10-30T09:00:00Z', role })

describe('the cut', () => {
  it('follows the two marks', () => {
    expect(cutFromMarkers({ markers: [marker(10_000, 'debut'), marker(20_000), marker(50_000, 'fin')] }, 60_000))
      .toEqual({ startMs: 10_000, endMs: 50_000, missing: [] })
  })

  it('keeps the last mark set: an operator marking again is correcting', () => {
    const cut = cutFromMarkers({ markers: [marker(5_000, 'debut'), marker(12_000, 'debut'), marker(50_000, 'fin')] }, 60_000)
    expect(cut.startMs).toBe(12_000)
  })

  it('keeps the take whole on a side with no mark, and says so', () => {
    expect(cutFromMarkers({ markers: [marker(50_000, 'fin')] }, 60_000)).toEqual({ startMs: 0, endMs: 50_000, missing: ['debut'] })
    expect(cutFromMarkers({ markers: [] }, 60_000)).toEqual({ startMs: 0, endMs: 60_000, missing: ['debut', 'fin'] })
  })

  it('does not cut on a « fin » set before the « début »', () => {
    expect(cutFromMarkers({ markers: [marker(40_000, 'debut'), marker(30_000, 'fin')] }, 60_000))
      .toEqual({ startMs: 0, endMs: 60_000, missing: ['debut', 'fin'] })
  })
})

describe('the take’s files', () => {
  it('is the video file alone when OBS did not split', () => {
    expect(takeFiles({ videoFile: 'talk.mkv' })).toEqual([{ file: 'talk.mkv', offsetMs: 0 }])
  })

  it('follows the segments in the take’s order', () => {
    expect(takeFiles({
      videoFile: 'talk.mkv',
      segments: [
        { file: 'talk (2).mkv', offsetMs: 35_000, durationMs: 25_000 },
        { file: 'talk.mkv', offsetMs: 0, durationMs: 35_000 },
      ],
    }).map((f) => f.file)).toEqual(['talk.mkv', 'talk (2).mkv'])
  })
})

describe('the assembly', () => {
  const plan: AssemblyPlan = {
    intro: { file: 'intro.mp4', durationMs: 6_000 },
    take: { files: ['a.mkv', 'b.mkv'], hasAudio: true, startMs: 10_000, endMs: 50_000 },
    outro: { file: 'outro.mp4', durationMs: 8_000 },
    format: DEFAULT_FORMAT,
    output: 'out.mp4',
  }

  it('joins the segments, then cuts in the take’s time', () => {
    const filter = assemblyArgs(plan)[assemblyArgs(plan).indexOf('-filter_complex') + 1]!
    expect(filter).toContain('[1:v][1:a][2:v][2:a]concat=n=2:v=1:a=1[tv][ta]')
    expect(filter).toContain('[tv]trim=start=10.000:end=50.000')
  })

  it('crossfades where each piece ends', () => {
    const filter = assemblyArgs(plan).join(' ')
    expect(filter).toContain('xfade=transition=fade:duration=0.5:offset=5.500')
    expect(filter).toContain('xfade=transition=fade:duration=0.5:offset=45.000')
    expect(assembledMs(plan)).toBe(53_000)
  })

  it('gives a take without sound a silence', () => {
    const args = assemblyArgs({ ...plan, take: { ...plan.take, files: ['a.mkv'], hasAudio: false } })
    expect(args).toContain('anullsrc=r=48000:cl=stereo')
    expect(args.join(' ')).toContain('[3:a]anull[ta]')
  })
})

describe('a clip’s encoding', () => {
  it('counts frames at the take’s cadence', () => {
    expect(frameCount(6_000, '30')).toBe(180)
    expect(fpsValue('30000/1001')).toBeCloseTo(29.97, 2)
    expect(frameCount(6_000, '30000/1001')).toBe(180)
  })

  it('lays the jingle under the intro, brought to YouTube’s loudness and faded out', () => {
    const args = clipEncodeArgs({ format: DEFAULT_FORMAT, durationMs: 6_000, jingle: 'jingle.wav', output: 'intro.mp4' }).join(' ')
    expect(args).toContain('-i jingle.wav')
    expect(args).toContain('loudnorm=I=-16')
    expect(args).toContain('afade=t=out:st=5.200:d=0.800')
  })

  it('writes silence when there is no jingle', () => {
    expect(clipEncodeArgs({ format: DEFAULT_FORMAT, durationMs: 8_000, jingle: null, output: 'outro.mp4' }))
      .toContain('anullsrc=r=48000:cl=stereo')
  })
})
