/**
 * Records the current state of the migrations as the reference.
 *
 * To be run after ADDING a migration, never to silence an anomaly: sealing a
 * regenerated baseline reintroduces precisely the defect the check exists to
 * catch.
 */
import { SETS, seal, verify } from './fingerprints.mjs'

for (const set of SETS) {
  const { anomalies } = verify(set)
  for (const { tag, problem } of anomalies) {
    console.warn(`⚠  ${set}/${tag} : migration publiée ${problem} — vérifiez que c'est voulu.`)
  }
  const sealedSet = seal(set)
  console.log(`${set} : ${Object.keys(sealedSet).length} migration(s) scellée(s)`)
}
