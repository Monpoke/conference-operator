import { z } from 'zod'

/** `capacité/par seconde`, e.g. `200/10`: 200 requests at once, then 10 a second. */
const limiteSchema = z
  .string()
  .regex(/^\d+\/\d+(\.\d+)?$/, 'format « capacité/par seconde » attendu, ex. 200/10')
  .transform((value) => {
    const [capacity, refillPerSecond] = value.split('/').map(Number)
    return { capacity: capacity!, refillPerSecond: refillPerSecond! }
  })

export const RESEAUX = ['bluesky', 'mastodon', 'x', 'linkedin'] as const
export type Reseau = (typeof RESEAUX)[number]

/**
 * The service's configuration, read once and validated strictly: a page that
 * starts with a wrong hub address would only say so in a log nobody reads.
 */
export const configSchema = z.object({
  /** The hub, as the service reaches it — in the cluster, its service. */
  hubUrl: z.url(),
  port: z.coerce.number().int().min(0).max(65_535).default(8080),
  host: z.string().min(1).default('0.0.0.0'),
  /** How often the hub is asked. The audience's pages ask this service, never the hub. */
  pollSeconds: z.coerce.number().min(1).max(300).default(5),
  /**
   * Per visitor address, for the page and its JSON. Generous on purpose: a whole
   * venue behind one WiFi shares an address, and both answers come from memory.
   * Sized for 300 people on one address: 600 at once for their first visits
   * (page and favicon), then their polls, 20 a second.
   */
  limitePages: limiteSchema.default({ capacity: 1000, refillPerSecond: 50 }),
  /**
   * Per visitor address, for the images — a first visit fetches a few dozen at
   * once: 300 people opening the page together, ~36 photos each.
   */
  limiteImages: limiteSchema.default({ capacity: 12000, refillPerSecond: 300 }),
  /**
   * Per visitor address, for the views the page reports (`POST /vues`): one every
   * ten seconds or so per visitor scrolling, 300 of them behind one WiFi.
   */
  limiteVues: limiteSchema.default({ capacity: 600, refillPerSecond: 40 }),
  /**
   * The token the hub gave in its console (Réglages → Mur social — page publique),
   * to report the views. Absent: the page works, the views are not counted.
   */
  hubToken: z.string().trim().startsWith('mp_', 'jeton du mur public attendu (mp_…)').optional(),
  /** How often the views gathered are sent to the hub. */
  vuesSeconds: z.coerce.number().min(1).max(600).default(30),
  /**
   * Proxies in front that append to `X-Forwarded-For` (the ingress: 1). The
   * visitor is the entry that many places from the right — the left ones are
   * whatever the client chose to send. 0: the socket's address.
   */
  proxyHops: z.coerce.number().int().min(0).max(5).default(1),
  /** The images kept in memory, in megabytes. */
  imagesCacheMb: z.coerce.number().int().min(1).max(1024).default(64),
  /** The networks offered to post on — those the hub actually follows. */
  reseaux: z
    .string()
    .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean))
    .pipe(z.array(z.enum(RESEAUX)))
    .default([...RESEAUX]),
})
export type Config = z.infer<typeof configSchema>

const ENV_NAMES: Record<string, string> = {
  hubUrl: 'HUB_URL',
  port: 'PORT',
  host: 'HOST',
  pollSeconds: 'POLL_SECONDS',
  limitePages: 'LIMITE_PAGES',
  limiteImages: 'LIMITE_IMAGES',
  proxyHops: 'PROXY_HOPS',
  imagesCacheMb: 'IMAGES_CACHE_MB',
  limiteVues: 'LIMITE_VUES',
  hubToken: 'HUB_TOKEN',
  vuesSeconds: 'VUES_SECONDS',
  reseaux: 'RESEAUX',
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse({
    hubUrl: env.HUB_URL,
    port: env.PORT || undefined,
    host: env.HOST || undefined,
    pollSeconds: env.POLL_SECONDS || undefined,
    limitePages: env.LIMITE_PAGES || undefined,
    limiteImages: env.LIMITE_IMAGES || undefined,
    proxyHops: env.PROXY_HOPS || undefined,
    imagesCacheMb: env.IMAGES_CACHE_MB || undefined,
    limiteVues: env.LIMITE_VUES || undefined,
    hubToken: env.HUB_TOKEN || undefined,
    vuesSeconds: env.VUES_SECONDS || undefined,
    reseaux: env.RESEAUX || undefined,
  })
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${ENV_NAMES[issue.path[0] as string] ?? issue.path.join('.')} : ${issue.message}`)
    throw new Error(`Configuration du mur public invalide :\n${lines.join('\n')}`)
  }
  return parsed.data
}
