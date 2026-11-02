import { describe, expect, it } from 'vitest'
import { envoiPourcent } from '../src/stores/youtube.js'

describe('how far a send has gone', () => {
  it('is unknown before its size, and bounded after', () => {
    expect(envoiPourcent({ octets: 0, taille: null })).toBeNull()
    expect(envoiPourcent({ octets: 50, taille: 200 })).toBe(25)
    expect(envoiPourcent({ octets: 300, taille: 200 })).toBe(100)
  })
})
