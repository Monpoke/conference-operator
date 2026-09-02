import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { REGIE_LOCK_TTL_MS, TTL_COMMANDE_REGIE } from '@cloudnord/contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'
import { commandeDeRegie, vueDeRegie } from '../src/services/regie.js'

/**
 * La régie mobile, vue du hub.
 *
 * Ce qui se vérifie ici n'est pas « le verrou existe » mais les quatre
 * propriétés dont dépend son usage un jour d'événement : il expire seul, il se
 * reprend, il ne bavarde pas, et un geste part avec la durée de validité qui
 * lui convient. Les droits eux-mêmes vivent dans `droits.test.ts`.
 */

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'motdepasse-regie-2026' }
const AUTRE = { email: 'nuit@cloudnord.fr', name: 'Nuit', password: 'motdepasse-nuit-2026' }
const TRACK_1 = 'track-1-teilhard-de-chardin'

/**
 * Deux onglets, et c'est la distinction qui compte.
 *
 * Le verrou porte une session, pas un compte : le téléphone dans la poche et la
 * tablette posée sur la table appartiennent à la même personne et ne doivent
 * pas piloter la même salle en se croyant seuls.
 */
const TEL = 'session-telephone'
const TABLETTE = 'session-tablette'

let hub: Hub

/** Ce que la salle a reçu depuis le début, dans l'ordre. */
function commandes(roomId = TRACK_1) {
  return hub.services.commands.backlog(roomId, 0)
}

/**
 * Pousse l'horloge du hub, comme le fait l'onglet Développement.
 *
 * C'est la seule façon honnête de vieillir un verrou : il n'a pas de colonne
 * d'échéance, son expiration se calcule à la lecture sur l'horloge du hub.
 * Réécrire la ligne en base testerait une mécanique qui n'existe pas.
 */
function avancerDe(ms: number): void {
  hub.services.clock.setSimulated(new Date(hub.services.clock.now() + ms).toISOString())
}

beforeEach(async () => {
  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
  })
  await provisionOperator(hub.auth, OPERATOR)
  await provisionOperator(hub.auth, AUTRE)
  const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.ensureFromTracks(snapshot.program.rooms)
})

afterEach(async () => {
  await hub.close()
})

describe('le verrou', () => {
  it('se rend à qui le prend, et refuse le suivant en le nommant', () => {
    const verrou = hub.services.regie.hold(TRACK_1, OPERATOR.email, TEL, false)
    expect(verrou.holder).toBe(OPERATOR.email)

    expect(() => hub.services.regie.hold(TRACK_1, AUTRE.email, TABLETTE, false)).toThrow(OPERATOR.email)
  })

  it('conserve « depuis quand » au renouvellement, et le réinitialise à la reprise', async () => {
    /*
     * C'est ce chiffre que lit l'autre opérateur avant de décider s'il reprend.
     * Réécrit à chaque battement, il afficherait « depuis 1 seconde » toute la
     * journée — et ne répondrait plus à rien.
     */
    const premier = hub.services.regie.hold(TRACK_1, OPERATOR.email, TEL, false)
    await new Promise((r) => setTimeout(r, 5))
    const renouvele = hub.services.regie.hold(TRACK_1, OPERATOR.email, TEL, false)
    expect(renouvele.heldSince).toBe(premier.heldSince)
    expect(Date.parse(renouvele.lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(premier.lastSeenAt))

    const repris = hub.services.regie.hold(TRACK_1, AUTRE.email, TABLETTE, true)
    expect(repris.holder).toBe(AUTRE.email)
    expect(repris.heldSince).not.toBe(premier.heldSince)
  })

  it("n'est plus rendu passé son délai, avant même le balayage", async () => {
    /*
     * L'expiration se calcule à la lecture, et c'est ce qui fait autorité. Un
     * balayage qui déciderait laisserait un verrou mort opposable pendant les
     * quinze secondes qui le séparent du tour suivant.
     */
    hub.services.regie.hold(TRACK_1, OPERATOR.email, TEL, false)
    avancerDe(REGIE_LOCK_TTL_MS + 1_000)

    expect(hub.services.regie.lock(TRACK_1)).toBeNull()
    // Et la salle redevient prenable sans forcer.
    expect(hub.services.regie.hold(TRACK_1, AUTRE.email, TABLETTE, false).holder).toBe(AUTRE.email)
  })

  it("exclut un second onglet du même opérateur", () => {
    /*
     * Le cas qui a motivé la session plutôt que le compte.
     *
     * Une même personne ouvre la régie sur son téléphone puis sur une tablette.
     * Sur le compte, les deux se croyaient porteurs et pilotaient la salle en
     * s'ignorant — deux bascules de scène contradictoires, et aucun écran pour
     * le dire. Sur la session, le second est refusé comme n'importe qui.
     */
    hub.services.regie.hold(TRACK_1, OPERATOR.email, TEL, false)
    expect(() => hub.services.regie.hold(TRACK_1, OPERATOR.email, TABLETTE, false)).toThrow(
      OPERATOR.email,
    )

    // Et la reprise fonctionne entre onglets d'une même personne, comme entre
    // deux personnes : c'est le même geste, avec la même question posée.
    const repris = hub.services.regie.hold(TRACK_1, OPERATOR.email, TABLETTE, true)
    expect(repris.holderId).toBe(TABLETTE)
    expect(repris.holder).toBe(OPERATOR.email)
  })

  it("ne laisse pas un onglet rendre la salle que l'autre tient", () => {
    // Fermer le premier onglet ne doit pas déposséder le second, qui est en
    // train de piloter.
    hub.services.regie.hold(TRACK_1, OPERATOR.email, TEL, false)
    hub.services.regie.hold(TRACK_1, OPERATOR.email, TABLETTE, true)
    expect(hub.services.regie.release(TRACK_1, TEL)).toBe(false)
    expect(hub.services.regie.lock(TRACK_1)?.holderId).toBe(TABLETTE)
  })

  it('rendu par son porteur seulement', () => {
    hub.services.regie.hold(TRACK_1, OPERATOR.email, TEL, false)
    expect(hub.services.regie.release(TRACK_1, TABLETTE)).toBe(false)
    expect(hub.services.regie.lock(TRACK_1)?.holder).toBe(OPERATOR.email)
    expect(hub.services.regie.release(TRACK_1, TEL)).toBe(true)
    expect(hub.services.regie.lock(TRACK_1)).toBeNull()
  })

  it('balaie ce qui est périmé, et nomme les salles rendues', () => {
    hub.services.regie.hold(TRACK_1, OPERATOR.email, TEL, false)
    expect(hub.services.regie.sweep()).toEqual([])

    avancerDe(REGIE_LOCK_TTL_MS + 1_000)
    // La liste rendue est ce qui décide quelles salles voient leur badge
    // s'éteindre : sans elle, l'écran de régie garderait un porteur parti.
    expect(hub.services.regie.sweep()).toEqual([TRACK_1])
  })
})

describe('ce que la salle reçoit', () => {
  it('un changement de porteur, jamais un battement', () => {
    hub.services.regie.hold(TRACK_1, OPERATOR.email, TEL, false)
    hub.services.commands.publish(TRACK_1, { type: 'regie.hold', holder: OPERATOR.email }, null)

    // Cent battements : le routeur ne publie que sur changement, et c'est ce
    // qui empêche la table des commandes de prendre une ligne par seconde et
    // par salle tenue.
    for (let index = 0; index < 100; index += 1) {
      hub.services.regie.hold(TRACK_1, OPERATOR.email, TEL, false)
    }

    expect(commandes().filter((c) => c.payload.type === 'regie.hold')).toHaveLength(1)
  })

  it('une bascule de scène qui périme plus vite qu\'un enregistrement', () => {
    hub.services.regie.hold(TRACK_1, OPERATOR.email, TEL, false)
    hub.services.commands.publish(
      TRACK_1,
      { type: 'scene.force', role: 'LIVE', requestedBy: OPERATOR.email },
      TTL_COMMANDE_REGIE['scene.force'],
    )
    hub.services.commands.publish(
      TRACK_1,
      { type: 'recording.set', on: true, requestedBy: OPERATOR.email },
      TTL_COMMANDE_REGIE['recording.set'],
    )

    const scene = commandes().find((c) => c.payload.type === 'scene.force')
    const capture = commandes().find((c) => c.payload.type === 'recording.set')

    /*
     * Les deux durées ne sont pas égales, et l'écart est la règle : une bascule
     * rattrapée dix minutes plus tard met la salle à l'antenne sur rien, là où
     * une captation peut encore rattraper une coupure d'une minute.
     */
    expect(scene?.ttlSeconds).toBe(30)
    expect(capture?.ttlSeconds).toBe(90)
    expect(scene!.ttlSeconds!).toBeLessThan(capture!.ttlSeconds!)
  })

  it("un écran de salle, qui périme comme une bascule de scène", () => {
    hub.services.regie.hold(TRACK_1, OPERATOR.email, TEL, false)
    const issue = commandeDeRegie(
      hub.services,
      TRACK_1,
      { type: 'display.set', mode: 'sponsors' },
      OPERATOR.email,
    )

    /*
     * `queued`, et pas `now` : le hub a mis la commande en file, rien de plus.
     * Que l'écran ait basculé se lit sur la vue suivante — c'est la même
     * distinction que pour la captation, et c'est elle qui empêche un téléphone
     * de croire un geste abouti parce qu'un appel a répondu 200.
     */
    expect(issue.applied).toBe('queued')

    const ecran = commandes().find((c) => c.payload.type === 'display.set')
    expect(ecran?.payload).toMatchObject({ mode: 'sponsors', sessionId: null })
    /*
     * La même durée qu'une scène : c'est aussi ce que le public voit. Un
     * « notez le talk » rattrapé au milieu du suivant est le mauvais écran
     * devant les mauvaises personnes.
     */
    expect(ecran?.ttlSeconds).toBe(TTL_COMMANDE_REGIE['display.set'])
    expect(ecran?.ttlSeconds).toBe(TTL_COMMANDE_REGIE['scene.force'])
  })

  it("qui a demandé le geste, pour que la régie de la salle puisse le dire", () => {
    hub.services.commands.publish(
      TRACK_1,
      { type: 'recording.set', on: true, requestedBy: OPERATOR.email },
      TTL_COMMANDE_REGIE['recording.set'],
    )
    const commande = commandes().find((c) => c.payload.type === 'recording.set')
    // Sans ce nom, un enregistrement qui démarre tout seul se lit comme une
    // panne d'OBS — et on va la chercher là où elle n'est pas.
    expect(commande?.payload).toMatchObject({ requestedBy: OPERATOR.email })
  })
})

describe('la vue', () => {
  it('vise la conférence à piloter, pas le créneau courant', () => {
    const at = Date.parse('2026-10-30T10:20:00.000Z')
    const rendue = vueDeRegie(hub.services, TRACK_1, at)

    // La même règle que déroule la régie de la salle : `conferenceAPiloter`.
    expect(rendue.targetSession?.kind).toBe('talk')
    expect(rendue.roomId).toBe(TRACK_1)
    // L'heure du hub voyage avec la vue : le navigateur n'a que la sienne, et
    // celle du hub peut être simulée.
    expect(Date.parse(rendue.serverTime)).toBe(at)
  })

  it("n'offre que les rôles de scène que la salle a réellement mappés", () => {
    const vue = vueDeRegie(hub.services, TRACK_1, Date.now())
    // Les défauts d'une salle auto-provisionnée : LIVE et HOLD, pas RELAY.
    expect(vue.sceneRoles).toContain('LIVE')
    expect(vue.sceneRoles).toContain('HOLD')
    expect(vue.sceneRoles).not.toContain('RELAY')
  })

  it("rend l'écran que la salle a remonté, et rien tant qu'elle se tait", () => {
    // Aucune salle n'a battu : le hub ne sait pas ce qui est affiché, et le
    // dire est plus juste que d'allumer « Boucle » sur une supposition.
    expect(vueDeRegie(hub.services, TRACK_1, Date.now()).displayMode).toBeNull()

    hub.services.ingest.push(TRACK_1, [
      {
        id: '01FFFFFFFFFFFFFFFFFFFFFFFF',
        roomId: TRACK_1,
        seq: 1,
        occurredAt: '2026-10-30T09:00:00.000+00:00',
        monotonicMs: 1000,
        delivery: 'best-effort',
        payload: {
          type: 'room.heartbeat',
          connectivity: 'ONLINE',
          sceneRole: 'HOLD',
          recording: true,
          streaming: false,
          outboxDepth: 0,
          programContentHash: null,
          displayMode: 'feedback',
        },
      },
    ])

    const vue = vueDeRegie(hub.services, TRACK_1, Date.now())
    expect(vue.displayMode).toBe('feedback')
    /*
     * La captation avec, et c'est le fond de l'affaire : elle ne remonte que
     * par le battement quand elle est lancée depuis OBS, et le battement la
     * lisait sur la mauvaise instance. Un témoin éteint sur une salle en pleine
     * captation est le pire des deux mensonges possibles.
     */
    expect(vue.recording).toBe(true)
  })

  it('refuse une salle inconnue plutôt que de rendre une vue vide', () => {
    // Une adresse `/regie/<id>` se met en favori et se partage : un identifiant
    // qui ne désigne plus rien doit le dire, pas se lire comme une salle
    // éteinte.
    expect(() => vueDeRegie(hub.services, 'salle-fantome', Date.now())).toThrow('Salle inconnue')
  })
})
