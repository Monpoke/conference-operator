import { betterAuth } from 'better-auth'
import type { BetterAuthOptions } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { bearer } from 'better-auth/plugins'
import { deviceAuthorization } from 'better-auth/plugins/device-authorization'
import type { SqliteDatabase } from '@cloudnord/db'

/**
 * Durée façon Better Auth (« 5s », « 30m »). Le type `TimeString` du paquet
 * n'est pas exporté publiquement ; ce sous-ensemble lui est assignable et
 * suffit à nos réglages.
 */
export type Duration = `${number}${'s' | 'm' | 'h' | 'd'}`

export interface AuthDeps {
  sqlite: SqliteDatabase
  secret: string
  publicUrl: string
  /** Appelé quand une machine demande un appairage — alimente la file de l'admin. */
  onDeviceRequest: (clientId: string, scope: string | undefined) => void
  /** Décide si un `client_id` est recevable (format ULID côté client de salle). */
  isKnownClient: (clientId: string) => boolean
  /**
   * Cadence de polling imposée à la machine. Abaissée dans les tests ; en
   * production la valeur RFC par défaut suffit largement.
   */
  deviceInterval?: Duration
  deviceCodeExpiresIn?: Duration
}

/**
 * Better Auth : authentification distante des opérateurs (hub-admin) et
 * appairage des machines de salle par *device authorization grant* (RFC 8628).
 *
 * Pourquoi ce flux pour les salles : un PC de régie n'a pas de clavier pratique
 * ni de navigateur au premier boot, et on ne veut pas de mot de passe partagé
 * sur trois machines. La machine affiche un code court, un opérateur déjà
 * authentifié l'approuve depuis l'admin, la machine reçoit un jeton propre —
 * révocable individuellement.
 *
 * Attention : `/device/approve` lie l'appareil à **l'utilisateur qui approuve**.
 * L'association machine → salle n'est donc pas gérée par Better Auth mais par
 * notre table `room_device`.
 */
export function createAuthOptions({
  sqlite,
  secret,
  publicUrl,
  onDeviceRequest,
  isKnownClient,
  deviceInterval = '5s',
  deviceCodeExpiresIn = '30m',
}: AuthDeps) {
  return {
    // Même fichier SQLite que le reste du hub : un seul verrou, une seule sauvegarde.
    database: sqlite,
    secret,
    baseURL: publicUrl,
    basePath: '/api/auth',
    emailAndPassword: {
      enabled: true,
      // Comptes créés par l'organisation, pas d'inscription ouverte sur un hub public.
      disableSignUp: true,
    },
    plugins: [
      // Jetons porteurs : le client de salle n'a pas de cookie jar.
      bearer(),
      deviceAuthorization({
        /** Large : une machine peut être branchée bien avant qu'un opérateur ne l'approuve. */
        expiresIn: deviceCodeExpiresIn,
        /**
         * Cadence de polling. Poller plus vite renvoie `slow_down`
         * (RFC 8628 §3.5) : le client doit respecter cette valeur et ralentir
         * encore s'il reçoit ce code.
         */
        interval: deviceInterval,
        /** Code lu à voix haute ou saisi à la main : court, sans caractères ambigus. */
        userCodeLength: 8,
        /**
         * Adresse affichée à l'écran de régie pendant l'appairage.
         *
         * Better Auth y ajoute `?user_code=…` : la console pré-remplit le code,
         * ce qui évite de recopier huit caractères depuis l'autre bout d'une salle.
         */
        verificationUri: `${publicUrl}/admin/devices`,
        validateClient: (clientId) => isKnownClient(clientId),
        onDeviceAuthRequest: (clientId, scope) => {
          onDeviceRequest(clientId, scope)
        },
      }),
    ],
  } satisfies BetterAuthOptions
}

export type AuthOptions = ReturnType<typeof createAuthOptions>

export function createAuth(options: AuthOptions) {
  return betterAuth(options)
}

/**
 * Crée les tables de Better Auth (`user`, `session`, `account`, `verification`,
 * `deviceCode`).
 *
 * On passe par l'API programmatique plutôt que par `@better-auth/cli migrate` :
 * c'est idempotent, ça tourne au démarrage du hub, et surtout ça fonctionne sur
 * une base en mémoire — donc les tests n'ont aucun fichier à provisionner.
 */
export async function migrateAuth(options: AuthOptions): Promise<void> {
  const { runMigrations } = await getMigrations(options)
  await runMigrations()
}

export type Auth = ReturnType<typeof createAuth>
