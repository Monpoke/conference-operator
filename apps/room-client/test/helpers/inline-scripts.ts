/**
 * Excerpt et analyse le JavaScript embarqué dans une page servie.
 *
 * Ces pages n'ont **aucune étape de build** : leur JavaScript vit dans un
 * template literal TypeScript, où le compilateur ne voit qu'une chaîne. Une
 * apostrophe mal échappée ou un backtick oublié y passe donc inaperçu jusqu'à
 * l'ouverture de la page — et casse *tout* le script, pas seulement la ligne
 * fautive.
 *
 * Piège précis rencontré : dans un template literal, `\'` s'effondre en `'`.
 * Écrire `d\'OBS-A` produit `d'OBS-A` au milieu d'une chaîne simple-quote, et
 * la page entière cesse de fonctionner.
 */
export function extraireScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)]
    .map((correspondance) => correspondance[1] ?? '')
    .filter((code) => code.trim().length > 0)
}

export interface ErreurScript {
  index: number
  message: string
}

/** Renvoie les erreurs de syntaxe, page par page. */
export function analyserScripts(html: string): ErreurScript[] {
  const erreurs: ErreurScript[] = []
  for (const [index, code] of extraireScripts(html).entries()) {
    try {
      // `new Function` analyse sans exécuter : exactement ce qu'on veut.
      new Function(code)
    } catch (cause) {
      erreurs.push({ index, message: (cause as Error).message })
    }
  }
  return erreurs
}
