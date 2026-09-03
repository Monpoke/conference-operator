import { eq } from 'drizzle-orm'
import {
  CONTROL_LOCK_TTL_MS,
  CONTROL_COMMAND_TTL,
  controlLockSchema,
  controlViewSchema,
  type CommandPayloadInput,
  type ControlCommand,
  type ControlLock,
  type ControlRoom,
  type ControlView,
  type SceneRole,
} from '@cloudnord/contract'
import {
  talkToControl,
  stateOfSlots,
  type SessionStatuses,
} from '@cloudnord/room-state'
import { DEFAULT_TIMEZONE, sessionsForRoom } from '@cloudnord/program'
import { regieLock } from '@cloudnord/db/hub'
import type { HubDatabase } from '../db.js'
import type { Services } from '../context.js'

/**
 * Le verrou de la régie mobile, et la vue qu'elle affiche.
 *
 * Deux choses dans un même service parce qu'elles se lisent d'un même appel :
 * `view()` est à la fois « où en est la salle » et « je tiens toujours la
 * salle ». Un battement séparé serait un second geste à ne pas oublier
 * d'arrêter — et un verrou qui survit à la page qui le tenait.
 *
 * Ce que le verrou **ne** fait pas : rien en salle. L'opérateur devant la
 * machine garde toutes ses commandes, quoi qu'il arrive à un téléphone parti
 * dans un couloir. Le verrou n'exclut que les régies mobiles entre elles.
 */

/** Refus d'un geste, à traduire en `CONFLICT` par le routeur. */
export class VerrouTenu extends Error {
  constructor(readonly lock: ControlLock) {
    super(`${lock.holder} tient la régie de cette salle`)
    this.name = 'VerrouTenu'
  }
}

/** La salle visée n'existe pas. Le routeur en fait un `NOT_FOUND`. */
export class SalleInconnue extends Error {
  constructor(readonly roomId: string) {
    super(`Salle inconnue : ${roomId}`)
    this.name = 'SalleInconnue'
  }
}

export class RegieService {
  constructor(
    private readonly db: HubDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Le verrou vivant d'une salle, ou `null`.
   *
   * L'expiration se calcule ici et nulle part ailleurs : la ligne peut survivre
   * à son échéance sans que cela signifie quoi que ce soit. Un balayage se
   * charge de la retirer et d'éteindre le badge en salle, mais il n'est pas ce
   * qui fait autorité — sans quoi un verrou mort resterait opposable pendant
   * les quinze secondes qui le séparent du tour suivant.
   */
  lock(roomId: string): ControlLock | null {
    const row = this.db.select().from(regieLock).where(eq(regieLock.roomId, roomId)).get()
    if (row == null) return null
    const expiresAtMs = Date.parse(row.lastSeenAt) + CONTROL_LOCK_TTL_MS
    if (expiresAtMs <= this.now()) return null
    return controlLockSchema.parse({
      roomId: row.roomId,
      holder: row.holder,
      holderId: row.holderId,
      heldSince: row.heldSince,
      lastSeenAt: row.lastSeenAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
    })
  }

  /**
   * Prend la salle, ou renouvelle une prise.
   *
   * **C'est la session qui tranche, pas le compte.** Deux onglets d'une même
   * personne — le téléphone dans la poche, la tablette posée sur la table —
   * pilotaient sinon la même salle en se croyant seuls, ce qui est exactement
   * la situation que ce verrou existe pour supprimer.
   *
   * Le renouvellement **conserve `heldSince`** : c'est depuis quand cet
   * onglet-là tient la salle, et c'est ce que lit l'autre opérateur avant de
   * décider s'il la reprend. Le réécrire à chaque battement afficherait
   * « depuis 1 seconde » toute la journée, ce qui ne répond à rien.
   *
   * Une reprise, elle, le réinitialise : c'est une autre prise.
   */
  hold(roomId: string, holder: string, holderId: string, force: boolean): ControlLock {
    const actuel = this.lock(roomId)
    if (actuel != null && actuel.holderId !== holderId && !force) throw new VerrouTenu(actuel)

    const maintenant = new Date(this.now()).toISOString()
    const heldSince = actuel?.holderId === holderId ? actuel.heldSince : maintenant
    const values = { roomId, holder, holderId, heldSince, lastSeenAt: maintenant }
    this.db
      .insert(regieLock)
      .values(values)
      .onConflictDoUpdate({ target: regieLock.roomId, set: values })
      .run()

    return controlLockSchema.parse({
      ...values,
      expiresAt: new Date(this.now() + CONTROL_LOCK_TTL_MS).toISOString(),
    })
  }

  /**
   * Rend la salle. Sans effet si l'appelant ne la tenait pas.
   *
   * Sur la **session** encore : un onglet qui se ferme ne doit pas rendre la
   * salle que l'autre onglet de la même personne est en train de piloter.
   *
   * Vrai seulement quand quelque chose a été libéré : c'est ce qui décide s'il
   * faut diffuser un changement de porteur en salle. Rendre une salle qu'on ne
   * tenait pas ne doit éteindre le badge de personne.
   */
  release(roomId: string, holderId: string): boolean {
    const actuel = this.lock(roomId)
    if (actuel == null || actuel.holderId !== holderId) return false
    this.db.delete(regieLock).where(eq(regieLock.roomId, roomId)).run()
    return true
  }

  /**
   * Retire les verrous périmés et dit lesquels.
   *
   * Appelé par la veille de supervision, dont c'est déjà le rythme. L'appelant
   * diffuse un `regie.hold {holder: null}` par salle rendue : sans cela le
   * badge « pilotée à distance » resterait allumé en salle sur un verrou que
   * plus personne ne tient — et c'est le genre de mention qu'on finit par ne
   * plus lire.
   */
  sweep(): string[] {
    const limite = this.now() - CONTROL_LOCK_TTL_MS
    const perimes = this.db
      .select()
      .from(regieLock)
      .all()
      .filter((row) => Date.parse(row.lastSeenAt) <= limite)
      .map((row) => row.roomId)

    for (const roomId of perimes) {
      this.db.delete(regieLock).where(eq(regieLock.roomId, roomId)).run()
    }
    return perimes
  }
}

/**
 * Les salles et leur verrou, pour l'écran de choix.
 *
 * Réutilise `statuses()` plutôt que de relire les salles : c'est la même
 * connectivité et le même état de conférence que peint la console, et deux
 * lectures divergentes de la même salle sont exactement ce que ce dépôt évite
 * partout ailleurs.
 */
export function sallesDeRegie(services: Services, at: number): ControlRoom[] {
  const snapshot = services.programs.active()
  return services.rooms.statuses().map((statut) => ({
    roomId: statut.roomId,
    name: statut.name,
    conference:
      snapshot == null
        ? ('aucune' as const)
        : stateOfSlots(
            sessionsForRoom(snapshot.program, statut.roomId),
            at,
            statutsDeLaSalle(services, statut.roomId),
          ),
    connectivity: statut.connectivity,
    lock: services.regie.lock(statut.roomId),
  }))
}

/**
 * Tout ce qu'une régie mobile affiche d'une salle.
 *
 * Recomposé à chaque appel depuis ce qui existe déjà — programme actif, cycle
 * de vie, configuration de la salle, dernier battement. Rien n'est stocké sous
 * cette forme, et c'est voulu : un instantané persisté serait une seconde
 * version de la vérité, qui finirait par contredire la console.
 *
 * **Tout ce qui dépend du temps se calcule ici.** L'horloge du hub fait foi et
 * peut être simulée ; en développement l'écart se compte en semaines, et le
 * navigateur n'a que la sienne.
 */
export function vueDeRegie(services: Services, roomId: string, at: number): ControlView {
  const salle = services.rooms.get(roomId)
  if (salle == null) throw new SalleInconnue(roomId)

  const statut = services.rooms.statuses().find((ligne) => ligne.roomId === roomId)
  const snapshot = services.programs.active()
  const creneaux = snapshot == null ? [] : sessionsForRoom(snapshot.program, roomId)
  const statuts = statutsDeLaSalle(services, roomId)
  const cible = talkToControl(creneaux, at, statuts)

  return controlViewSchema.parse({
    roomId,
    roomName: salle.name,
    event: services.identity.get(),
    timezone: snapshot?.program.timezone ?? DEFAULT_TIMEZONE,
    serverTime: new Date(at).toISOString(),
    simulatedClock: services.clock.simulated,

    connectivity: statut?.connectivity ?? 'OFFLINE',
    lastSeenAt: statut?.lastSeenAt ?? null,

    conference: stateOfSlots(creneaux, at, statuts),
    targetSession: cible,
    /*
     * « À venir » se lit sur l'horaire, exactement comme en régie de salle.
     * Comparer à la session courante annonçait « à venir » une conférence en
     * plein dépassement — le moment précis où elle est à l'antenne.
     */
    targetIsUpcoming: cible != null && cible.startsAtMs > at,
    sessionStates: statuts,
    sessions: creneaux,

    sceneRole: statut?.sceneRole ?? null,
    recording: statut?.recording ?? false,
    streaming: statut?.streaming ?? false,
    /*
     * `null` tant que la salle ne l'a pas dit, et pas « Boucle » par défaut :
     * la grille d'écran allumerait un bouton sur une supposition, dans une
     * page dont toute la règle est qu'un bouton actif décrit un fait.
     */
    displayMode: statut?.displayMode ?? null,

    /*
     * Les rôles mappés, pas la liste complète des rôles possibles.
     *
     * Un bouton « Relais » sur une salle qui n'en a pas montrerait quelque
     * chose que personne ne sait nommer, et échouerait à la bascule. La régie
     * de la salle lit la même chose de sa configuration.
     */
    sceneRoles: Object.entries(salle.sceneRoles.A)
      .filter(([, nom]) => nom != null && nom !== '')
      .map(([role]) => role as SceneRole),
    relaySourceRoomId: salle.relaySourceRoomId,
    promptRecordingOnStart: salle.promptRecordingOnStart,
    promptRecordingOnStop: salle.promptRecordingOnStop,
    sceneOnStart: salle.sceneOnStart,

    lock: services.regie.lock(roomId),
  })
}

/**
 * Le geste lui-même, une fois le verrou vérifié par le routeur.
 *
 * Deux natures, et `applied` les sépare : le cycle de vie s'écrit chez le hub
 * — c'est acquis au retour —, une scène ou un enregistrement part sur le flux
 * descendant et ne s'observe que sur la vue suivante. Les confondre ferait
 * croire à la régie mobile qu'un enregistrement tourne parce qu'un appel a
 * répondu 200, ce qui viderait de sens l'avertissement de « Commencer ».
 */
export function commandeDeRegie(
  services: Services,
  roomId: string,
  action: ControlCommand,
  auteur: string,
): { applied: 'now' | 'queued' } {
  switch (action.type) {
    case 'session.start':
      services.sessions.start(action.sessionId, roomId, auteur)
      return { applied: 'now' }
    case 'session.end':
      services.sessions.end(action.sessionId, roomId, auteur)
      return { applied: 'now' }
    case 'session.reset':
      services.sessions.reset(action.sessionId)
      return { applied: 'now' }
    case 'scene.set':
      publier(services, roomId, { type: 'scene.force', role: action.role, requestedBy: auteur })
      return { applied: 'queued' }
    case 'display.set':
      /*
       * Sans `sessionId` : à distance on choisit un mode, pas la conférence à
       * mettre dedans. La salle applique le mode à ce qu'elle pilote déjà, ce
       * qui est aussi ce que fait sa propre régie.
       */
      publier(services, roomId, { type: 'display.set', mode: action.mode })
      return { applied: 'queued' }
    case 'recording.set':
      publier(services, roomId, { type: 'recording.set', on: action.on, requestedBy: auteur })
      return { applied: 'queued' }
    case 'stream.set':
      publier(services, roomId, { type: 'stream.set', on: action.on, requestedBy: auteur })
      return { applied: 'queued' }
  }
}

/**
 * Publie avec le délai de validité du geste.
 *
 * Les durées vivent dans le contrat parce que les deux côtés les lisent, et
 * elles ne sont pas égales : une bascule de scène rattrapée dix minutes plus
 * tard met la salle à l'antenne sur rien, là où une captation peut encore
 * rattraper une coupure d'une minute.
 */
function publier(
  services: Services,
  roomId: string,
  payload: Extract<
    CommandPayloadInput,
    { type: 'scene.force' | 'display.set' | 'recording.set' | 'stream.set' }
  >,
): void {
  services.commands.publish(roomId, payload, CONTROL_COMMAND_TTL[payload.type])
}

function statutsDeLaSalle(services: Services, roomId: string): SessionStatuses {
  return Object.fromEntries(
    services.sessions.states(roomId).map((etat) => [etat.sessionId, etat.status]),
  )
}
