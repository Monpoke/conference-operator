/**
 * Aplatit les `@layer` d'une feuille CSS, pour les tests.
 *
 * happy-dom ignore purement et simplement `@layer` : les règles qu'il contient
 * n'existent pas pour `getComputedStyle`. Or Tailwind v4 enveloppe **toute** sa
 * sortie dans des couches. Sans cet aplatissement, les tests qui vérifient la
 * visibilité *effective* d'un élément — ceux qui ont attrapé le défaut où les
 * onglets changeaient bien d'attribut sans que l'écran bouge — cesseraient
 * silencieusement de vérifier quoi que ce soit.
 *
 * L'ordre d'écriture des couches est déjà leur ordre de priorité pour les
 * règles ordinaires : les retirer préserve donc le résultat pour ce que ces
 * tests observent. Les navigateurs, eux, reçoivent la feuille intacte.
 */
export function aplatirCouches(css: string): string {
  let sortie = ''
  let i = 0

  while (i < css.length) {
    const debut = css.indexOf('@layer', i)
    if (debut === -1) {
      sortie += css.slice(i)
      break
    }
    sortie += css.slice(i, debut)

    // Deux formes coexistent : `@layer a, b;` qui ne fait que déclarer un
    // ordre, et `@layer a { … }` qui porte des règles.
    const accolade = css.indexOf('{', debut)
    const pointVirgule = css.indexOf(';', debut)
    if (pointVirgule !== -1 && (accolade === -1 || pointVirgule < accolade)) {
      i = pointVirgule + 1
      continue
    }
    if (accolade === -1) {
      sortie += css.slice(debut)
      break
    }

    let profondeur = 0
    let fin = accolade
    for (; fin < css.length; fin += 1) {
      if (css[fin] === '{') profondeur += 1
      else if (css[fin] === '}') {
        profondeur -= 1
        if (profondeur === 0) break
      }
    }
    // Récursif : Tailwind imbrique des couches dans des couches.
    sortie += aplatirCouches(css.slice(accolade + 1, fin))
    i = fin + 1
  }

  return sortie
}

/** Même opération, mais sur les blocs `<style>` d'une page complète. */
export function aplatirCouchesHtml(html: string): string {
  return html.replace(
    /<style>([\s\S]*?)<\/style>/g,
    (_tout, css: string) => `<style>${aplatirCouches(css)}</style>`,
  )
}
