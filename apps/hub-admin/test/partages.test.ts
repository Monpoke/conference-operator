import { describe, expect, it } from 'vitest'
import { genererMotDePasse } from '../src/stores/partages.js'

describe('a generated password', () => {
  it('is long enough, and free of look-alikes', () => {
    const password = genererMotDePasse()
    expect(password).toHaveLength(14)
    expect(password).not.toMatch(/[il1o0]/)
  })
})
