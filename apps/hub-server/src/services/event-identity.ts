import { resoudreIdentiteEvenement, type EventIdentity } from '@cloudnord/contract'
import type { ProgramService } from './program.js'
import type { SettingsService } from './sessions.js'

/**
 * Qui est l'événement, pour tout ce que le hub affiche ou envoie.
 *
 * Le hub tranche, une fois, et tout le reste consomme le résultat : le mur
 * public, la console, le service worker des notifications, et le `sync` des
 * salles. Le déduire séparément dans chaque page rendait le produit
 * inrenommable — c'est exactement le défaut que ce service supprime.
 *
 * Deux sources et un ordre : le réglage du hub s'il existe, sinon le programme
 * importé. Le second est le cas normal, et c'est lui qui rend le dépôt
 * agnostique : importer l'export d'un autre événement renomme tout.
 *
 * Lu à chaque usage plutôt que mis en cache, comme les réglages dont il
 * dépend : le nom se corrige en cours d'événement, et le voir persister dix
 * secondes après l'avoir changé ferait douter que le réglage soit pris.
 */
export class EventIdentityService {
  constructor(
    private readonly settings: SettingsService,
    private readonly programs: ProgramService,
  ) {}

  /**
   * Ce que le hub retiendrait **sans** réglage.
   *
   * Sert à la console, qui l'affiche en `placeholder` des champs laissés
   * vides : sans elle, un opérateur ne peut pas savoir ce qu'il obtiendra en
   * vidant le champ, donc n'ose pas le vider — et le réglage devient un
   * aller sans retour.
   */
  derived(): EventIdentity {
    return resoudreIdentiteEvenement({ programme: this.programs.activeEventName() })
  }

  get(): EventIdentity {
    const reglages = this.settings.get()
    return resoudreIdentiteEvenement({
      reglage: { name: reglages.eventName, shortName: reglages.eventShortName },
      programme: this.programs.activeEventName(),
    })
  }
}
