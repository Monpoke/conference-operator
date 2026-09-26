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

/** Writes to a stream, waiting when it asks to. */
export function write(stream: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = stream.write(chunk, (error) => (error ? reject(error) : undefined))
    if (ok) resolve()
    else stream.once('drain', resolve)
  })
}
