/**
 * Laisse la page finir ce qu'elle a commencé.
 *
 * Les pages de la console enchaînent des `fetch` bouchonnés puis rendent ; les
 * tests attendaient jusqu'ici une durée fixe de 20 ms, ce qui suffisait sur une
 * machine au repos et pas sur une machine chargée. Le défaut ne se voyait qu'en
 * exécution complète de la suite, sur un test différent à chaque fois — la
 * signature d'une attente calibrée plutôt que conditionnée.
 *
 * On cède la main à la boucle d'événements plusieurs fois de suite : chaque
 * tour laisse passer une génération de promesses résolues, et douze tours
 * couvrent les chaînes les plus longues de ces pages sans dépendre de la charge
 * de la machine. Ce qui resterait au-delà n'attendrait plus un rendu mais un
 * vrai minuteur, et se déclarerait alors explicitement.
 */
export async function attendreRendu(tours = 12): Promise<void> {
  for (let tour = 0; tour < tours; tour += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
