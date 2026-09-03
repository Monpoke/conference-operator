/**
 * Suivi d'un flux qui se reconnecte.
 *
 * Deux défauts que ce petit objet corrige, tous deux constatés en journal :
 *
 * 1. **On n'apprenait jamais que ça repartait.** Seuls les échecs étaient
 *    tracés. Devant une pile de « nouvelle tentative », rien ne disait si la
 *    salle avait fini par se rattacher — l'information qui décide si on va voir
 *    la baie réseau ou pas.
 * 2. **Une coupure longue noyait le reste.** Le flux de commandes réessaie
 *    toutes les 2 s : une demi-heure d'indisponibilité écrivait 900 lignes
 *    identiques, et le message important passait dessous.
 *
 * D'où la politique : le premier échec est tracé, les suivants sont comptés et
 * résumés au plus une fois par minute, et le rétablissement est annoncé avec la
 * durée réelle de l'interruption.
 */
export interface EchecJournalise {
  /** Ce qu'il faut écrire, ou `null` si l'échec est seulement comptabilisé. */
  message: string | null
  tentatives: number
}

export class SuiviInterruption {
  private tentatives = 0
  private startMs: number | null = null
  private dernierJournalMs = 0

  constructor(
    private readonly libelle: string,
    private readonly now: () => number = Date.now,
    /** Silence entre deux rappels pendant une coupure qui dure. */
    private readonly rappelMs = 60_000,
  ) {}

  /** Déclare un échec. Renvoie ce qu'il convient d'écrire, s'il y a lieu. */
  echec(): EchecJournalise {
    const maintenant = this.now()
    this.tentatives += 1
    if (this.startMs == null) this.startMs = maintenant

    const premier = this.tentatives === 1
    if (premier || maintenant - this.dernierJournalMs >= this.rappelMs) {
      this.dernierJournalMs = maintenant
      return {
        tentatives: this.tentatives,
        message: premier
          ? `${this.libelle} interrompu, nouvelle tentative`
          : `${this.libelle} toujours interrompu — ${this.tentatives} tentatives depuis ${formaterDuree(maintenant - this.startMs)}`,
      }
    }
    return { message: null, tentatives: this.tentatives }
  }

  /**
   * Déclare le flux établi.
   *
   * Renvoie `null` si rien n'était cassé : le premier raccordement ne mérite
   * pas d'être annoncé comme un rétablissement.
   */
  retabli(): { message: string; tentatives: number } | null {
    if (this.startMs == null) return null
    const duree = this.now() - this.startMs
    const tentatives = this.tentatives
    this.tentatives = 0
    this.startMs = null
    this.dernierJournalMs = 0
    return {
      tentatives,
      message: `${this.libelle} rétabli après ${formaterDuree(duree)} et ${tentatives} tentative${tentatives > 1 ? 's' : ''}`,
    }
  }
}

/** Durée courte et lisible : on lit ça en régie, pas dans un rapport. */
export function formaterDuree(ms: number): string {
  const secondes = Math.round(ms / 1000)
  if (secondes < 60) return `${secondes} s`
  const minutes = Math.floor(secondes / 60)
  if (minutes < 60) return `${minutes} min ${String(secondes % 60).padStart(2, '0')} s`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}
