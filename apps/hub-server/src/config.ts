import { z } from 'zod'

/**
 * Configuration read once at startup and validated strictly.
 *
 * A hub that starts with a missing variable on the day is worse than a hub that
 * refuses to start: we want the failure at deployment, not in the room.
 */
/** A setting found in the environment and left with no effect, with the why. */
export interface IgnoreConfig {
  variable: string
  reason: string
}

const configSchema = z.object({
  /**
   * The hub's execution mode.
   *
   * A single switch in front of the development conveniences, rather than one
   * variable per convenience: on the day, what you want to check fits on one
   * line. `production` by default, because the default must be the dangerous
   * case — an event hub started with nothing specified must simulate nothing.
   */
  mode: z.enum(['production', 'dev']).default('production'),
  /** `0` asks the system for a free port — useful in test and in development. */
  port: z.coerce.number().int().min(0).max(65535).default(8787),
  host: z.string().default('0.0.0.0'),
  databasePath: z.string().default('./data/hub.db'),
  /** Public base of the hub, used by Better Auth and the device verification URI. */
  publicUrl: z.url().default('http://localhost:8787'),
  /**
   * The console's development server, proxied by the hub.
   *
   * Read in dev mode only, and only as long as no bundle has been built. The
   * direction of the proxy — the hub in front of Vite — is imposed by Better
   * Auth's cookies and by `/sw.js`'s scope; see `server.ts`.
   */
  viteOrigin: z.url().default('http://127.0.0.1:5173'),
  /**
   * The control app's development server, proxied by the hub.
   *
   * Distinct from `viteOrigin`: these are two applications, two ports, and they
   * are developed together — a demo room plugged into a local hub. The same Vite
   * server serves the control app to the room machine and to the hub; both serve
   * it under `/regie/`, so the same `base` suits both.
   */
  regieViteOrigin: z.url().default('http://127.0.0.1:5174'),
  authSecret: z.string().min(32, 'BETTER_AUTH_SECRET doit faire au moins 32 caractères'),
  /** URL of the "conference-center" export imported by default. */
  programSourceUrl: z.url().optional(),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * Polling cadence imposed on the machines during pairing (RFC 8628).
   * Lowered in the tests so as not to wait 5 s between two polls.
   */
  devicePollInterval: z
    .custom<`${number}${'s' | 'm'}`>((value) => typeof value === 'string' && /^\d+[sm]$/.test(value))
    .default('5s'),
  /**
   * Lifetime of a pairing code — and, with it, that of a request in the
   * console's queue.
   *
   * A single setting for both: a dead code whose request is still displayed makes
   * you click "Approuver" on something that can no longer succeed, and the queue
   * ends up meaning nothing.
   *
   * Short by default, unlike the RFC value: a queue that empties itself beats a
   * code that survives the day. Nothing is lost when it expires — the supervision
   * loop asks for another within 15 s, and the control screen shows the new one.
   * What it costs is crossing the room: an operator who copies the code and walks
   * to the console can arrive after its death. **On the day, set
   * `DEVICE_CODE_TTL=30m`**; the console says in plain words that a code has
   * expired anyway.
   */
  deviceCodeTtl: z
    .custom<`${number}${'s' | 'm' | 'h'}`>(
      (value) => typeof value === 'string' && /^\d+[smh]$/.test(value),
    )
    .default('2m'),

  /**
   * Operator sign-in through Google Workspace.
   *
   * Both identifiers come from the "Web Application" OAuth client of the Google
   * Cloud console. Absent, the hub does not mount the provider and the console
   * only offers the password — that is the default case, and an event hub must be
   * able to start with no Google account.
   */
  googleClientId: z.string().optional(),
  googleClientSecret: z.string().optional(),
  /**
   * Accepted Workspace domain. **Every account of that domain is an operator.**
   *
   * Sent to Google as the `hd` hint, and above all **rechecked against the
   * identity token's `hd` claim** on the way back: the hint alone is a
   * chooser-screen suggestion, which a personal account gets around.
   *
   * No default, and mandatory as soon as Google is configured: a domain
   * hard-coded in the code belongs to one organizer only, and letting it act as a
   * fallback would open one event's console to another's staff. So the hub
   * refuses to start rather than guess — the same rule as for the two
   * identifiers, and for the same reason.
   */
  googleHostedDomain: z.string().min(1).optional(),

  /**
   * VAPID keys for the pushed notifications (RFC 8292).
   *
   * Optional: without them, the hub generates a pair at the first startup and
   * keeps it in the database. Setting them serves to survive a recreated database
   * — keys that change invalidate every subscription, and nobody subscribes
   * twice.
   */
  vapidPublicKey: z.string().optional(),
  vapidPrivateKey: z.string().optional(),
  /**
   * Contact RFC 8292 requires be announced to the push services.
   *
   * A `mailto:` address or an `https:` URL. Absent, the hub derives it from its
   * own domain (`mailto:hub@<domain>`): a repository must not embed one
   * organizer's contact address, which would then receive everyone else's abuse
   * reports.
   *
   * **To be set in production**: the derived value is syntactically valid and
   * points at the right domain, but nothing guarantees anyone reads that mailbox,
   * and it really is a human the push service will write to.
   */
  vapidSubject: z.string().optional(),

  /**
   * S3 storage for the rushes. **The four go together.**
   *
   * These are the only settings of this feature that live here: an access key has
   * no business in a database that gets backed up, nor in a console opened from a
   * phone. The bucket and the prefix, on the other hand, are console settings —
   * they change from one edition to the next, and sometimes on the morning
   * itself.
   *
   * None of the four set: the feature is simply off, and nobody has anything to
   * do. Only some of them: the hub refuses to start, because the failure would
   * otherwise show up as a console where every button fails, and it would be
   * looked for at the hosting provider.
   */
  s3Endpoint: z.url().optional(),
  s3Region: z.string().min(1).default('us-east-1'),
  /**
   * Bucket the rushes land in — **a seed only**.
   *
   * The console's setting is authoritative; this one only serves the very first
   * startup, when nothing has ever been entered. The same rule as
   * `PROGRAM_SOURCE_URL`, and for the same reason: a bucket corrected during the
   * event must survive the restart that follows, and a frozen `.env` would
   * overwrite it every time.
   *
   * It exists for the deployments where nobody opens the console — a machine
   * provisioned in advance, a script that brings the hub up. Without it, a freshly
   * deployed hub starts with its keys and no destination.
   */
  s3Bucket: z.string().min(1).optional(),
  /**
   * Path to a PEM certificate-authority file, for internal storage.
   *
   * Node does not use the system certificate store: it ships its own list of
   * public CAs. Storage whose certificate is signed by a corporate CA therefore
   * fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, a message that says neither
   * what is missing nor where to put it.
   *
   * The hub uses it for its own calls **and sends it down to the rooms** at sync:
   * setting an environment variable on three Electron machines on an event
   * morning is a gesture you forget on the third, and the omission is only
   * discovered in the evening. A CA certificate is public by construction —
   * distributing it is not distributing a secret.
   *
   * `NODE_EXTRA_CA_CERTS` remains possible and applies to the whole process; this
   * one applies only to the storage, which is narrower and therefore preferable.
   */
  s3CaCert: z.string().min(1).optional(),
  s3AccessKeyId: z.string().min(1).optional(),
  s3SecretAccessKey: z.string().min(1).optional(),
  /**
   * `endpoint/bucket/key` addressing rather than `bucket.endpoint/key`.
   *
   * True by default: that is what MinIO and most compatible storages want, and it
   * is the only mode that works on an IP address. AWS itself only accepts the
   * other any more, hence the setting.
   */
  s3ForcePathStyle: z
    .union([z.string(), z.boolean()])
    .default(true)
    .transform((value) => value !== 'false' && value !== '0' && value !== false),
  /**
   * Minutes of silence after which an upload is abandoned.
   *
   * A room switched off mid-upload says nothing: without this deadline, its
   * multipart would stay open — and billed — indefinitely. Long enough that a
   * network outage of a few minutes does not make everything start over.
   */
  vodAbandonMinutes: z.coerce.number().int().min(5).max(1440).default(30),

  /** Hashtag followed on the social networks. Empty = no social ingestion. */
  socialHashtag: z.string().optional(),
  /** Mastodon instance queried for the hashtag's public timeline. */
  mastodonInstance: z.url().optional(),
  /**
   * X key. Absent, the adapter stays declared but refuses explicitly: searching
   * by hashtag requires a paid plan.
   */
  xBearerToken: z.string().optional(),
  socialPollIntervalMs: z.coerce.number().int().positive().default(30_000),

  /**
   * The hub's simulated time (ISO 8601). Development only.
   *
   * Moves the whole system: the rooms align on the hub's time, so there is
   * nothing to set on their side. Lets an event day be played out months before
   * it happens.
   */
  simulatedTime: z.iso.datetime({ offset: true }).optional(),

  /**
   * The old switch for setting the time. **Obsolete.**
   *
   * Setting the time now follows `MODE`: open in development, closed in
   * production. The field only survives to be *detected* — finding it in a `.env`
   * means somebody believes they have opened something, and staying silent would
   * send them looking elsewhere. It is never read afterwards.
   */
  clockControl: z.union([z.string(), z.boolean()]).optional(),
})
  /**
   * A half-configured Google does not start.
   *
   * Letting it through would bring up a hub where the "Continuer avec Google"
   * button fails on every click, or does not appear even though the variable is
   * there: in both cases the failure gets looked for in the Google Cloud console,
   * not in a `.env` missing a line.
   */
  .refine(
    (config) => (config.googleClientId == null) === (config.googleClientSecret == null),
    {
      path: ['googleClientId'],
      message:
        'GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET vont par paire : renseigner les deux, ou aucun',
    },
  )
  /**
   * Google with no domain does not start.
   *
   * The domain *is* the list of operators: without it there is no boundary to
   * enforce, and the omission would only show at the first personal account that
   * gets in — which is to say too late.
   */
  .refine((config) => config.googleClientId == null || config.googleHostedDomain != null, {
    path: ['googleHostedDomain'],
    message:
      'GOOGLE_HOSTED_DOMAIN est obligatoire avec GOOGLE_CLIENT_ID : il décide qui est opérateur',
  })
  /**
   * Half-configured S3 storage does not start.
   *
   * The same rule as the Google pair, and for the same reason: three variables out
   * of four bring up a hub where the console announces storage is ready and every
   * upload fails at signing. The failure would be looked for in the bucket's
   * permissions, not in a `.env` missing a line. Zero out of four remains
   * perfectly valid — it is even the normal case.
   */
  .refine(
    (config) => {
      const set = [
        config.s3Endpoint,
        config.s3AccessKeyId,
        config.s3SecretAccessKey,
      ].filter((value) => value != null).length
      return set === 0 || set === 3
    },
    {
      path: ['s3Endpoint'],
      message:
        'S3_ENDPOINT, S3_ACCESS_KEY_ID et S3_SECRET_ACCESS_KEY vont ensemble : les renseigner tous, ou aucun',
    },
  )
  /**
   * Production-mode guard rail, and a reminder about obsolete variables.
   *
   * Development settings are **neutralized**, not refused: a hub that does not
   * restart because a line is lying around in a `.env` would be worse than the
   * problem it cures — it is precisely during the event that it gets restarted.
   * Every neutralization is returned with **its reason**, which reaches the log
   * and the console: "ignored" with no explanation would send people looking in
   * the wrong place.
   */
  .transform(({ clockControl, ...config }) => {
    const ignores: IgnoreConfig[] = []

    if (clockControl === true || clockControl === '1' || clockControl === 'true') {
      ignores.push({
        variable: 'CLOCK_CONTROL',
        reason: "remplacé par MODE=dev, qui ouvre le réglage de l'heure",
      })
    }

    const dev = config.mode === 'dev'
    if (!dev && config.simulatedTime != null) {
      ignores.push({ variable: 'SIMULATED_TIME', reason: 'réservé au mode développement (MODE=dev)' })
    }

    return {
      ...config,
      simulatedTime: dev ? config.simulatedTime : undefined,
      // Derived from the hub's domain, and not from its URL: `http://localhost:8787`
      // is a perfectly valid public address in development, which web-push would
      // refuse as a subject — it only accepts a `mailto:` or an `https:` URL. Push
      // would then have gone silent, without saying why.
      vapidSubject: config.vapidSubject ?? `mailto:hub@${new URL(config.publicUrl).hostname}`,
      ignores,
    }
  })

export type Config = z.infer<typeof configSchema>

/**
 * Shape *before* validation: fields with a default are optional there.
 * That is what `createHub` accepts, so a caller does not have to repeat settings
 * the schema already sets.
 */
export type ConfigInput = z.input<typeof configSchema>

export { configSchema }

/** Better Auth style durations ("30m"), in milliseconds. */
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/**
 * Converts a configuration duration into milliseconds.
 *
 * Better Auth wants the string, our SQL queries want the number: the conversion
 * lives here so the two cannot diverge.
 */
export function durationMs(duration: string): number {
  const unit = duration.slice(-1) as keyof typeof UNIT_MS
  return Number.parseInt(duration, 10) * (UNIT_MS[unit] ?? 1_000)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse({
    mode: env.MODE,
    port: env.PORT,
    host: env.HOST,
    databasePath: env.DATABASE_PATH,
    publicUrl: env.PUBLIC_URL,
    viteOrigin: env.VITE_ORIGIN,
    regieViteOrigin: env.REGIE_VITE_ORIGIN,
    authSecret: env.BETTER_AUTH_SECRET,
    programSourceUrl: env.PROGRAM_SOURCE_URL,
    logLevel: env.LOG_LEVEL,
    devicePollInterval: env.DEVICE_POLL_INTERVAL,
    deviceCodeTtl: env.DEVICE_CODE_TTL,
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    googleHostedDomain: env.GOOGLE_HOSTED_DOMAIN,
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: env.VAPID_PRIVATE_KEY,
    vapidSubject: env.VAPID_SUBJECT,
    s3Endpoint: env.S3_ENDPOINT,
    s3Region: env.S3_REGION,
    s3Bucket: env.S3_BUCKET,
    s3CaCert: env.S3_CA_CERT,
    s3AccessKeyId: env.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle: env.S3_FORCE_PATH_STYLE,
    vodAbandonMinutes: env.VOD_ABANDON_MINUTES,
    socialHashtag: env.SOCIAL_HASHTAG,
    mastodonInstance: env.MASTODON_INSTANCE,
    xBearerToken: env.X_BEARER_TOKEN,
    socialPollIntervalMs: env.SOCIAL_POLL_INTERVAL_MS,
    simulatedTime: env.SIMULATED_TIME,
    clockControl: env.CLOCK_CONTROL,
  })

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(racine)'} : ${issue.message}`)
      .join('\n')
    throw new Error(`Configuration du hub invalide :\n${details}`)
  }
  return parsed.data
}
