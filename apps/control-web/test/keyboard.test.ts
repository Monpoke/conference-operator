import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useKeyboardLayer, useKeyboardStore } from '../src/stores/keyboard.js'

/**
 * Les raccourcis, et ce qu'ils coûtent quand ils partent au mauvais moment.
 *
 * Deux d'entre eux basculent la projection devant du public, un troisième lance
 * une captation. Ce fichier existe avant la première modale de la régie, et
 * c'est délibéré : la protection de la page d'origine — lire `tagName`, lire
 * six attributs sur le `<body>` — ne survit pas à des modales qui n'écrivent
 * rien sur le `<body>` et dont les listes déroulantes sont des `<button>`.
 */

/**
 * Une frappe réduite à ce que les règles lisent.
 *
 * `Record<string, unknown>` plutôt que `Partial<KeyboardEvent>` : une cible
 * n'est ici qu'un `tagName` et un drapeau, et prétendre lui donner la surface
 * d'un `EventTarget` demanderait de fabriquer un élément par cas pour ne rien
 * vérifier de plus.
 */
function frappe(key: string, extras: Record<string, unknown> = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: { tagName: 'BODY', isContentEditable: false },
    preventDefault: () => {},
    ...extras,
  } as unknown as KeyboardEvent
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('ce qui appartient au navigateur', () => {
  it('laisse passer Ctrl, Cmd et Alt sans rien déclencher', () => {
    const clavier = useKeyboardStore()
    const partis: string[] = []
    clavier.push(() => ({ r: () => partis.push('rec') }))

    for (const modificateur of ['ctrlKey', 'metaKey', 'altKey']) {
      clavier.handle(frappe('r', { [modificateur]: true }))
    }

    /*
     * Ctrl+R recharge la page — et lançait la captation au passage, puisque
     * seule la lettre était lue. Une régie retrouvée en train d'enregistrer
     * sans que personne ne l'ait demandé, et rien à l'écran pour dire d'où ça
     * venait.
     */
    expect(partis).toEqual([])
  })

  it('laisse Maj passant, parce que ce n’est pas un raccourci du navigateur', () => {
    const clavier = useKeyboardStore()
    const partis: string[] = []
    clavier.push(() => ({ r: () => partis.push('rec') }))

    // « Maj+R » n'a pas de sens pour le navigateur, et c'est la même intention
    // que « r » pour qui tape vite.
    clavier.handle(frappe('R', { shiftKey: true }))

    expect(partis).toEqual(['rec'])
  })
})

describe('ce qui appartient à un champ', () => {
  it.each(['INPUT', 'SELECT', 'TEXTAREA'])('ne vole pas la frappe d’un %s', (balise) => {
    const clavier = useKeyboardStore()
    const partis: string[] = []
    clavier.push(() => ({ l: () => partis.push('live') }))

    // Les listes déroulantes comptent autant que les champs texte : un « l »
    // dans un choix de scène ne doit pas basculer la projection en direct.
    clavier.handle(frappe('l', { target: { tagName: balise } }))

    expect(partis).toEqual([])
  })

  it('ne vole pas la frappe d’un contenu éditable', () => {
    const clavier = useKeyboardStore()
    const partis: string[] = []
    clavier.push(() => ({ l: () => partis.push('live') }))

    clavier.handle(frappe('l', { target: { tagName: 'DIV', isContentEditable: true } }))

    expect(partis).toEqual([])
  })
})

describe('empilement', () => {
  it('ne sert que la couche du dessus', () => {
    const clavier = useKeyboardStore()
    const partis: string[] = []
    clavier.push(() => ({ l: () => partis.push('live') }))
    clavier.push(() => ({ y: () => partis.push('oui') }))

    clavier.handle(frappe('y'))

    expect(partis).toEqual(['oui'])
  })

  it('avale ce qu’elle n’a pas lié, au lieu de le laisser tomber en dessous', () => {
    const clavier = useKeyboardStore()
    const partis: string[] = []
    clavier.push(() => ({ r: () => partis.push('rec') }))
    clavier.push(() => ({ y: () => partis.push('oui') }))

    clavier.handle(frappe('r'))

    /*
     * Une question ouverte prend le clavier entier. Un « r » réflexe pendant
     * qu'on demande s'il faut enregistrer basculerait la captation sous la
     * question elle-même — c'est le geste qu'on ne peut pas défaire.
     */
    expect(partis).toEqual([])
  })

  it('rend le clavier à la couche du dessous quand celle du dessus s’en va', () => {
    const clavier = useKeyboardStore()
    const partis: string[] = []
    clavier.push(() => ({ r: () => partis.push('rec') }))
    const question = clavier.push(() => ({ y: () => partis.push('oui') }))

    clavier.pop(question)
    clavier.handle(frappe('r'))

    expect(partis).toEqual(['rec'])
  })

  it('dépile la bonne couche, même fermée dans le désordre', () => {
    const clavier = useKeyboardStore()
    const partis: string[] = []
    const dessous = clavier.push(() => ({ r: () => partis.push('rec') }))
    clavier.push(() => ({ y: () => partis.push('oui') }))

    // Deux modales empilées, et c'est celle du dessous qui se ferme la
    // première : la régie superpose la liste des rushes au programme.
    clavier.pop(dessous)
    clavier.handle(frappe('y'))

    expect(partis).toEqual(['oui'])
    expect(clavier.depth()).toBe(1)
  })

  it('ne fait rien quand plus personne n’écoute', () => {
    const clavier = useKeyboardStore()
    const id = clavier.push(() => ({ r: () => {} }))
    clavier.pop(id)

    expect(() => clavier.handle(frappe('r'))).not.toThrow()
    expect(clavier.depth()).toBe(0)
  })
})

describe('branchement réel', () => {
  it('écoute le document tant qu’une couche est posée, et pas après', () => {
    const clavier = useKeyboardStore()
    const partis: string[] = []
    const id = clavier.push(() => ({ l: () => partis.push('live') }))

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    expect(partis).toEqual(['live'])

    clavier.pop(id)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))

    // Un écouteur laissé sur le document après la dernière couche est un
    // raccourci qui part depuis une page où plus rien ne l'attend.
    expect(partis).toEqual(['live'])
  })
})

describe('couche liée à un composant', () => {
  it('se pose et se retire avec la portée qui la tient', () => {
    const clavier = useKeyboardStore()
    const partis: string[] = []
    const scope = effectScope()

    scope.run(() => {
      useKeyboardLayer({ l: () => partis.push('live') })
    })
    expect(clavier.depth()).toBe(1)

    scope.stop()

    // Une couche qui survit à sa modale est le pire des deux mondes : elle
    // avale les raccourcis d'une page qui n'a plus rien d'ouvert.
    expect(clavier.depth()).toBe(0)
  })

  it('attend l’ouverture, plutôt que le editing', async () => {
    const clavier = useKeyboardStore()
    const ouverte = ref(false)
    const scope = effectScope()

    scope.run(() => {
      useKeyboardLayer({ y: () => {} }, ouverte)
    })

    // Reka rend souvent le contenu avant de l'ouvrir : une couche posée dès le
    // editing volerait les touches à la page derrière.
    expect(clavier.depth()).toBe(0)

    ouverte.value = true
    await nextTick()
    expect(clavier.depth()).toBe(1)

    ouverte.value = false
    await nextTick()
    expect(clavier.depth()).toBe(0)
    scope.stop()
  })

  it('relit ses liaisons à chaque frappe, pas une fois pour toutes', () => {
    const clavier = useKeyboardStore()
    const partis: string[] = []
    const cible = ref('live')
    const scope = effectScope()

    scope.run(() => {
      useKeyboardLayer(() => ({ l: () => partis.push(cible.value) }))
    })

    clavier.handle(frappe('l'))
    cible.value = 'hold'
    clavier.handle(frappe('l'))

    // La conférence pilotée change en cours de journée : une liaison figée à
    // l'ouverture agirait sur celle d'avant.
    expect(partis).toEqual(['live', 'hold'])
    scope.stop()
  })
})
