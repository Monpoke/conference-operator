import { DB_FLOOR, type InputLevel } from './obs.js'

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
  private accumule = new Map<string, { magnitude: number; peak: number }[]>()
  private dernierEnvoiMs = 0

  constructor(
    private readonly emettre: (inputs: InputLevel[]) => void,
    private readonly intervalMs = 100,
    private readonly now: () => number = Date.now,
  ) {}

  pousser(inputs: InputLevel[]): void {
    for (const entree of inputs) {
      const courant = this.accumule.get(entree.name)
      if (courant == null) {
        this.accumule.set(
          entree.name,
          entree.channels.map((canal) => ({ ...canal })),
        )
        continue
      }
      entree.channels.forEach((canal, index) => {
        const cible = courant[index]
        if (cible == null) {
          courant[index] = { ...canal }
          return
        }
        cible.magnitude = Math.max(cible.magnitude, canal.magnitude)
        cible.peak = Math.max(cible.peak, canal.peak)
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
    const inputs = [...this.accumule.entries()].map(([name, channels]) => ({ name, channels }))
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
  if (db <= DB_FLOOR) return 0
  return Math.min(1, (db - DB_FLOOR) / -DB_FLOOR)
}
