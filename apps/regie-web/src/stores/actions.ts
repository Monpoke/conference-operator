import { useToast } from '@cloudnord/components'
import { defineStore } from 'pinia'
import { ref } from 'vue'

/** Ce qu'on peut demander d'une action, en plus de la poster. */
export interface ActOptions {
  /**
   * Ne pas annoncer la réussite.
   *
   * Pour les gestes dont l'effet **est** la réponse : écarter un signalement le
   * fait disparaître, et un « Fait » qui reparaît à la seconde suivante — au
   * même endroit de l'écran, la pile et les avis partagent le bas — se lit
   * comme un nouveau signalement. On aurait fermé quelque chose pour en ouvrir
   * un autre.
   *
   * L'échec, lui, parle toujours : il n'a pas d'effet visible pour le dire à sa
   * place.
   */
  silent?: boolean
}

/** Ce que le poste répond à une action. Le message est écrit pour l'opérateur. */
export interface ActionResult {
  ok: boolean
  message?: string
}

/**
 * Les commandes de régie, et la règle qui les gouverne toutes.
 *
 * **Aucune action n'écrit dans l'état de la salle.** Appuyer sur « LIVE » poste
 * la commande et s'arrête là : c'est le delta du flux qui repeindra le bouton,
 * une fois qu'OBS aura vraiment basculé. Peindre d'avance donnerait un bouton
 * actif décrivant ce qu'on a demandé et non ce qui est — la différence est
 * invisible tant que tout marche, et c'est exactement le jour où la bascule
 * échoue qu'elle compte.
 *
 * Le prix est un aller-retour de latence sur chaque geste. En salle, il se
 * mesure en millisecondes : le poste sert la page et pilote OBS depuis la même
 * machine.
 */
export const useActionsStore = defineStore('actions', () => {
  const toast = useToast()

  /** Commandes en vol, par action. Sert à désarmer un bouton le temps du geste. */
  const pending = ref(0)

  async function act(
    payload: Record<string, unknown>,
    options: ActOptions = {},
  ): Promise<ActionResult> {
    pending.value += 1
    try {
      const response = await fetch('/control/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = (await response.json()) as ActionResult
      const message = result.message ?? (result.ok ? 'Fait' : 'Échec')
      if (!result.ok) toast.fail(message)
      else if (options.silent !== true) toast.say(message)
      return result
    } catch {
      /*
       * La régie tourne en local : un échec ici ne veut pas dire « le hub est
       * loin », il veut dire que le cœur applicatif de la salle ne répond plus.
       * C'est la panne qui arrête tout, et elle doit se lire immédiatement.
       */
      const message = 'Le service local ne répond pas'
      toast.fail(message)
      return { ok: false, message }
    } finally {
      pending.value -= 1
    }
  }

  return { pending, act }
})
