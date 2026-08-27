import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAMPS_PAR_VUE } from '@cloudnord/contract'
import { describe, expect, it } from 'vitest'

/**
 * Le flux d'état ne pousse à la régie que les champs qu'elle lit.
 *
 * Le risque de ce découpage est silencieux : un champ ajouté à la page mais
 * oublié dans `CHAMPS_PAR_VUE` ne lève rien, il affiche du vide. Ce test relit
 * donc les sources et compare ce qu'elles consultent à ce qu'elles reçoivent.
 *
 * Hérité du garde-fou de la page qu'elle remplace, avec la correction qui l'a
 * accompagné : `payload?.champ` compte autant que `payload.champ`. Le motif
 * d'origine ignorait l'optionnel, et le seul champ qu'une page lisait ainsi —
 * le mur, dans le menu des écrans — manquait à la liste sans que rien ne le
 * dise. L'ancienne page n'en souffrait pas par accident : elle ne construisait
 * ce menu qu'une fois, sur l'état embarqué, qui n'est pas filtré. Celle-ci le
 * recalcule, et le lien aurait disparu à la première seconde.
 */
const RACINE = join(import.meta.dirname, '..', 'src')

function sources(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((entree) => {
    const chemin = join(dossier, entree.name)
    if (entree.isDirectory()) return sources(chemin)
    return /\.(ts|vue)$/.test(entree.name) ? [chemin] : []
  })
}

/**
 * Ce que la régie consulte dans la charge utile.
 *
 * Trois façons de la nommer, parce qu'elle traverse trois couches : `payload`
 * dans les composants qui la reçoivent en prop, `payload.value` dans le store
 * qui la tient, et `room.payload` chez qui lit le store.
 */
function champsLus(): string[] {
  const trouves = new Set<string>()
  for (const fichier of sources(RACINE)) {
    const source = readFileSync(fichier, 'utf8')
    for (const motif of [
      /\bpayload[!?]?\.(?:value[!?]?\.)?([a-zA-Z]+)/g,
      /\bpayload\.value[!?]?\.([a-zA-Z]+)/g,
    ]) {
      for (const trouve of source.matchAll(motif)) trouves.add(trouve[1]!)
    }
  }
  // `value` est l'accès au ref, pas un champ ; le reste est du bruit de nommage.
  trouves.delete('value')
  return [...trouves].sort()
}

describe('champs du flux', () => {
  const recus = new Set<string>(CHAMPS_PAR_VUE.regie as readonly string[])

  it('la régie reçoit tout ce qu’elle consulte', () => {
    const manquants = champsLus().filter((champ) => !recus.has(champ))
    expect(
      manquants,
      manquants.length === 0
        ? ''
        : `la régie lit ${manquants.join(', ')} — à ajouter dans CHAMPS_PAR_VUE.regie, ` +
          "sinon la page rend du vide sans lever d'erreur.",
    ).toEqual([])
  })

  it('ne reçoit rien d’inutile', () => {
    // L'inverse compte aussi : un champ envoyé sans être lu est du trafic pur,
    // à chaque changement d'état, sur une machine qui encode.
    const lus = new Set(champsLus())
    expect([...recus].filter((champ) => !lus.has(champ))).toEqual([])
  })

  it('la lecture des sources trouve bien quelque chose', () => {
    // Garde-fou du garde-fou : une extraction devenue muette ferait passer les
    // deux tests précédents en ne vérifiant rien.
    expect(champsLus().length).toBeGreaterThan(3)
  })
})
