import { describe, expect, it } from 'vitest'
import { genererMotDePasse, lienAvecMotDePasse } from '../src/stores/partages.js'

describe('a generated password', () => {
  it('is long enough, and free of look-alikes', () => {
    const password = genererMotDePasse()
    expect(password).toHaveLength(14)
    expect(password).not.toMatch(/[il1o0]/)
  })
})

describe('the link holding the password', () => {
  it('survives the characters an address gives a meaning to', () => {
    const link = new URL(lienAvecMotDePasse('https://hub.test/partage/a', 'a b&c=d+e#f'))
    expect(link.searchParams.get('mdp')).toBe('a b&c=d+e#f')
  })
})
