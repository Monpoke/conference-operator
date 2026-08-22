import { currentSession, roomConferenceState, type SessionStatuses } from '@cloudnord/program'
import type { RoomStatus } from '@cloudnord/contract'
import type { Services } from './context.js'
import type { PushPayload } from './services/push.js'

/**
 * État complet des salles : ce que la base sait, enrichi du programme.
 *
 * Une seule implémentation pour deux lecteurs — la console, qui interroge, et
 * la veille, qui surveille. Les séparer aurait laissé la couleur d'une pastille
 * et l'avis poussé sur un téléphone diverger, ce qui est précisément le genre
 * d'écart qu'on ne remarque qu'en salle.
 *
 * @param at Heure du hub. Elle peut être simulée, et c'est elle qui fait foi.
 */
export function statutsDesSalles(services: Services, at: number): RoomStatus[] {
  const snapshot = services.programs.active()
  const statutsDe = (roomId: string): SessionStatuses =>
    Object.fromEntries(
      services.sessions.states(roomId).map((etat) => [etat.sessionId, etat.status]),
    )

  return services.rooms.statuses().map((statut) => {
    const session = snapshot == null ? null : currentSession(snapshot.program, statut.roomId, at)
    return {
      ...statut,
      currentSession:
        session == null
          ? null
          : {
              id: session.id,
              title: session.title,
              endsAt: session.endsAt,
              remainingMs: session.endsAtMs == null ? null : session.endsAtMs - at,
            },
      conference:
        snapshot == null
          ? ('aucune' as const)
          : roomConferenceState(snapshot.program, statut.roomId, at, statutsDe(statut.roomId)),
    }
  })
}

/**
 * Ce que le hub remarque tout seul, pour le pousser aux consoles fermées.
 *
 * La console ouverte comparait deux rafraîchissements et se notifiait
 * elle-même. Console fermée, il n'y a plus personne pour comparer : le hub doit
 * le faire, et c'est le seul endroit d'où l'on peut. Les règles sont les mêmes
 * des deux côtés, à dessein — un avis qui change de sens selon que la page est
 * ouverte ou non serait pire que pas d'avis du tout.
 *
 * L'étiquette (`tag`) est celle qu'emploie aussi la page : deux notifications
 * de même étiquette se remplacent au lieu de s'empiler, ce qui évite le doublon
 * quand la console est ouverte *et* abonnée.
 */

interface VueSalle {
  connectivity: string
  conference: string
}

export class VeilleSupervision {
  private readonly vues = new Map<string, VueSalle>()
  /**
   * Codes d'appairage déjà vus. `null` tant qu'aucune passe n'a eu lieu : sans
   * cette distinction, le premier tour annoncerait comme nouvelles des demandes
   * qui attendaient déjà.
   */
  private appairages: string[] | null = null

  /**
   * Compare l'état des salles au précédent et rend ce qui mérite un avis.
   *
   * Le tout premier passage n'alerte de rien. Démarrer le hub sur une salle
   * déjà coupée n'est pas un événement, c'est un état — et trois notifications
   * à l'allumage rendraient les suivantes invisibles.
   */
  passe(statuts: RoomStatus[], attente: { clientId: string }[] = []): PushPayload[] {
    const avis: PushPayload[] = []
    const premier = this.vues.size === 0

    for (const salle of statuts) {
      const avant = this.vues.get(salle.roomId)
      this.vues.set(salle.roomId, {
        connectivity: salle.connectivity,
        conference: salle.conference,
      })
      if (premier || avant == null) continue

      const tag = `salle-${salle.roomId}`
      if (salle.connectivity !== 'ONLINE' && avant.connectivity === 'ONLINE') {
        avis.push({
          title: `${salle.name} ne répond plus`,
          body: 'Plus de nouvelles de la machine de salle.',
          tag,
          vue: 'exploitation',
        })
      } else if (salle.connectivity === 'ONLINE' && avant.connectivity !== 'ONLINE') {
        avis.push({
          title: `${salle.name} est revenue`,
          body: 'La machine de salle répond de nouveau.',
          tag,
          vue: 'exploitation',
        })
      } else if (salle.conference === 'depassement' && avant.conference !== 'depassement') {
        // Le seul état qui demande un arbitrage : c'est lui qui décale la journée.
        avis.push({
          title: `${salle.name} déborde`,
          body: 'Le créneau est fini, la conférence est toujours en cours.',
          tag,
          vue: 'exploitation',
        })
      } else if (salle.conference === 'retard' && avant.conference !== 'retard') {
        avis.push({
          title: `${salle.name} n'a pas démarré`,
          body: 'Le créneau a commencé, la conférence n’est pas lancée.',
          tag,
          vue: 'exploitation',
        })
      }
    }

    // Salles disparues du programme : sans quoi leur dernier état resterait en
    // mémoire et un retour serait annoncé comme un changement.
    const connues = new Set(statuts.map((salle) => salle.roomId))
    for (const roomId of [...this.vues.keys()]) {
      if (!connues.has(roomId)) this.vues.delete(roomId)
    }

    const codes = attente.map((demande) => demande.clientId).sort()
    if (this.appairages != null) {
      const nouvelles = codes.filter((code) => !this.appairages!.includes(code))
      if (nouvelles.length > 0) {
        avis.push({
          title:
            nouvelles.length === 1
              ? 'Une machine attend son appairage'
              : `${nouvelles.length} machines attendent leur appairage`,
          body: "Le code est affiché sur l'écran de régie.",
          tag: 'appairage',
          vue: 'appairage',
        })
      }
    }
    this.appairages = codes

    return avis
  }
}
