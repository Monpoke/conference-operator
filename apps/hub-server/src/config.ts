import { z } from 'zod'

/**
 * Configuration lue une fois au démarrage et validée strictement.
 *
 * Un hub qui démarre avec une variable manquante le jour J est pire qu'un hub
 * qui refuse de démarrer : on veut l'échec au déploiement, pas en salle.
 */
/** Un réglage trouvé dans l'environnement et laissé sans effet, avec pourquoi. */
export interface IgnoreConfig {
  variable: string
  raison: string
}

const configSchema = z.object({
  /**
   * Mode d'exécution du hub.
   *
   * Un seul interrupteur devant les commodités de développement, plutôt qu'une
   * variable par commodité : le jour J, ce qu'on veut vérifier tient en une
   * ligne. Par défaut `production`, parce que le défaut doit être le cas
   * dangereux — un hub d'événement démarré sans rien préciser ne doit rien
   * simuler.
   */
  mode: z.enum(['production', 'dev']).default('production'),
  /** `0` demande au système un port libre — utile en test et en développement. */
  port: z.coerce.number().int().min(0).max(65535).default(8787),
  host: z.string().default('0.0.0.0'),
  databasePath: z.string().default('./data/hub.db'),
  /** Base publique du hub, utilisée par Better Auth et l'URI de vérification device. */
  publicUrl: z.url().default('http://localhost:8787'),
  authSecret: z.string().min(32, 'BETTER_AUTH_SECRET doit faire au moins 32 caractères'),
  /** URL de l'export « conference-center » importé par défaut. */
  programSourceUrl: z.url().optional(),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * Cadence de polling imposée aux machines pendant l'appairage (RFC 8628).
   * Abaissée dans les tests pour ne pas attendre 5 s entre deux sondages.
   */
  devicePollInterval: z
    .custom<`${number}${'s' | 'm'}`>((value) => typeof value === 'string' && /^\d+[sm]$/.test(value))
    .default('5s'),
  /**
   * Durée de vie d'un code d'appairage — et, avec elle, celle d'une demande
   * dans la file de la console.
   *
   * Un seul réglage pour les deux : un code mort dont la demande reste affichée
   * fait cliquer « Approuver » sur quelque chose qui ne peut plus aboutir, et
   * la file finit par ne plus vouloir rien dire.
   *
   * Court par défaut, à l'inverse de la valeur RFC : une file qui se vide seule
   * vaut mieux qu'un code qui survit à la journée. Rien n'est perdu quand il
   * expire — la boucle de supervision en redemande un sous 15 s, et l'écran de
   * régie affiche le nouveau. Ce qui se paie, c'est la traversée de la salle :
   * un opérateur qui recopie le code et marche jusqu'à la console peut arriver
   * après sa mort. **Le jour J, poser `DEVICE_CODE_TTL=30m`** ; la console dit
   * de toute façon en clair qu'un code a expiré.
   */
  deviceCodeTtl: z
    .custom<`${number}${'s' | 'm' | 'h'}`>(
      (value) => typeof value === 'string' && /^\d+[smh]$/.test(value),
    )
    .default('2m'),

  /**
   * Connexion des opérateurs par Google Workspace.
   *
   * Les deux identifiants viennent du client OAuth « Application Web » de la
   * console Google Cloud. Absents, le hub ne monte pas le fournisseur et la
   * console ne propose que le mot de passe — c'est le cas par défaut, et un
   * hub d'événement doit pouvoir démarrer sans compte Google.
   */
  googleClientId: z.string().optional(),
  googleClientSecret: z.string().optional(),
  /**
   * Domaine Workspace admis. **Tout compte de ce domaine est un opérateur.**
   *
   * Envoyé à Google comme indice `hd`, et surtout **revérifié contre la
   * revendication `hd` du jeton d'identité** au retour : l'indice seul est une
   * suggestion d'écran de choix, qu'un compte personnel contourne.
   *
   * Sans défaut, et obligatoire dès que Google est configuré : un domaine écrit
   * en dur dans le code n'appartient qu'à un organisateur, et le laisser servir
   * de repli ouvrirait la console d'un autre événement au personnel du
   * premier. Le hub refuse donc de démarrer plutôt que de deviner — c'est la
   * même règle que pour les deux identifiants, et pour la même raison.
   */
  googleHostedDomain: z.string().min(1).optional(),

  /**
   * Clés VAPID des notifications poussées (RFC 8292).
   *
   * Facultatives : sans elles, le hub en fabrique une paire au premier
   * démarrage et la garde en base. Les renseigner sert à survivre à une base
   * recréée — des clés qui changent invalident tous les abonnements, et
   * personne ne se réabonne deux fois.
   */
  vapidPublicKey: z.string().optional(),
  vapidPrivateKey: z.string().optional(),
  /**
   * Contact que la RFC 8292 impose d'annoncer aux services de push.
   *
   * Une adresse `mailto:` ou une URL `https:`. Absent, le hub le dérive de son
   * propre domaine (`mailto:hub@<domaine>`) : un dépôt ne doit pas embarquer
   * l'adresse de contact d'un organisateur, qui recevrait alors les
   * signalements d'abus de tous les autres.
   *
   * **À renseigner en production** : le dérivé est syntaxiquement valide et
   * pointe le bon domaine, mais rien ne garantit que quelqu'un relève cette
   * boîte, et c'est bien à un humain que le service de push écrira.
   */
  vapidSubject: z.string().optional(),

  /** Hashtag suivi sur les réseaux. Vide = aucune ingestion sociale. */
  socialHashtag: z.string().optional(),
  /** Instance Mastodon interrogée pour la timeline publique du hashtag. */
  mastodonInstance: z.url().optional(),
  /**
   * Clé X. Absente, l'adapter reste déclaré mais refuse explicitement : la
   * recherche par hashtag nécessite un plan payant.
   */
  xBearerToken: z.string().optional(),
  socialPollIntervalMs: z.coerce.number().int().positive().default(30_000),

  /**
   * Heure simulée du hub (ISO 8601). Développement uniquement.
   *
   * Déplace tout le système : les salles s'alignent sur l'heure du hub, donc
   * il n'y a rien à régler de leur côté. Permet de dérouler une journée
   * d'événement des mois avant qu'elle ait lieu.
   */
  simulatedTime: z.iso.datetime({ offset: true }).optional(),

  /**
   * Ancien interrupteur du réglage de l'heure. **Obsolète.**
   *
   * Le réglage suit désormais `MODE` : ouvert en développement, fermé en
   * production. Le champ ne subsiste que pour être *détecté* — le trouver dans
   * un `.env` veut dire que quelqu'un croit avoir ouvert quelque chose, et le
   * taire ferait chercher ailleurs. Il n'est jamais lu ensuite.
   */
  clockControl: z.union([z.string(), z.boolean()]).optional(),
})
  /**
   * Un Google à moitié configuré ne démarre pas.
   *
   * Le laisser passer monterait un hub où le bouton « Continuer avec Google »
   * échoue à chaque clic, ou n'apparaît pas alors que la variable est bien là :
   * dans les deux cas on cherche la panne dans la console Google Cloud, pas
   * dans un `.env` amputé d'une ligne.
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
   * Google sans domaine ne démarre pas.
   *
   * Le domaine *est* la liste des opérateurs : sans lui, il n'y a pas de
   * frontière à faire respecter, et l'oubli ne se verrait qu'au premier compte
   * personnel qui entre — c'est-à-dire trop tard.
   */
  .refine((config) => config.googleClientId == null || config.googleHostedDomain != null, {
    path: ['googleHostedDomain'],
    message:
      'GOOGLE_HOSTED_DOMAIN est obligatoire avec GOOGLE_CLIENT_ID : il décide qui est opérateur',
  })
  /**
   * Garde-fou du mode production, et rappel des variables obsolètes.
   *
   * Les réglages de développement sont **neutralisés**, pas refusés : un hub
   * qui ne redémarre pas parce qu'une ligne traîne dans un `.env` serait pire
   * que le mal qu'on soigne — c'est justement en cours d'événement qu'on le
   * relance. Chaque neutralisation est rendue avec **sa raison**, qui remonte
   * au journal et à la console : « ignoré » sans explication enverrait
   * chercher au mauvais endroit.
   */
  .transform(({ clockControl, ...config }) => {
    const ignores: IgnoreConfig[] = []

    if (clockControl === true || clockControl === '1' || clockControl === 'true') {
      ignores.push({
        variable: 'CLOCK_CONTROL',
        raison: "remplacé par MODE=dev, qui ouvre le réglage de l'heure",
      })
    }

    const dev = config.mode === 'dev'
    if (!dev && config.simulatedTime != null) {
      ignores.push({ variable: 'SIMULATED_TIME', raison: 'réservé au mode développement (MODE=dev)' })
    }

    return {
      ...config,
      simulatedTime: dev ? config.simulatedTime : undefined,
      // Dérivé du domaine du hub, et non de son URL : `http://localhost:8787`
      // est une adresse publique parfaitement valable en développement, que
      // web-push refuserait comme sujet — il n'accepte qu'un `mailto:` ou une
      // URL `https:`. Le push se serait alors tu, sans dire pourquoi.
      vapidSubject: config.vapidSubject ?? `mailto:hub@${new URL(config.publicUrl).hostname}`,
      ignores,
    }
  })

export type Config = z.infer<typeof configSchema>

/**
 * Forme *avant* validation : les champs à valeur par défaut y sont facultatifs.
 * C'est ce qu'accepte `createHub`, pour qu'un appelant n'ait pas à répéter des
 * réglages que le schéma pose déjà.
 */
export type ConfigInput = z.input<typeof configSchema>

export { configSchema }

/** Durées façon Better Auth (« 30m »), en millisecondes. */
const UNITE_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/**
 * Convertit une durée de configuration en millisecondes.
 *
 * Better Auth veut la chaîne, nos requêtes SQL veulent le nombre : la
 * conversion vit ici pour que les deux ne puissent pas diverger.
 */
export function dureeEnMs(duree: string): number {
  const unite = duree.slice(-1) as keyof typeof UNITE_MS
  return Number.parseInt(duree, 10) * (UNITE_MS[unite] ?? 1_000)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse({
    mode: env.MODE,
    port: env.PORT,
    host: env.HOST,
    databasePath: env.DATABASE_PATH,
    publicUrl: env.PUBLIC_URL,
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
