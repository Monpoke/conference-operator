import { betterAuth } from 'better-auth'
import type { BetterAuthOptions } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { bearer } from 'better-auth/plugins'
import { deviceAuthorization } from 'better-auth/plugins/device-authorization'
import type { SqliteDatabase } from '@conference-operator/db'

/**
 * Better Auth style duration ("5s", "30m"). The package's `TimeString` type is
 * not publicly exported; this subset is assignable to it and is enough for our
 * settings.
 */
export type Duration = `${number}${'s' | 'm' | 'h' | 'd'}`

export interface AuthDeps {
  sqlite: SqliteDatabase
  secret: string
  publicUrl: string
  /** Called when a machine requests pairing — feeds the admin console's queue. */
  onDeviceRequest: (clientId: string, scope: string | undefined) => void
  /** Decides whether a `client_id` is acceptable (ULID format on the room client). */
  isKnownClient: (clientId: string) => boolean
  /**
   * Polling cadence imposed on the machine. Lowered in the tests; in production
   * the RFC default is more than enough.
   */
  deviceInterval?: Duration
  deviceCodeExpiresIn?: Duration
  /**
   * Google Workspace sign-in, if the hub has the credentials.
   *
   * Absent, only the password opens the console. The hub must be able to start
   * and open without Google: on the day, an internet outage must not lock the
   * team out.
   */
  google?: { clientId: string; clientSecret: string; hostedDomain: string }
}

/**
 * Better Auth: remote authentication of the operators (hub-admin) and pairing of
 * the room machines through the *device authorization grant* (RFC 8628).
 *
 * Why that flow for the rooms: a control PC has neither a practical keyboard nor
 * a browser at first boot, and we do not want a password shared across three
 * machines. The machine shows a short code, an already authenticated operator
 * approves it from the admin console, the machine receives its own token —
 * individually revocable.
 *
 * Note: `/device/approve` binds the device to **the user who approves**. The
 * machine → room association is therefore not handled by Better Auth but by our
 * `room_device` table.
 */
export function createAuthOptions({
  sqlite,
  secret,
  publicUrl,
  onDeviceRequest,
  isKnownClient,
  deviceInterval = '5s',
  deviceCodeExpiresIn = '10m',
  google,
}: AuthDeps) {
  return {
    // The same SQLite file as the rest of the hub: one lock, one backup.
    database: sqlite,
    secret,
    baseURL: publicUrl,
    basePath: '/api/auth',
    emailAndPassword: {
      enabled: true,
      // Accounts created by the organization, no open sign-up on a public hub.
      disableSignUp: true,
    },
    plugins: [
      // Bearer tokens: the room client has no cookie jar.
      bearer(),
      deviceAuthorization({
        /**
         * Short of the RFC's value, long enough to cross a room between reading
         * the code and reaching the console. The machine asks for another within
         * 15 s if it expires anyway — its supervision loop is made for that. The
         * trade-off is argued where the default lives, in `config.ts`.
         */
        expiresIn: deviceCodeExpiresIn,
        /**
         * Polling cadence. Polling faster returns `slow_down` (RFC 8628 §3.5):
         * the client must respect this value and slow down further if it receives
         * that code.
         */
        interval: deviceInterval,
        /** Code read aloud or typed by hand: short, with no ambiguous characters. */
        userCodeLength: 8,
        /**
         * Address shown on the control screen during pairing.
         *
         * Better Auth appends `?user_code=…` to it: the console prefills the
         * code, which saves copying eight characters from the other end of a
         * room.
         */
        verificationUri: `${publicUrl}/admin/devices`,
        validateClient: (clientId) => isKnownClient(clientId),
        onDeviceAuthRequest: (clientId, scope) => {
          onDeviceRequest(clientId, scope)
        },
      }),
    ],
    /**
     * Google Workspace: **every account of the domain is an operator.**
     *
     * That is the assumed choice for an organization's hub — the directory does
     * the directory's job, and nobody has to provision one more account on the
     * morning of the event. The domain is the only boundary, hence the care taken
     * over `hd`: Better Auth sends it to Google *and* rechecks it against the
     * identity token's claim on the way back. Without that second check, `hd`
     * would only be a chooser-screen preference, which a personal account gets
     * around.
     */
    ...(google == null
      ? {}
      : {
          socialProviders: {
            google: {
              clientId: google.clientId,
              clientSecret: google.clientSecret,
              hd: google.hostedDomain,
            },
          },
          account: {
            /**
             * An already provisioned operator finds their account again.
             *
             * Without linking, the first pass through Google would fail on an
             * address already known — that of the fallback account created from
             * the CLI. The provider is trustworthy because `hd` is verified: the
             * address really does belong to the domain.
             */
            accountLinking: { enabled: true, trustedProviders: ['google'] },
          },
        }),
  } satisfies BetterAuthOptions
}

export type AuthOptions = ReturnType<typeof createAuthOptions>

export function createAuth(options: AuthOptions) {
  return betterAuth(options)
}

/**
 * Creates Better Auth's tables (`user`, `session`, `account`, `verification`,
 * `deviceCode`).
 *
 * We go through the programmatic API rather than `@better-auth/cli migrate`: it
 * is idempotent, it runs at the hub's startup, and above all it works on an
 * in-memory database — so the tests have no file to provision.
 */
export async function migrateAuth(options: AuthOptions): Promise<void> {
  const { runMigrations } = await getMigrations(options)
  await runMigrations()
}

export type Auth = ReturnType<typeof createAuth>
