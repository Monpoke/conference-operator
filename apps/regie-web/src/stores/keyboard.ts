import { defineStore } from 'pinia'
import { onScopeDispose, ref, toValue, watchEffect, type MaybeRefOrGetter } from 'vue'

/** Ce qu'une couche fait d'une touche. Les touches sont en minuscules. */
export type Bindings = Record<string, () => void>

interface Layer {
  id: number
  bindings: () => Bindings
}

/**
 * Les raccourcis, en couches, et une seule reçoit le clavier.
 *
 * Dans une salle sombre, viser un bouton coûte plus cher qu'appuyer sur une
 * touche : la régie a donc des raccourcis d'une lettre, et deux d'entre eux
 * — `l` et `h` — basculent la projection en direct, devant du public.
 *
 * La page d'origine s'en protégeait en lisant `event.target.tagName` et en
 * consultant six attributs `data-` sur le `<body>`. Aucune des deux défenses ne
 * survit à Reka : une modale n'écrit rien sur le `<body>`, et un `SelectTrigger`
 * est un `<button>` — chercher « LIVE » dans une liste de scènes en tapant `l`
 * basculerait la projection, en salle, pendant un talk. C'est pour cela que ce
 * mécanisme existe **avant** la première modale, et pas après.
 *
 * La règle est simple et sans exception : une couche empilée reçoit tout, et ce
 * qu'elle n'a pas lié, elle l'avale. Une question ouverte prend le clavier
 * entier — un « r » réflexe pendant qu'on demande s'il faut enregistrer ne peut
 * pas basculer la captation sous la question elle-même.
 */
export const useKeyboardStore = defineStore('keyboard', () => {
  const layers = ref<Layer[]>([])
  let nextId = 0
  let installed: ((event: KeyboardEvent) => void) | null = null

  /**
   * Ce que la couche du dessus fait de la frappe, ou rien.
   *
   * Exposé pour que les règles se vérifient sans clavier ni document : ce sont
   * elles qui comptent, pas le chemin qui les atteint.
   */
  function handle(event: KeyboardEvent): void {
    /*
     * Une touche tenue avec Ctrl, Cmd ou Alt appartient au navigateur.
     *
     * Ctrl+R recharge la page — et lançait la captation au passage, puisque
     * seule la lettre était lue. Une régie retrouvée en train d'enregistrer
     * sans que personne ne l'ait demandé, un fichier de plus sur le disque, et
     * rien à l'écran pour dire d'où ça venait. Ctrl+S, Ctrl+P, Ctrl+L posaient
     * le même piège sur d'autres lettres.
     *
     * Maj reste passant : « Maj+R » n'a pas de sens pour le navigateur, et
     * c'est la même intention que « r » pour qui tape vite.
     */
    if (event.ctrlKey || event.metaKey || event.altKey) return

    /*
     * Une frappe destinée à un champ lui appartient.
     *
     * Les listes déroulantes comptent autant que les champs texte : une touche
     * `l` dans un choix de scène ne doit pas basculer la projection. C'est
     * aussi pourquoi les listes de la régie restent des `<select>` natifs —
     * remplacées par un composant à `<button>`, elles sortiraient de ce filet.
     */
    const cible = event.target as { tagName?: string; isContentEditable?: boolean } | null
    if (cible?.isContentEditable === true) return
    const balise = cible?.tagName
    if (balise === 'INPUT' || balise === 'SELECT' || balise === 'TEXTAREA') return

    const top = layers.value.at(-1)
    if (top == null) return

    const action = top.bindings()[event.key.toLowerCase()]
    // Rien de lié : la couche l'avale quand même. C'est ce qui empêche une
    // question ouverte de laisser passer un raccourci vers la conférence.
    if (action == null) return
    event.preventDefault()
    action()
  }

  function push(bindings: () => Bindings): number {
    const id = nextId++
    layers.value.push({ id, bindings })
    if (installed == null && typeof document !== 'undefined') {
      installed = (event: KeyboardEvent) => handle(event)
      document.addEventListener('keydown', installed)
    }
    return id
  }

  function pop(id: number): void {
    layers.value = layers.value.filter((layer) => layer.id !== id)
    if (layers.value.length === 0 && installed != null && typeof document !== 'undefined') {
      document.removeEventListener('keydown', installed)
      installed = null
    }
  }

  /** La couche qui reçoit, pour les tests et pour ce qui veut s'en enquérir. */
  const depth = (): number => layers.value.length

  return { layers, handle, push, pop, depth }
})

/**
 * Pose une couche de raccourcis le temps qu'un composant vive.
 *
 * `active` permet à une modale de garder son composant monté sans prendre le
 * clavier : Reka rend souvent le contenu avant de l'ouvrir, et une couche posée
 * dès le montage volerait les touches à la page derrière.
 */
export function useKeyboardLayer(
  bindings: MaybeRefOrGetter<Bindings>,
  active: MaybeRefOrGetter<boolean> = true,
): void {
  const keyboard = useKeyboardStore()
  let id: number | null = null

  const sync = (): void => {
    const veut = toValue(active)
    if (veut && id == null) id = keyboard.push(() => toValue(bindings))
    else if (!veut && id != null) {
      keyboard.pop(id)
      id = null
    }
  }

  // `watchEffect` s'exécute immédiatement : la couche est posée dès l'appel si
  // elle doit l'être, et suit ensuite ce que `active` devient.
  watchEffect(sync)
  onScopeDispose(() => {
    if (id != null) keyboard.pop(id)
  })
}
