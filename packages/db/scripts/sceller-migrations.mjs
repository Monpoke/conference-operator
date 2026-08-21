/**
 * Enregistre l'état actuel des migrations comme référence.
 *
 * À lancer après avoir AJOUTÉ une migration, jamais pour faire taire une
 * anomalie : sceller une ligne de base régénérée réintroduit précisément le
 * défaut que la vérification existe pour attraper.
 */
import { JEUX, sceller, verifier } from './empreintes.mjs'

for (const jeu of JEUX) {
  const { anomalies } = verifier(jeu)
  for (const { tag, probleme } of anomalies) {
    console.warn(`⚠  ${jeu}/${tag} : migration publiée ${probleme} — vérifiez que c'est voulu.`)
  }
  const scelle = sceller(jeu)
  console.log(`${jeu} : ${Object.keys(scelle).length} migration(s) scellée(s)`)
}
