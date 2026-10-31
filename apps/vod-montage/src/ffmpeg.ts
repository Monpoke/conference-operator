import { spawn } from 'node:child_process'
import type { Writable } from 'node:stream'

/** Where the tools are: the image installs them on the PATH; a workstation may differ. */
export const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'
export const FFPROBE = process.env.FFPROBE ?? 'ffprobe'

export interface Running {
  stdin: Writable
  done: Promise<void>
}

/**
 * Starts a tool, keeping the end of its stderr for the error message: ffmpeg
 * says why it failed in its last lines, after a screenful of banner.
 */
export function start(binary: string, args: string[]): Running {
  const child = spawn(binary, args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let tail = ''
  child.stderr.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-4_000)
  })
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (error) => reject(new Error(`${binary} introuvable : ${error.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${binary} a échoué (code ${code}) :\n${tail.trim().split('\n').slice(-8).join('\n')}`))
    })
  })
  // A tool that stops reading (it failed) must not crash the process on EPIPE.
  child.stdin.on('error', () => {})
  return { stdin: child.stdin, done }
}

export async function run(binary: string, args: string[]): Promise<void> {
  const running = start(binary, args)
  running.stdin.end()
  await running.done
}

/** How far `-progress` says the output is, from one of its lines; `null` for the others. */
export function progressFraction(line: string, totalMs: number): number | null {
  const match = /^out_time_us=(\d+)/.exec(line.trim())
  if (match == null || totalMs <= 0) return null
  return Math.min(1, Number(match[1]) / 1000 / totalMs)
}

/**
 * ffmpeg with its progress reported, `totalMs` being the output's length.
 *
 * What `onProgress` throws — the job cancelled, its lease lost — kills ffmpeg and
 * comes back from here: otherwise it would run on for nothing.
 */
export function runWithProgress(args: string[], totalMs: number, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-progress', 'pipe:1', '-nostats', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    let pending = ''
    let thrown: unknown = null
    child.stderr.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-4_000)
    })
    child.stdout.on('data', (chunk: Buffer) => {
      const lines = (pending + chunk.toString()).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const fraction = progressFraction(line, totalMs)
        if (fraction == null || thrown != null) continue
        try {
          onProgress(fraction)
        } catch (error) {
          thrown = error
          child.kill('SIGKILL')
        }
      }
    })
    child.on('error', (error) => reject(new Error(`${FFMPEG} introuvable : ${error.message}`)))
    child.on('close', (code) => {
      if (thrown != null) reject(thrown)
      else if (code === 0) resolve()
      else reject(new Error(`${FFMPEG} a échoué (code ${code}) :\n${tail.trim().split('\n').slice(-8).join('\n')}`))
    })
  })
}

/** Runs a tool and returns its stdout — ffprobe's JSON. */
export function output(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (err = (err + chunk.toString()).slice(-2_000)))
    child.on('error', (error) => reject(new Error(`${binary} introuvable : ${error.message}`)))
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${binary} a échoué (code ${code}) : ${err.trim()}`))))
  })
}

/**
 * Runs a tool and returns the end of its stderr — where ffmpeg's analysis
 * filters (`loudnorm`'s report) write what they measured.
 */
export function stderrOf(binary: string, args: string[], keep = 64_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => (err = (err + chunk.toString()).slice(-keep)))
    child.on('error', (error) => reject(new Error(`${binary} introuvable : ${error.message}`)))
    child.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`${binary} a échoué (code ${code}) : ${err.trim().split('\n').slice(-6).join('\n')}`))))
  })
}

/** Writes to a stream, waiting when it asks to. */
export function write(stream: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = stream.write(chunk, (error) => (error ? reject(error) : undefined))
    if (ok) resolve()
    else stream.once('drain', resolve)
  })
}
