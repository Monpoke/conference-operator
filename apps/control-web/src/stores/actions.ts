import { useToast } from '@cloudnord/components'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ActionResult } from '../lib/gateway.js'
import { useGatewayStore } from './gateway.js'

export type { ActionResult }

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
 * machine. Depuis un téléphone, il se compte en secondes — d'où le réveil de la
 * file de remontée côté salle, sans lequel un bouton resterait dix secondes à
 * décrire l'état d'avant et se ferait appuyer une seconde fois.
 */
export const useActionsStore = defineStore('actions', () => {
  const toast = useToast()
  const porte = useGatewayStore()

  /** Commandes en vol, par action. Sert à désarmer un bouton le temps du geste. */
  const pending = ref(0)

  async function act(
    geste: Record<string, unknown>,
    options: ActOptions = {},
  ): Promise<ActionResult> {
    pending.value += 1
    try {
      /*
       * Le transport vit dans la porte ; ici on ne garde que ce qui se voit.
       *
       * Les deux portes rendent la même forme et n'échouent jamais par
       * exception : un échec revient à l'opérateur en message, pas en page
       * cassée au milieu d'une intervention.
       */
      const result = await porte.act(geste)
      const message = result.message ?? (result.ok ? 'Fait' : 'Échec')
      if (!result.ok) toast.fail(message)
      else if (options.silent !== true) toast.say(message)
      return result
    } finally {
      pending.value -= 1
    }
  }

  return { pending, act }
})
