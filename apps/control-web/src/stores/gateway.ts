import { controlPath, controlRoomIdFromPath, type ControlLock } from '@cloudnord/contract'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { BootScope } from '../boot.js'
import {
  remoteGateway,
  localGateway,
  type ActionResult,
  type StateSink,
  type ControlGateway,
} from '../lib/gateway.js'
import { useSessionStore } from './session.js'

/**
 * Le transport, et lui seul.
 *
 * Ce store possède la porte : il sait d'où vient l'état et où partent les
 * gestes. `room` et `actions` passent par lui sans jamais savoir laquelle des
 * deux portes est ouverte, ce qui est toute la raison pour laquelle les
 * panneaux se réutilisent tels quels.
 *
 * Il n'importe ni `room` ni `actions` — la dépendance ne va que dans un sens,
 * et c'est ce qui évite le cycle qu'un store « qui pousse dans un autre » aurait
 * créé.
 */
export const useGatewayStore = defineStore('porte', () => {
  const amorce = ref<BootScope>({
    portee: 'locale',
    roomId: null,
    salles: [],
    google: null,
  })

  /**
   * La salle pilotée. Vient de l'amorce, puis de l'adresse.
   *
   * `shallowRef` pour la porte, comme pour le client : elle porte un minuteur et
   * un flux, pas des données.
   */
  const roomId = ref<string | null>(null)
  const porte = shallowRef<ControlGateway | null>(null)

  /**
   * Le verrou de la salle ouverte, rafraîchi à chaque sondage.
   *
   * Pris sur la vue et non sur la liste des salles : celle-ci ne se recharge
   * que sur l'écran de choix, si bien qu'une salle reprise pendant qu'on la
   * pilote ne se serait vue nulle part. C'est le champ qui doit réagir à la
   * seconde — c'est lui qui lève le voile.
   */
  const currentLock = shallowRef<ControlLock | null>(null)
  let flux: StateSink | null = null
  /** Les substitutions de la dernière ouverture, rejouées à chaque changement de salle. */
  let ouverture: Ouverture = {}

  const distante = computed(() => amorce.value.portee === 'distante')
  /** Écran de choix : à distance, tant qu'aucune salle n'est désignée. */
  const roomChoice = computed(() => distante.value && roomId.value == null)

  function start(valeur: BootScope): void {
    amorce.value = valeur
    roomId.value = valeur.roomId
    if (valeur.portee === 'distante') useSessionStore().start(valeur)
  }

/**
   * Ce qu'on peut substituer à la porte, et pourquoi.
   *
   * `ouvrirFlux` pour la porte locale : happy-dom fournit un `EventSource`, mais
   * un vrai flux ne s'interrompt pas sur demande — et le seul comportement qui
   * compte est justement ce qui se passe quand il s'interrompt.
   *
   * `maintenant` et `attendre` pour la porte distante : la confirmation par
   * observation est bornée par un délai de garde, et l'exercer en temps réel
   * ferait dormir la suite de tests cinq secondes pour vérifier une règle qui
   * tient en trois lignes.
   */
  interface Ouverture {
    ouvrirFlux?: Parameters<typeof localGateway>[0]
    maintenant?: () => number
    attendre?: (ms: number) => Promise<void>
  }

  /** Fabrique la porte de la portée courante, sans l'ouvrir. */
  function fabriquer(options: Ouverture): ControlGateway | null {
    if (!distante.value) return localGateway(options.ouvrirFlux)
    const salle = roomId.value
    // Rien à piloter sans salle : l'écran de choix ne commande personne.
    if (salle == null) return null
    return remoteGateway({
      client: useSessionStore().client,
      roomId: salle,
      onVue: (vue) => {
        currentLock.value = vue.lock
      },
      maintenant: options.maintenant,
      attendre: options.attendre,
    })
  }

  /**
   * Retient comment fabriquer la porte, sans l'ouvrir.
   *
   * Séparé de `ouvrir` parce que les gestes n'attendent pas le flux : une porte
   * se fabrique aussi au premier bouton pressé, et elle doit alors employer les
   * mêmes substitutions. Sans cette séparation, un geste posé avant l'ouverture
   * repartait sur les valeurs par défaut.
   */
  function configurer(options: Ouverture): void {
    ouverture = options
  }

  /** Ouvre le transport et le garde ouvert. */
  function ouvrir(abonnement: StateSink, options: Ouverture = ouverture): void {
    flux = abonnement
    ouverture = options
    if (porte.value != null) return

    porte.value = fabriquer(options)
    porte.value?.demarrer(abonnement)
  }

  function fermer(): void {
    porte.value?.arreter()
    porte.value = null
  }

  /**
   * Change de salle sans recharger la page.
   *
   * L'adresse suit, parce que **chaque écran est une adresse** : la page
   * rafraîchie rouvre la salle qu'on pilotait, le lien se met en favori, et le
   * bouton Retour ramène au choix plutôt que de quitter. Deux états ne
   * justifient pas un routeur — `pushState` et `popstate` suffisent, et
   * `vue-router` n'entre pas dans un bundle qu'une machine de salle sert aussi.
   */
  function choisir(salle: string | null, pousser = true): void {
    if (salle === roomId.value) return
    fermer()
    // Le verrou de la salle qu'on quitte n'a rien à dire de celle qu'on ouvre :
    // le garder ferait clignoter un voile le temps du premier sondage.
    currentLock.value = null
    roomId.value = salle
    if (pousser) globalThis.history.pushState({}, '', controlPath(salle))
    if (flux != null) ouvrir(flux, ouverture)
  }

  /** Suit le bouton Retour du navigateur. Rendue pour être retirée au démontage. */
  function suivreHistorique(): () => void {
    const surRetour = (): void => choisir(controlRoomIdFromPath(globalThis.location.pathname), false)
    globalThis.addEventListener('popstate', surRetour)
    return () => globalThis.removeEventListener('popstate', surRetour)
  }

  async function act(geste: Record<string, unknown>): Promise<ActionResult> {
    /*
     * La porte s'ouvre au premier geste si le flux ne l'a pas déjà ouverte.
     *
     * Un geste posé avant que le flux ne soit branché doit partir quand même :
     * le lier à l'ouverture du flux ferait dépendre les commandes d'un
     * `EventSource`, qui n'a rien à voir avec elles. À distance, `fabriquer`
     * rend `null` tant qu'aucune salle n'est ouverte, et le refus ci-dessous le
     * dit.
     */
    if (porte.value == null) porte.value = fabriquer(ouverture)

    const active = porte.value
    if (active == null) {
      /*
       * À distance, aucune salle ouverte : dit plutôt que tenté.
       *
       * Le cas de l'écran de choix, où rien n'est piloté. Un geste qui partirait
       * vers `/control/action` depuis un téléphone récolterait un 404 du hub, et
       * personne ne saurait dire pourquoi.
       */
      return { ok: false, message: "Aucune salle n'est ouverte" }
    }
    return active.act(geste)
  }

  return {
    amorce,
    roomId,
    currentLock,
    distante,
    roomChoice,
    start,
    configurer,
    ouvrir,
    fermer,
    choisir,
    suivreHistorique,
    act,
  }
})
