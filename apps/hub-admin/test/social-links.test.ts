import { describe, expect, it } from 'vitest'
import { checkSocialLinks, MAX_SOCIAL_LINKS, normalizeUrl } from '../src/composables/socialLinks.js'

const row = (network: string, handle: string, url: string) => ({ network, handle, url })

describe('« Nos réseaux », checked before the hub', () => {
  it('drops a row left entirely empty, and only that', () => {
    const { links, errors } = checkSocialLinks([row('', '', ''), row('Site', 'cloudnord.fr', 'https://cloudnord.fr')])
    expect(errors).toEqual({})
    expect(links).toEqual([row('Site', 'cloudnord.fr', 'https://cloudnord.fr/')])
  })

  it('stops on a half-filled row and says what is missing', () => {
    // What the form used to drop without a word before saying « enregistrés ».
    const { errors } = checkSocialLinks([row('Site', 'cloudnord.fr', '')])
    expect(errors[0]).toEqual({ fields: ['url'], message: "Il manque l'adresse." })
    expect(checkSocialLinks([row('', 'x', '')]).errors[0]!.fields).toEqual(['network', 'url'])
  })

  it('completes an address typed the way people type it', () => {
    expect(normalizeUrl('cloudnord.fr')).toBe('https://cloudnord.fr/')
    expect(normalizeUrl('  www.linkedin.com/company/cloudnord ')).toBe('https://www.linkedin.com/company/cloudnord')
    expect(normalizeUrl('http://exemple.fr/a')).toBe('http://exemple.fr/a')
  })

  it('refuses what does not read as a web address', () => {
    expect(normalizeUrl('pas une adresse')).toBeNull()
    expect(normalizeUrl('localhost')).toBeNull()
    expect(normalizeUrl('ftp://exemple.fr')).toBeNull()
    const { errors } = checkSocialLinks([row('Site', 'x', 'pas une adresse')])
    expect(errors[0]!.fields).toEqual(['url'])
  })

  it('holds the hub s limits', () => {
    expect(checkSocialLinks([row('x'.repeat(41), 'h', 'exemple.fr')]).errors[0]!.fields).toEqual(['network'])
    expect(checkSocialLinks([row('Site', 'h'.repeat(81), 'exemple.fr')]).errors[0]!.fields).toEqual(['handle'])
    const many = Array.from({ length: MAX_SOCIAL_LINKS + 1 }, (_, index) => row(`R${index}`, 'h', 'exemple.fr'))
    expect(Object.keys(checkSocialLinks(many).errors)).toHaveLength(1)
  })
})
