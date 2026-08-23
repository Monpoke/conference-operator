import { z } from 'zod'
import {
  displayModeSchema,
  isoDateTimeSchema,
  sceneRoleSchema,
  sessionIdSchema,
} from './primitives.js'
import { sessionStatusSchema } from './room-state.js'

/**
 * Commandes descendantes (hub → salle).
 *
 * Transportées par un Event Iterator estampillé avec `seq` : à la reconnexion,
 * oRPC renvoie le dernier `lastEventId` reçu et le hub reprend juste après. Pas
 * de compteur de rattrapage maison — voir `spikes/orpc-v2/FINDINGS.md`.
 */

/** Ce qu'un bandeau live affiche. Court : il partage l'écran avec la vidéo. */
export const bandeauSchema = z.object({
  text: z.string().min(1).max(240),
  level: z.enum(['info', 'warning', 'urgent']),
})
export type Bandeau = z.infer<typeof bandeauSchema>

/**
 * Modèles de bandeau, prêts à envoyer.
 *
 * Constants et partagés plutôt que stockés : ce sont les quelques phrases
 * qu'on met à l'antenne sans réfléchir, un jour d'événement, et les retaper
 * sous pression est le meilleur moyen de les rater. Le texte reste modifiable
 * avant envoi — ce sont des points de départ, pas des rails.
 */
export const MODELES_BANDEAU: { nom: string; message: Bandeau }[] = [
  { nom: 'Questions', message: { text: 'Posez vos questions sur le mur — QR code à l\'écran', level: 'info' } },
  { nom: 'Pause', message: { text: 'Pause de 15 minutes — reprise juste après', level: 'info' } },
  { nom: 'Micro', message: { text: 'Problème de son en cours de résolution', level: 'warning' } },
  { nom: 'Retard', message: { text: 'La conférence commencera avec quelques minutes de retard', level: 'warning' } },
  { nom: 'Enregistrement', message: { text: 'Cette session est enregistrée et sera disponible en ligne', level: 'info' } },
]

export const commandPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('scene.force'),
    role: sceneRoleSchema,
  }),
  z.object({
    type: z.literal('display.set'),
    mode: displayModeSchema,
    sessionId: sessionIdSchema.nullable().default(null),
  }),
  z.object({
    type: z.literal('message.broadcast'),
    text: z.string().min(1).max(500),
    level: z.enum(['info', 'warning', 'urgent']),
    /**
     * Qui doit voir ce message.
     *
     * Distinction essentielle : `operator` se contente du bandeau de la régie,
     * `audience` prend l'écran de la salle. Sans elle, une note adressée à
     * l'opérateur — « ton speaker est arrivé » — s'afficherait en grand devant
     * le public.
     */
    target: z.enum(['operator', 'audience']).default('operator'),
    /** Auteur affiché, pour qu'on sache à qui répondre. */
    from: z.string().max(80).nullable().default(null),
  }),
  z.object({
    /**
     * Bandeau des scènes live.
     *
     * À ne pas confondre avec `message.broadcast`, qui **prend** l'écran de la
     * salle : celui-ci se superpose à la vidéo sans rien interrompre. Le
     * speaker continue, ses slides restent visibles, et le bandeau part dans
     * le direct et la VOD comme le reste de l'habillage.
     */
    type: z.literal('overlay.set'),
    /** `null` retire le bandeau. C'est le « masquer » de la console. */
    message: bandeauSchema.nullable(),
  }),
  z.object({
    /** Un nouveau snapshot est disponible : le client resynchronise. */
    type: z.literal('program.invalidate'),
    contentHash: z.string(),
  }),
  z.object({
    /**
     * Resynchronisation complète demandée depuis la console.
     *
     * Distincte de `program.invalidate`, qui annonce un fait — le programme a
     * changé — et laisse la salle ne retélécharger que ce qui a bougé. Ici rien
     * n'a changé sur le hub : c'est la salle qu'on soupçonne d'avoir dérivé, et
     * on lui demande de tout relire sans se fier à ce qu'elle a en cache.
     *
     * Le geste existe parce qu'il n'y en avait pas d'autre : remettre une salle
     * d'aplomb demandait de la redémarrer, donc de couper sa captation.
     */
    type: z.literal('room.resync'),
    /** Qui l'a demandée : la salle le trace, on saura d'où vient le geste. */
    requestedBy: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal('wall.approved'),
    commentId: z.string(),
  }),
  z.object({
    type: z.literal('session.override'),
    sessionId: sessionIdSchema,
    status: z.enum(['delayed', 'cancelled', 'moved']),
    delayMinutes: z.number().int().optional(),
    note: z.string().max(300).optional(),
  }),
  z.object({
    /** L'état d'une conférence a changé — décidé ailleurs, ou par la règle horaire. */
    type: z.literal('session.state'),
    sessionId: sessionIdSchema,
    /**
     * Salle concernée.
     *
     * La commande est diffusée à **toutes** les salles : une régie doit pouvoir
     * signaler « Track #2 vient de terminer » sans interroger le hub. Chaque
     * salle décide ensuite si l'événement la concerne ou relève de la
     * notification.
     */
    roomId: z.string().nullable(),
    sessionTitle: z.string().nullable(),
    status: sessionStatusSchema,
    decidedBy: z.string(),
  }),
  z.object({
    /**
     * L'heure du hub a changé.
     *
     * Les salles calent leur offset sur `serverTime` à chaque synchronisation ;
     * sans cette diffusion, elles resteraient sur l'ancienne heure jusqu'à la
     * suivante — soit un écran qui affiche un autre moment que la console.
     */
    type: z.literal('clock.changed'),
    serverTime: isoDateTimeSchema,
    simulated: z.boolean(),
  }),
  z.object({
    type: z.literal('stream.configure'),
    rtmpUrl: z.string(),
    streamKey: z.string(),
  }),
])
export type CommandPayload = z.infer<typeof commandPayloadSchema>
export type CommandType = CommandPayload['type']

/**
 * Forme *avant* validation : les champs à valeur par défaut y sont facultatifs.
 *
 * C'est ce que doivent accepter les publieurs — exiger `sessionId: null` sur un
 * `display.set` alors que le schéma le remplit tout seul serait un faux
 * frottement à chaque appel.
 */
export type CommandPayloadInput = z.input<typeof commandPayloadSchema>

export const commandSchema = z.object({
  /** Monotone par salle. Sert aussi d'`id` d'événement pour la reprise oRPC. */
  seq: z.number().int().positive(),
  issuedAt: isoDateTimeSchema,
  /**
   * Durée de validité. Une commande rattrapée après expiration est *écartée* :
   * un « pause déjeuner » reçu 40 minutes en retard ne doit pas s'afficher.
   * `null` = pas d'expiration (changement d'état durable).
   */
  ttlSeconds: z.number().int().positive().nullable(),
  payload: commandPayloadSchema,
})
export type Command = z.infer<typeof commandSchema>

/** Une commande est-elle encore applicable ? Utilisé au rattrapage. */
export function isCommandExpired(command: Command, nowMs: number): boolean {
  if (command.ttlSeconds == null) return false
  return nowMs > Date.parse(command.issuedAt) + command.ttlSeconds * 1000
}
