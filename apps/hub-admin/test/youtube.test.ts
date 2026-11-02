import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { useConfirmStore } from '../src/stores/confirm.js'
import { actionsPossibles, envoiPourcent } from '../src/stores/youtube.js'

describe('how far a send has gone', () => {
  it('is unknown before its size, and bounded after', () => {
    expect(envoiPourcent({ octets: 0, taille: null })).toBeNull()
    expect(envoiPourcent({ octets: 50, taille: 200 })).toBe(25)
    expect(envoiPourcent({ octets: 300, taille: 200 })).toBe(100)
  })
})

describe('what the chosen videos can take', () => {
  const envois = [
    { jobId: 'privee', state: 'termine', visibilite: 'private' },
    { jobId: 'publique', state: 'termine', visibilite: 'public' },
    { jobId: 'echec', state: 'echoue', visibilite: 'private' },
    { jobId: 'partie', state: 'en-cours', visibilite: 'private' },
  ] as const
  const vignettes = [{ cle: 'privee', state: 'prete' }, { cle: 'publique', state: 'calcul' }] as const
  const all = ['privee', 'publique', 'echec', 'partie', 'nouvelle']

  it('offers each action only to the videos it applies to', () => {
    expect(actionsPossibles(all, envois, vignettes)).toEqual({
      envoyer: ['echec', 'nouvelle'],
      publier: ['privee'],
      depublier: ['publique'],
      titres: ['privee', 'publique'],
      generer: ['privee'],
      envoyerVignettes: ['privee'],
    })
  })

  it('offers nothing without a choice', () => {
    expect(Object.values(actionsPossibles([], envois, vignettes)).flat()).toEqual([])
  })
})

describe('the confirmation', () => {
  const REQUEST = { title: 'Sûr ?', message: 'Vraiment.', confirmLabel: 'Oui' }

  it('resolves to the operator\'s answer, and closes', async () => {
    setActivePinia(createPinia())
    const store = useConfirmStore()
    const answer = store.ask(REQUEST)
    expect(store.request).toMatchObject(REQUEST)
    store.answer(true)
    await expect(answer).resolves.toBe(true)
    expect(store.request).toBeNull()
  })

  it('counts a question left open by another as refused', async () => {
    setActivePinia(createPinia())
    const store = useConfirmStore()
    const first = store.ask(REQUEST)
    const second = store.ask({ ...REQUEST, title: 'Autre ?' })
    await expect(first).resolves.toBe(false)
    store.answer(true)
    await expect(second).resolves.toBe(true)
  })
})
