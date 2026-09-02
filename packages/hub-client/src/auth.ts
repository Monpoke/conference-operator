import type { TokenStore } from './token.js'

/**
 * Better Auth, vu du navigateur.
 *
 * Ces appels ne passent pas par oRPC : le hub monte Better Auth sous
 * `/api/auth`, hors du contrat. Ils vivent ici et non dans une application
 * parce qu'ils ont désormais deux appelants — la console et la régie mobile —
 * et que ce sont exactement les chemins où une divergence coûte cher : un
 * `signOut` qui oublie de prévenir le hub laisse une session Google qui se
 * rouvre au rechargement suivant, et le bouton paraît ne rien faire.
 *
 * Sans framework, et sans état : chaque application garde son propre store et
 * son propre écran. C'est la disposition qui les sépare — un formulaire de
 * poste et un formulaire de téléphone n'ont pas la même forme — pas ce qu'ils
 * demandent au hub.
 */

/** Ce qu'un essai de connexion rend : rien, ou une raison affichable. */
export type ResultatConnexion = { ok: true } | { ok: false; message: string }

export interface HubAuthOptions {
  /** Où écrire le jeton porteur d'une connexion par mot de passe. */
  token: TokenStore
  /** Injectable pour les tests : aucun réseau, aucune horloge. */
  fetch?: typeof globalThis.fetch
}

export interface HubAuth {
  /** Session par cookie déjà ouverte ? Rend l'adresse connue, ou `null`. */
  resume(): Promise<string | null>
  signIn(email: string, password: string): Promise<ResultatConnexion>
  /** Rend l'adresse vers laquelle naviguer, ou une raison. */
  googleUrl(callbackURL: string): Promise<{ ok: true; url: string } | { ok: false; message: string }>
  signOut(): Promise<void>
}

export function createHubAuth(options: HubAuthOptions): HubAuth {
  const send = options.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args))

  async function corps<T>(response: Response): Promise<T | null> {
    return (await response.json().catch(() => null)) as T | null
  }

  return {
    /**
     * Y a-t-il une session par cookie derrière nous ?
     *
     * Demandé seulement faute de jeton, et jamais bloquant : l'écran de
     * connexion est la bonne chose à montrer en attendant. Un retour de Google
     * ne laisse **aucun** jeton, seulement un cookie — sans cette question, une
     * connexion Google réussie retombait sur l'écran de connexion.
     */
    async resume() {
      try {
        const response = await send('/api/auth/get-session')
        if (!response.ok) return null
        const body = await corps<{ user?: { email?: string } }>(response)
        return body?.user == null ? null : (body.user.email ?? null)
      } catch {
        // Hub injoignable au chargement : l'écran de connexion redira ce qu'il
        // faut au premier essai.
        return null
      }
    },

    /**
     * Connexion par mot de passe.
     *
     * L'endpoint de Better Auth plutôt qu'une procédure du contrat : c'est le
     * chemin qui doit continuer de marcher quand Google est injoignable, ce qui
     * est toute la raison d'être du compte à mot de passe.
     */
    async signIn(email, password) {
      try {
        const response = await send('/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }),
        })
        const body = await corps<{ token?: string }>(response)
        if (!response.ok || body?.token == null) return { ok: false, message: 'Identifiants refusés.' }
        options.token.write(body.token)
        return { ok: true }
      } catch {
        return { ok: false, message: 'Le hub est injoignable.' }
      }
    },

    /**
     * Un **POST**, puis une navigation vers l'adresse rendue.
     *
     * Better Auth ne redirige pas depuis un GET sur ce chemin — il répond
     * `null`, ce qui est exactement ce que produit un `location.assign` naïf :
     * une page blanche, et rien qui dise ce qui a manqué.
     */
    async googleUrl(callbackURL) {
      try {
        const response = await send('/api/auth/sign-in/social', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'google', callbackURL }),
        })
        const body = await corps<{ url?: string; message?: string }>(response)
        if (!response.ok || body?.url == null) {
          return { ok: false, message: body?.message ?? 'Google indisponible.' }
        }
        return { ok: true, url: body.url }
      } catch {
        return { ok: false, message: 'Le hub est injoignable.' }
      }
    },

    /**
     * Déconnexion, en prévenant le hub d'abord.
     *
     * Une session Google vit dans un **cookie** : seul le serveur peut la
     * fermer. Effacer l'état local seul remettrait l'écran de connexion, et
     * `get-session` reconnecterait au rechargement suivant.
     *
     * Le jeton est effacé quoi qu'il arrive : rester connecté parce que le hub
     * n'a pas répondu est le contraire de ce qu'on demande en cliquant.
     */
    async signOut() {
      const bearer = options.token.read()
      try {
        await send('/api/auth/sign-out', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(bearer == null ? {} : { authorization: `Bearer ${bearer}` }),
          },
          body: '{}',
        })
      } catch {
        // Voir ci-dessus.
      }
      options.token.clear()
    },
  }
}
