import { CONTROL_SESSION_HEADER } from '@cloudnord/contract'
import { useToast } from '@cloudnord/components'
import { createHubAuth, createHubClient, type HubClient } from '@cloudnord/hub-client'
import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import type { AmorcePortee } from '../boot.js'

/**
 * La clé du jeton, **partagée avec la console**.
 *
 * Même origine, donc même stockage : un opérateur connecté à `/admin` sur son
 * téléphone ouvre `/regie` déjà connecté. Se reconnecter deux fois sur le même
 * appareil au milieu d'un événement est précisément la friction qu'on retire —
 * et une seconde clé l'aurait réintroduite pour rien.
 */
export const TOKEN_KEY = 'hub-admin'

/**
 * L'identité de **cet onglet-ci**, et de lui seul.
 *
 * `sessionStorage`, et le choix est le fond du sujet : il survit à un F5 — un
 * rechargement en plein talk ne doit pas faire perdre la salle — et meurt avec
 * l'onglet. `localStorage` serait partagé entre les onglets, ce qui est
 * exactement ce qu'on cherche à distinguer ; une variable de module ne
 * survivrait pas au rechargement.
 *
 * Le repli en mémoire couvre les navigateurs qui refusent le stockage : deux
 * onglets s'y confondraient au rechargement, et c'est un défaut acceptable
 * comparé à une page qui ne s'ouvre pas.
 */
const CLE_SESSION = 'regie-session'
let secours: string | null = null

export function sessionDeCetOnglet(): string {
  try {
    const connue = globalThis.sessionStorage?.getItem(CLE_SESSION)
    if (connue != null && connue !== '') return connue
    const neuve = identifiant()
    globalThis.sessionStorage?.setItem(CLE_SESSION, neuve)
    return neuve
  } catch {
    secours ??= identifiant()
    return secours
  }
}

function identifiant(): string {
  return globalThis.crypto?.randomUUID?.() ?? `regie-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Qui est connecté, et le client par lequel tout passe.
 *
 * N'existe que pour la portée distante : servie par un poste de salle, la régie
 * ne parle qu'à sa propre boucle locale et n'a personne à authentifier. Le store
 * est monté quand même — il ne fait rien tant que rien ne l'appelle — plutôt que
 * conditionné, parce qu'un store qui existe parfois se lit deux fois moins bien
 * qu'un store qui ne sert parfois à rien.
 */
export const useSessionStore = defineStore('session', () => {
  const signedIn = ref(false)
  const identity = ref<string | null>(null)
  const signingIn = ref(false)
  const error = ref<string | null>(null)
  const google = ref<{ domain: string } | null>(null)

  const toast = useToast()

  /**
   * `shallowRef` : le client porte un lien, pas des données.
   *
   * Le rendre profondément réactif ferait parcourir un proxy oRPC à chaque
   * accès — et ce proxy répond à *n'importe quel* nom de propriété, si bien que
   * le parcours ne s'arrête sur rien d'utile.
   */
  const client = shallowRef<HubClient>(
    createHubClient({
      tokenKey: TOKEN_KEY,
      /*
       * L'onglet s'annonce à chaque appel.
       *
       * C'est lui que le verrou retient, et non le compte : sans cet en-tête, le
       * hub refuse de prendre ou de piloter une salle plutôt que de retomber sur
       * l'adresse — un repli silencieux qui ne se découvrirait que le jour où
       * deux onglets pilotent la même salle.
       */
      headers: () => ({ [CONTROL_SESSION_HEADER]: sessionDeCetOnglet() }),
      onExpired: () => forget(),
      onError: (cause) => {
        toast.fail(cause instanceof Error ? cause.message : 'Échec de la requête')
      },
    }),
  )

  const auth = createHubAuth({ token: client.value.token })

  /**
   * Deux façons d'arriver connecté, et une seule laisse un jeton.
   *
   * Un jeton en stockage est une prétention, pas une session : c'est le premier
   * appel protégé qui tranche. Un retour de Google, lui, ne laisse aucun jeton —
   * seulement un cookie — et il faut donc demander avant de conclure que
   * personne n'est connecté.
   */
  function start(amorce: AmorcePortee): void {
    google.value = amorce.google
    if (client.value.token.read() != null) {
      signedIn.value = true
      return
    }
    void resume()
  }

  async function resume(): Promise<void> {
    const email = await auth.resume()
    if (email == null) return
    identity.value = email
    signedIn.value = true
  }

  async function signIn(email: string, password: string): Promise<void> {
    signingIn.value = true
    error.value = null
    try {
      const resultat = await auth.signIn(email, password)
      if (!resultat.ok) {
        error.value = resultat.message
        return
      }
      identity.value = email
      signedIn.value = true
    } finally {
      signingIn.value = false
    }
  }

  /**
   * `callbackURL` ramène **sur cette page-ci**.
   *
   * L'aller-retour Google perd la chaîne de requête mais garde le chemin : un
   * opérateur qui se connecte depuis `/regie/track-1` doit retrouver sa salle,
   * pas l'écran de choix. C'est là que la différence avec la console compte —
   * la console n'a qu'une adresse à laquelle revenir, la régie en a une par
   * salle.
   */
  async function signInWithGoogle(): Promise<void> {
    error.value = null
    const resultat = await auth.googleUrl(globalThis.location.pathname)
    if (!resultat.ok) {
      error.value = resultat.message
      return
    }
    globalThis.location.assign(resultat.url)
  }

  /** Oublie la session ici, sans rien dire au hub : c'est aussi le chemin d'un 401. */
  function forget(): void {
    client.value.token.clear()
    identity.value = null
    signedIn.value = false
  }

  async function signOut(): Promise<void> {
    await auth.signOut()
    forget()
  }

  return {
    signedIn,
    signingIn,
    error,
    identity,
    google,
    client,
    start,
    resume,
    signIn,
    signInWithGoogle,
    signOut,
  }
})
