import { PLANCHER_DB, type NiveauEntree } from './obs.js'

/**
 * Ramène le débit du vumètre à quelque chose d'affichable.
 *
 * OBS émet une cinquantaine de mesures par seconde et par entrée. Les relayer
 * telles quelles à chaque page ouverte reviendrait à annuler tout le travail
 * fait pour qu'une salle au repos ne produise aucun trafic.
 *
 * **On agrège en maximum, on n'échantillonne pas.** Prendre une mesure sur cinq
 * ferait manquer les crêtes — précisément ce qu'on regarde un vumètre pour
 * voir. Le maximum sur l'intervalle conserve la saturation la plus brève.
 */
export class AgregateurNiveaux {
  private accumule = new Map<string, { magnitude: number; crete: number }[]>()
  private dernierEnvoiMs = 0

  constructor(
    private readonly emettre: (inputs: NiveauEntree[]) => void,
    private readonly intervalMs = 100,
    private readonly now: () => number = Date.now,
  ) {}

  pousser(inputs: NiveauEntree[]): void {
    for (const entree of inputs) {
      const courant = this.accumule.get(entree.nom)
      if (courant == null) {
        this.accumule.set(
          entree.nom,
          entree.canaux.map((canal) => ({ ...canal })),
        )
        continue
      }
      entree.canaux.forEach((canal, index) => {
        const cible = courant[index]
        if (cible == null) {
          courant[index] = { ...canal }
          return
        }
        cible.magnitude = Math.max(cible.magnitude, canal.magnitude)
        cible.crete = Math.max(cible.crete, canal.crete)
      })
    }

    const maintenant = this.now()
    if (maintenant - this.dernierEnvoiMs < this.intervalMs) return
    this.dernierEnvoiMs = maintenant
    this.vider()
  }

  /** Envoie ce qui est accumulé, puis repart de zéro. */
  private vider(): void {
    if (this.accumule.size === 0) return
    const inputs = [...this.accumule.entries()].map(([nom, canaux]) => ({ nom, canaux }))
    this.accumule.clear()
    this.emettre(inputs)
  }

  /**
   * Déclare le silence.
   *
   * Appelé quand OBS se déconnecte : sans cela, la dernière mesure resterait
   * affichée et une régie muette montrerait un signal.
   */
  reinitialiser(): void {
    this.accumule.clear()
    this.dernierEnvoiMs = 0
  }
}

/** Position d'un niveau sur une échelle d'affichage, entre 0 et 1. */
export function proportion(db: number): number {
  if (db <= PLANCHER_DB) return 0
  return Math.min(1, (db - PLANCHER_DB) / -PLANCHER_DB)
}
