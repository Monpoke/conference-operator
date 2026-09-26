import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * The worker's configuration, read once at startup and validated strictly.
 *
 * A worker that starts with a wrong token would only say so at its first
 * claim, in a log nobody reads: better to refuse to start.
 */
export const configSchema = z.object({
  /** The hub, as the worker reaches it — its public address, usually. */
  hubUrl: z.url(),
  /** Created in the console → VOD → Workers de montage. Shown once. */
  workerToken: z.string().startsWith('wt_', 'HUB_WORKER_TOKEN doit commencer par wt_ : un jeton de salle n’ouvre pas le montage'),
  /** The Chromium the clips are captured in. */
  chrome: z.string().min(1).default('chromium'),
  /** The sound under the intro. Absent: silence. */
  jingle: z.string().min(1).optional(),
  /** Where the takes are downloaded and the video assembled — room for two rushes. */
  workDir: z.string().default(join(tmpdir(), 'vod-montage')),
  /** How long to wait before asking again when the queue is empty. */
  pollSeconds: z.coerce.number().int().min(5).max(3_600).default(30),
  /** Parts uploaded at once. */
  uploadConcurrency: z.coerce.number().int().min(1).max(16).default(4),
  /** The talk's sound: loudness aimed at, peak ceiling, rumble cut, compression. */
  audio: z.object({
    lufs: z.coerce.number().min(-31).max(-9).default(-16),
    truePeak: z.coerce.number().min(-9).max(0).default(-1.5),
    highpassHz: z.coerce.number().int().min(0).max(300).default(80),
    compression: z.enum(['non', 'douce']).default('douce'),
  }).default({ lufs: -16, truePeak: -1.5, highpassHz: 80, compression: 'douce' }),
})
export type Config = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse({
    hubUrl: env.HUB_URL,
    workerToken: env.HUB_WORKER_TOKEN,
    chrome: env.CHROME || undefined,
    jingle: env.MONTAGE_JINGLE || undefined,
    workDir: env.WORK_DIR || undefined,
    pollSeconds: env.POLL_SECONDS || undefined,
    uploadConcurrency: env.UPLOAD_CONCURRENCY || undefined,
    audio: {
      lufs: env.MONTAGE_LUFS || undefined,
      truePeak: env.MONTAGE_TRUE_PEAK || undefined,
      highpassHz: env.MONTAGE_PASSE_HAUT || undefined,
      compression: env.MONTAGE_COMPRESSION || undefined,
    },
  })
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${ENV_NAMES[issue.path.join('.')] ?? ENV_NAMES[issue.path[0] as string] ?? issue.path.join('.')} : ${issue.message}`)
    throw new Error(`Configuration du worker invalide :\n${lines.join('\n')}`)
  }
  return parsed.data
}

const ENV_NAMES: Record<string, string> = {
  hubUrl: 'HUB_URL',
  workerToken: 'HUB_WORKER_TOKEN',
  chrome: 'CHROME',
  jingle: 'MONTAGE_JINGLE',
  workDir: 'WORK_DIR',
  pollSeconds: 'POLL_SECONDS',
  uploadConcurrency: 'UPLOAD_CONCURRENCY',
  'audio.lufs': 'MONTAGE_LUFS',
  'audio.truePeak': 'MONTAGE_TRUE_PEAK',
  'audio.highpassHz': 'MONTAGE_PASSE_HAUT',
  'audio.compression': 'MONTAGE_COMPRESSION',
}
