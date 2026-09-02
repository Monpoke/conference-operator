import type { RegieLock, RegieRoom } from '@cloudnord/contract'
import { useToast } from '@cloudnord/components'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { usePorteStore } from './porte.js'
import { useRoomStore } from './room.js'
import { sessionDeCetOnglet, useSessionStore } from './session.js'

/**
 * Qui tient la salle, et comment on la prend.
 *
 * Une seule régie mobile pilote une salle à la fois. **La régie de la salle,
 * elle, n'est jamais bridée** : l'opérateur qui est physiquement là ne doit pas
 * dépendre d'un téléphone parti dans un couloir, ni d'un verrou qu'on a oublié
 * de rendre. Le verrou n'exclut que les mobiles entre eux.
 *
 * Le battement ne vit pas ici : il voyage dans le sondage d'état
 * (`regie.view`), qui renouvelle la prise de son porteur. Un second minuteur
 * serait un second geste à ne pas oublier d'arrêter, et un verrou qui survit à
 * la page qui le tenait.
 */
export const useVerrouStore = defineStore('verrou', () => {
  const porte = usePorteStore()
  const room = useRoomStore()
  const session = useSessionStore()
  const toast = useToast()

  /** Les salles et leur verrou, pour l'écran de choix. */
  const salles = ref<RegieRoom[]>([])
  const chargement = ref(false)

  /**
   * Le verrou de la salle ouverte, tel que le dernier sondage l'a vu.
   *
   * Lu sur la vue plutôt que gardé ici : une seule source, et elle est déjà
   * rafraîchie chaque seconde. Un second exemplaire finirait par dire autre
   * chose que celui qu'on affiche à côté.
   */
  const verrou = computed<RegieLock | null>(() => vueDuVerrou())

  const porteur = computed(() => verrou.value?.holder ?? null)

  /**
   * Cet onglet-ci tient-il la salle ?
   *
   * Sur la **session**, pas sur l'adresse. Une même personne ouvre la régie sur
   * son téléphone puis sur une tablette : comparer les comptes ferait croire aux
   * deux qu'ils pilotent, et deux bascules de scène contradictoires partiraient
   * sans qu'aucun écran ne le dise.
   */
  const jeTiens = computed(() => verrou.value?.holderId === sessionDeCetOnglet())

  /**
   * La salle est tenue, mais pas ici. C'est ce qui lève le voile.
   *
   * Distinct de « personne ne la tient » : celle-là se prend d'un geste, celle-ci
   * demande de déposséder quelqu'un — fût-ce soi-même, sur un autre appareil.
   */
  const tenueAilleurs = computed(() => verrou.value != null && !jeTiens.value)

  /**
   * Une salle ouverte que cet onglet ne tient pas. C'est ce qui lève le voile.
   *
   * Trois situations derrière, et le voile les nomme séparément : personne ne
   * la tient — le cas d'un verrou expiré pendant que le téléphone dormait —,
   * un autre de vos onglets, ou quelqu'un d'autre. Les trois appellent le même
   * geste, mais pas la même phrase.
   */
  const bloque = computed(() => porte.roomId != null && !jeTiens.value)

  /** Personne ne la tient : elle se prend sans déposséder qui que ce soit. */
  const pasPrise = computed(() => bloque.value && verrou.value == null)

  /**
   * Le porteur, c'est moi — ailleurs.
   *
   * Le cas se produit plus souvent qu'on ne croit : on ouvre la régie sur le
   * téléphone, puis sur la tablette de la table de régie. Le dire change la
   * phrase du voile : « regie@… tient la salle » sur son propre compte se lit
   * comme une panne, alors que la réponse est « c'est vous, dans un autre
   * onglet ».
   */
  const monAutreSession = computed(
    () => tenueAilleurs.value && porteur.value === session.identity,
  )

  /**
   * Le verrou, pris là où il est le plus frais.
   *
   * **Sur le sondage** quand une salle est ouverte : il arrive chaque seconde,
   * et c'est ce qu'il faut — une salle reprise pendant qu'on la pilote doit se
   * voir tout de suite, pas au tour de liste suivant. Sur la liste sinon, qui
   * est la seule source de l'écran de choix.
   */
  function vueDuVerrou(): RegieLock | null {
    if (porte.roomId != null) return porte.verrouCourant
    const salle = salles.value.find((ligne) => ligne.roomId === porte.roomId)
    return salle?.lock ?? null
  }

  async function charger(): Promise<void> {
    if (!porte.distante) return
    chargement.value = true
    try {
      salles.value = await session.client.rpc.regie.locks()
    } catch {
      /*
       * Silencieux : la liste se recharge au tour suivant.
       *
       * L'écran de choix garde ce qu'il montrait — des noms de salles, qui ne
       * bougent pas de la journée. Une liste vidée à chaque hoquet de réseau
       * ferait croire à un hub sans programme.
       */
    } finally {
      chargement.value = false
    }
  }

  /**
   * Prend la salle. `force` dépossède le porteur actuel.
   *
   * Sans `force`, un refus nomme qui tient la salle : « refusé » sans dire par
   * qui envoie chercher un défaut là où il n'y a qu'un collègue à l'autre bout
   * du bâtiment.
   */
  async function prendre(roomId: string, force = false): Promise<boolean> {
    try {
      /*
       * La réponse **est** le verrou : on la pose sans attendre le sondage.
       *
       * Sans cela, la seconde qui suit une prise se passe sans verrou connu, et
       * le voile clignote sur la salle qu'on vient justement d'obtenir.
       */
      porte.verrouCourant = await session.client.rpc.regie.hold({ roomId, force })
      await charger()
      return true
    } catch (cause) {
      toast.fail((cause as Error).message || 'Salle déjà tenue')
      return false
    }
  }

  /** Rend la salle. Sans effet si on ne la tenait pas — le hub le vérifie. */
  async function rendre(roomId: string): Promise<void> {
    try {
      await session.client.rpc.regie.release({ roomId })
      await charger()
    } catch {
      // La rendre est un geste qu'on ne réessaie pas : l'expiration s'en
      // chargera de toute façon dans les trente secondes.
    }
  }

  /**
   * Ouvre une salle : prend le verrou, puis bascule l'écran.
   *
   * La prise **avant** l'ouverture, et pas l'inverse : ouvrir d'abord
   * montrerait une seconde des boutons qu'on n'a pas le droit d'utiliser, et
   * c'est la seconde où l'on appuie.
   */
  async function ouvrir(roomId: string, force = false): Promise<void> {
    if (!(await prendre(roomId, force))) return
    room.oublier()
    porte.choisir(roomId)
  }

  /**
   * Ouvre une salle **sans la prendre**.
   *
   * Le chemin normal depuis l'écran de choix : on entre, on regarde, et c'est
   * le voile qui porte la décision de prendre — une seule fois, au même endroit,
   * qu'on arrive sur une salle libre, tenue par un collègue ou tenue par son
   * propre téléphone. Demander avant d'entrer obligeait à trancher sur la foi
   * d'une ligne de liste, sans voir ce qui se joue dans la salle.
   */
  function regarder(roomId: string): void {
    room.oublier()
    porte.choisir(roomId)
  }

  /** Revient à l'écran de choix, en rendant la salle. */
  async function quitter(): Promise<void> {
    const salle = porte.roomId
    if (salle != null && jeTiens.value) await rendre(salle)
    room.oublier()
    porte.choisir(null)
    await charger()
  }

  /**
   * Rend la salle quand la page s'en va.
   *
   * `pagehide` plutôt que `beforeunload` : c'est le seul événement que les
   * navigateurs mobiles émettent de façon fiable quand on ferme un onglet ou
   * qu'on bascule d'application. `keepalive` fait partir la requête même
   * pendant le démontage.
   *
   * Ce n'est qu'un raccourci de politesse : l'expiration couvre tous les cas où
   * il ne part pas — batterie vide, tunnel, application tuée.
   */
  function libererAuDepart(): () => void {
    const surDepart = (): void => {
      const salle = porte.roomId
      if (salle == null || !jeTiens.value) return
      void session.client.rpc.regie.release({ roomId: salle }).catch(() => {})
    }
    globalThis.addEventListener('pagehide', surDepart)
    return () => globalThis.removeEventListener('pagehide', surDepart)
  }

  return {
    salles,
    chargement,
    verrou,
    porteur,
    jeTiens,
    tenueAilleurs,
    monAutreSession,
    bloque,
    pasPrise,
    charger,
    prendre,
    rendre,
    ouvrir,
    regarder,
    quitter,
    libererAuDepart,
  }
})
