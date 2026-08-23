import type { Program, Session } from './model.js'
import { effectiveEndMs, sessionsForRoom } from './selectors.js'

/**
 * Les pauses d'une salle valent pour celles qui n'ont rien de prévu.
 *
 * L'export amont ne rattache un créneau qu'à **un** track : le déjeuner, le
 * petit déjeuner d'accueil, la pause café figurent sur la salle principale et
 * nulle part ailleurs. Les autres salles affichaient donc un trou pendant que
 * l'événement entier déjeunait — « hors créneau » sur la pastille, habillage
 * neutre à l'écran, et rien à dire au public entré par la mauvaise porte.
 *
 * La règle comble ce trou sans rien inventer : une salle **libre pendant toute
 * la durée** d'une pause tenue ailleurs hérite de cette pause. Libre pendant
 * *toute* la durée, et pas seulement au début : un chevauchement, même partiel,
 * veut dire que la salle a son propre programme à ce moment-là, et rogner une
 * pause pour la faire entrer dans l'intervalle restant fabriquerait un créneau
 * que personne n'a mis au programme.
 *
 * La projection est **dérivée**, jamais stockée : elle se recalcule sur le
 * programme servi, décisions du jour comprises. Déclarer un créneau « break »
 * depuis la console le fait donc apparaître dans les autres salles libres, et le
 * rendre à « conférence » l'en retire — sans que rien d'autre n'ait à suivre.
 */
export function applySharedBreaks(program: Program): Program {
  const pauses = program.sessions.filter(
    (session) => session.kind === 'break' && session.roomId != null,
  )
  if (pauses.length === 0 || program.rooms.length < 2) return program

  const ajoutees: Session[] = []
  for (const room of program.rooms) {
    const propres = sessionsForRoom(program, room.id)
    /**
     * Une même pause peut être tenue par plusieurs salles — deux tracks qui
     * portent chacun leur « Pause café » de 15:00. La salle libre n'en hérite
     * qu'une fois : deux lignes identiques dans sa timeline se liraient comme
     * deux créneaux successifs.
     */
    const vues = new Set<string>()

    for (const pause of pauses) {
      if (pause.roomId === room.id) continue
      const fin = finDe(pause, program)
      // Une pause qu'on ne sait pas fermer ne se projette pas : elle courrait
      // jusqu'au bout de la journée dans une salle qui a peut-être un talk.
      if (fin == null) continue

      const creneau = `${pause.startsAtMs}-${fin}-${pause.title}`
      if (vues.has(creneau)) continue
      if (propres.some((session, index) => chevauche(session, indexFin(propres, index), pause.startsAtMs, fin))) {
        continue
      }

      vues.add(creneau)
      ajoutees.push({
        ...pause,
        // Identifiant dérivé : deux salles ne peuvent pas porter le même, et on
        // lit d'où vient la copie sans avoir à la comparer à quoi que ce soit.
        id: `${pause.id}@${room.id}`,
        roomId: room.id,
        sharedFrom: pause.id,
      })
    }
  }

  if (ajoutees.length === 0) return program

  return {
    ...program,
    // Retriées comme le fait le normaliseur : tout l'aval suppose une liste
    // ordonnée par heure de début, à commencer par la position dans la timeline.
    sessions: [...program.sessions, ...ajoutees].sort(
      (a, b) => a.startsAtMs - b.startsAtMs || a.id.localeCompare(b.id),
    ),
  }
}

/** Fin effective d'une pause, la session suivante de *sa* salle faisant foi. */
function finDe(pause: Session, program: Program): number | null {
  const voisines = pause.roomId == null ? [] : sessionsForRoom(program, pause.roomId)
  const index = voisines.indexOf(pause)
  return effectiveEndMs(pause, index < 0 ? undefined : voisines[index + 1])
}

function indexFin(sessions: Session[], index: number): number | null {
  return effectiveEndMs(sessions[index]!, sessions[index + 1])
}

/**
 * Deux intervalles se touchent-ils ?
 *
 * Bornes ouvertes à droite : un talk qui finit à 11:15 ne chevauche pas une
 * pause qui commence à 11:15. C'est le cas courant — les créneaux s'enchaînent
 * bord à bord —, et le traiter comme un chevauchement annulerait la règle
 * partout où elle sert.
 */
function chevauche(session: Session, fin: number | null, debut: number, finPause: number): boolean {
  // Créneau de fin inconnue : il court jusqu'à preuve du contraire, donc il
  // occupe la salle. Mieux vaut ne pas projeter que projeter par-dessus.
  if (fin == null) return session.startsAtMs < finPause
  return session.startsAtMs < finPause && fin > debut
}
