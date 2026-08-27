import { useToast } from '@cloudnord/components'
import { defineStore } from 'pinia'
import { ref } from 'vue'

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

  async function act(payload: Record<string, unknown>): Promise<ActionResult> {
    pending.value += 1
    try {
      const response = await fetch('/control/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = (await response.json()) as ActionResult
      const message = result.message ?? (result.ok ? 'Fait' : 'Échec')
      if (result.ok) toast.say(message)
      else toast.fail(message)
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
