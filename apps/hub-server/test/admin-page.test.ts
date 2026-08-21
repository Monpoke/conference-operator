/// <reference lib="dom" />
// La lib DOM est déclarée ici seulement : l'ajouter au tsconfig laisserait le
// code serveur appeler `document` sans que rien ne proteste.
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aplatirCouchesHtml } from '@cloudnord/ui'
import { renderAdminPage } from '../src/pages/admin-page.js'

/**
 * Comportement de la console, exécutée dans un vrai DOM.
 *
 * Ces pages n'ont pas d'étape de build : sans ce niveau de test, seule leur
 * syntaxe est vérifiée, et un bouton qui ne réagit pas passe inaperçu jusqu'à
 * ce que quelqu'un clique dessus le jour J.
 */
function monterConsole(): void {
  document.documentElement.innerHTML = aplatirCouchesHtml(renderAdminPage())
  // `innerHTML` n'exécute pas les <script> : on les rejoue à la main.
  for (const script of document.querySelectorAll('script:not([type])')) {
    // eslint-disable-next-line no-new-func
    new Function(script.textContent ?? '')()
  }
}

const $ = (id: string) => document.getElementById(id)!

/**
 * Visibilité **effective**, feuille de style comprise.
 *
 * Vérifier l'attribut `hidden` ne suffit pas : la règle du navigateur qui le
 * traduit en `display: none` vient de la feuille user-agent, et la moindre
 * règle d'auteur posant un `display` la bat. C'est ce qui rendait les onglets
 * sans effet alors que l'attribut, lui, changeait bien.
 */
function estVisible(id: string): boolean {
  const element = $(id)
  if (element.hasAttribute('hidden')) {
    const calcule = globalThis.getComputedStyle(element).display
    return calcule !== 'none'
  }
  return true
}

beforeEach(() => {
  localStorage.clear()
  // Session présente : la console s'affiche directement, sans écran de connexion.
  localStorage.setItem('cloudnord-admin', 'jeton-de-test')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ json: [] }), { status: 200 })),
  )
  monterConsole()
})

describe('fond de page', () => {
  it('peint son propre fond, sans compter sur celui du navigateur', () => {
    // Le fond venait d'une règle `body` de l'ancienne feuille. En la
    // remplaçant sans reposer de classes, la console s'est retrouvée sur le
    // blanc par défaut du navigateur — illisible sur un thème sombre.
    const fond = globalThis.getComputedStyle(document.body).backgroundColor
    expect(fond).not.toBe('')
    expect(fond).not.toMatch(/transparent|rgba\(0, 0, 0, 0\)|(^|[^0-9])255, 255, 255/)
  })
})

describe('feuille de style vue par le DOM de test', () => {
  it('les utilitaires Tailwind sont bien chargés', () => {
    // Garde-fou du garde-fou : happy-dom ignore `@layer`, où vit toute la
    // feuille. Sans aplatissement, `getComputedStyle` renverrait du vide et
    // `estVisible` répondrait « visible » pour tout — les tests d'onglets
    // passeraient sans rien vérifier.
    const sonde = document.createElement('div')
    sonde.className = 'flex'
    document.body.append(sonde)
    expect(globalThis.getComputedStyle(sonde).display).toBe('flex')
  })
})

describe('navigation de la console', () => {
  it('affiche l\'exploitation seule par défaut', () => {
    expect(estVisible('vue-exploitation')).toBe(true)
    expect(estVisible('vue-conferences')).toBe(false)
    expect(estVisible('vue-reglages')).toBe(false)
    expect($('nav-exploitation').classList.contains('actif')).toBe(true)
  })

  it('bascule sur les conférences', () => {
    $('nav-conferences').click()

    expect(estVisible('vue-conferences')).toBe(true)
    // Sans la règle qui rend `hidden` prioritaire, l'exploitation resterait
    // affichée sous les conférences et l'onglet semblerait inerte.
    expect(estVisible('vue-exploitation')).toBe(false)
    expect($('nav-conferences').classList.contains('actif')).toBe(true)
    expect($('nav-exploitation').classList.contains('actif')).toBe(false)
  })

  it('bascule sur les réglages', () => {
    $('nav-reglages').click()
    expect(estVisible('vue-reglages')).toBe(true)
    expect(estVisible('vue-conferences')).toBe(false)
    expect($('auto-delai')).toBeTruthy()
  })

  it('revient à l\'exploitation', () => {
    $('nav-reglages').click()
    $('nav-exploitation').click()
    expect(estVisible('vue-exploitation')).toBe(true)
    expect(estVisible('vue-reglages')).toBe(false)
  })

  it('offre un écran dédié à la modération', () => {
    $('nav-moderation').click()
    expect(estVisible('vue-moderation')).toBe(true)
    // Elle ne doit plus encombrer l'écran d'exploitation.
    expect(estVisible('vue-exploitation')).toBe(false)
    expect($('moderation')).toBeTruthy()
  })

  it('une seule vue à la fois, quel que soit l\'onglet', () => {
    for (const onglet of ['exploitation', 'conferences', 'moderation', 'messages', 'reglages']) {
      $('nav-' + onglet).click()
      const visibles = ['exploitation', 'conferences', 'moderation', 'messages', 'reglages'].filter((vue) =>
        estVisible('vue-' + vue),
      )
      expect(visibles).toEqual([onglet])
    }
  })

  it('ne charge que la vue affichée', async () => {
    const mock = globalThis.fetch as unknown as { mock: { calls: [string][]; }; mockClear: () => void }
    // Le chargement initial appelle tout : on repart d'une ardoise propre pour
    // n'observer que ce que déclenche la bascule.
    await new Promise((resolve) => setTimeout(resolve, 10))
    mock.mockClear()

    $('nav-reglages').click()
    await new Promise((resolve) => setTimeout(resolve, 10))

    const urls = mock.mock.calls.map((appel) => String(appel[0]))
    // Rafraîchir des panneaux invisibles solliciterait le hub pour rien.
    expect(urls.some((url) => url.includes('settings/get'))).toBe(true)
    expect(urls.some((url) => url.includes('wall/pending'))).toBe(false)
  })
})
