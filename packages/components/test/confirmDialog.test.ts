import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ConfirmDialog from '../src/ui/ConfirmDialog.vue'

/**
 * Les deux réponses, au clavier.
 *
 * Dans une salle sombre, viser un bouton coûte plus cher qu'appuyer sur une
 * touche : c'est la raison d'être des raccourcis d'une lettre de toute la
 * régie, et une question qui interrompt un talk est l'endroit où ça compte le
 * plus.
 *
 * Les lettres étaient des **étiquettes**, liées par qui montait la modale. Deux
 * questions sur quatre en avaient, donc deux sur quatre répondaient au clavier,
 * et rien à l'écran ne les distinguait. Elles sont désormais imprimées et liées
 * au même endroit : elles ne peuvent plus diverger.
 */

/** Le portail de Reka rend hors du composant : c'est le document qu'on lit. */
const monter = (props: Record<string, unknown> = {}) =>
  mount(ConfirmDialog, {
    props: { open: true, title: 'Terminer en avance ?', confirmLabel: 'Terminer', ...props },
    attachTo: document.body,
  })

const frappe = (key: string, options: KeyboardEventInit = {}): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options }))
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ConfirmDialog au clavier', () => {
  it('imprime Y et N sans qu’on ait à les demander', async () => {
    const wrapper = monter()
    await flushPromises()

    // Une modale muette au clavier et une modale qui répond se ressemblaient
    // trait pour trait : le défaut est ce qui les réunit.
    expect(document.body.textContent).toContain('Y')
    expect(document.body.textContent).toContain('N')
    wrapper.unmount()
  })

  it('confirme sur « y », et referme comme le ferait le clic', async () => {
    const wrapper = monter()
    await flushPromises()

    frappe('y')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toHaveLength(1)
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
    wrapper.unmount()
  })

  it('accepte « o » autant que « y »', async () => {
    // La moitié des opérateurs tape l'un, l'autre moitié l'autre, et se tromper
    // de lettre sur cette question-là coûte un talk.
    const wrapper = monter()
    await flushPromises()

    frappe('o')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toHaveLength(1)
    wrapper.unmount()
  })

  it('referme sur « n » sans rien confirmer', async () => {
    const wrapper = monter()
    await flushPromises()

    frappe('n')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
    wrapper.unmount()
  })

  it('laisse au navigateur ce qui est tenu avec Ctrl, Cmd ou Alt', async () => {
    // `Ctrl+N` ouvre une fenêtre : lire la seule lettre annulerait la question
    // au passage, et rien à l'écran ne dirait d'où ça vient.
    const wrapper = monter()
    await flushPromises()

    frappe('n', { ctrlKey: true })
    frappe('y', { metaKey: true })
    frappe('y', { altKey: true })
    await flushPromises()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.emitted('update:open')).toBeUndefined()
    wrapper.unmount()
  })

  it('laisse au champ la frappe qui lui est destinée', async () => {
    /*
     * La modale de remise à zéro arme son bouton en faisant taper un mot. Une
     * lettre saisie là-dedans ne doit pas répondre à la question derrière — et
     * un `<select>` compte autant qu'un champ texte.
     */
    const wrapper = monter()
    await flushPromises()
    const champ = document.createElement('input')
    document.body.appendChild(champ)

    champ.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    wrapper.unmount()
  })

  it('ne contourne pas un bouton désarmé', async () => {
    // La touche est le bouton, pas un moyen de passer devant.
    const wrapper = monter({ confirmDisabled: true })
    await flushPromises()

    frappe('y')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.emitted('update:open')).toBeUndefined()
    wrapper.unmount()
  })

  it('n’imprime ni ne lie rien quand la lettre est retirée', async () => {
    const wrapper = monter({ confirmKey: null, cancelKey: null })
    await flushPromises()

    frappe('y')
    frappe('n')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.emitted('update:open')).toBeUndefined()
    wrapper.unmount()
  })

  it('reste muette une fois refermée', async () => {
    // L'écouteur vit avec le composant, pas avec l'ouverture : sans ce test,
    // une modale fermée répondrait encore au clavier de la page derrière.
    const wrapper = monter({ open: false })
    await flushPromises()

    frappe('y')
    await flushPromises()

    expect(wrapper.emitted('confirm')).toBeUndefined()
    wrapper.unmount()
  })
})
