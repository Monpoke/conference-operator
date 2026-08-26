/**
 * Laisse la page finir ce qu'elle a commencé.
 *
 * Les pages de la console enchaînent des `fetch` bouchonnés puis rendent ; les
 * tests attendaient une durée fixe de 20 ms, ce qui suffisait sur une machine au
 * repos et pas sur une machine chargée. Le défaut ne se voyait qu'en exécution
 * complète de la suite, sur un test différent à chaque fois — la signature d'une
 * attente calibrée plutôt que conditionnée.
 *
 * Deux formes, et la seconde est la bonne quand elle est disponible :
 *
 *  - **sans argument**, on cède la main à la boucle d'événements un nombre fixe
 *    de fois. Cela suffit aux rendus courts, et garde les appels lisibles ;
 *  - **avec une condition**, on interroge jusqu'à ce qu'elle soit vraie. C'est
 *    ce qu'il faut dès que la page enchaîne plusieurs allers-retours — une
 *    décision envoyée, puis le programme relu — parce que le nombre de tours
 *    nécessaires dépend alors de la machine, ce qu'un test ne doit jamais
 *    supposer.
 *
 * L'échéance ne sert qu'à échouer plutôt que de bloquer : une condition qui
 * n'arrive pas est un défaut, et le test doit le dire au lieu d'expirer.
 */
export async function attendreRendu(
  condition?: () => boolean,
  echeanceMs = 2_000,
): Promise<void> {
  if (condition == null) {
    for (let tour = 0; tour < 12; tour += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return
  }

  const limite = Date.now() + echeanceMs
  while (!condition()) {
    if (Date.now() > limite) {
      throw new Error(
        "La condition attendue n'est jamais devenue vraie : la page n'a pas fini ce qu'elle " +
          'avait commencé, ou elle ne le fera pas.',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  // Un tour de plus, pour le rendu qui suit la dernière réponse.
  await new Promise((resolve) => setTimeout(resolve, 0))
}
