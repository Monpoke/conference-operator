import { z } from 'zod'

/**
 * Version du protocole, négociée à l'enrôlement et à chaque sync.
 *
 * Le hub et un client de salle peuvent tourner sur des binaires différents le
 * jour J (une machine pas remise à jour, ça arrive) : le hub doit pouvoir le
 * détecter et refuser proprement plutôt que d'échouer sur un champ manquant.
 */
export const PROTOCOL_VERSION = 1

export const roomIdSchema = z.string().min(1)
export const sessionIdSchema = z.string().min(1)

/** ULID généré côté client : trié par le temps, et donc utilisable comme clé d'ordre. */
export const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'ULID attendu')

export const isoDateTimeSchema = z.iso.datetime({ offset: true })

/**
 * Rôles de scène. Le client ne connaît que des rôles ; le mapping vers les noms
 * de scènes OBS réels vit dans la config de chaque salle, pour qu'une salle
 * puisse nommer ses scènes comme elle veut.
 */
export const sceneRoleSchema = z.enum([
  'LIVE',
  'HOLD',
  'TALK',
  'CAM_ONLY',
  'SLIDES_ONLY',
  'RELAY',
])
export type SceneRole = z.infer<typeof sceneRoleSchema>

/**
 * Mode d'exécution d'un poste — hub comme salle.
 *
 * `dev` déverrouille les commodités de développement (heure simulée, OBS
 * simulé) ; `production` les refuse, même laissées dans un fichier
 * d'environnement. Circule entre hub et salle pour que chacun sache dans quoi
 * il parle : une salle de développement branchée sur le hub de l'événement est
 * exactement le genre d'accident qu'on veut voir de loin.
 */
export const modeExecutionSchema = z.enum(['production', 'dev'])
export type ModeExecution = z.infer<typeof modeExecutionSchema>

/** OBS-A = projection vidéoprojecteur, OBS-B = captation/VOD. */
export const obsInstanceSchema = z.enum(['A', 'B'])
export type ObsInstance = z.infer<typeof obsInstanceSchema>

/**
 * Ce que la page display rend hors-live. Piloté par l'état, pas par des scènes
 * OBS : changer de contenu ne doit jamais demander de toucher à OBS.
 */
export const displayModeSchema = z.enum([
  'sponsors',
  'programme',
  /** QR OpenFeedback du talk en cours : « notez cette conférence ». */
  'feedback',
  /**
   * La question choisie en régie, en grand.
   *
   * Le bandeau vidéo ne touche que ceux qui regardent l'écran de captation ou
   * la scène live ; ce mode-ci la met devant toute la salle, quel que soit ce
   * qu'OBS diffuse au même moment.
   */
  'question',
  'countdown',
  'message',
  'wall',
  /**
   * Boucle d'attente : sponsors, programme de la salle, autres salles, réseaux.
   *
   * Ce qu'on laisse tourner pendant les pauses. Les modes `sponsors` et
   * `programme` restent disponibles seuls : quand quelque chose se passe, on
   * veut pouvoir figer l'écran sur une page précise plutôt que d'attendre que
   * la boucle y revienne.
   */
  'loop',
  'live',
])
export type DisplayMode = z.infer<typeof displayModeSchema>

export const connectivitySchema = z.enum(['ONLINE', 'DEGRADED', 'OFFLINE'])
export type Connectivity = z.infer<typeof connectivitySchema>

/**
 * `required` : persisté, rejoué jusqu'à `expiresAt`. Perdre l'événement fausserait
 * la VOD ou l'historique de la salle.
 * `best-effort` : télémétrie. Périmé vite, écrasé par `dedupKey`, jetable.
 */
export const deliverySchema = z.enum(['required', 'best-effort'])
export type Delivery = z.infer<typeof deliverySchema>
