import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { vodHabillageSchema, type Sidecar } from '@conference-operator/contract'
import { normalizeProgram } from '@conference-operator/program'
import { buildVodHabillage, renderVodDocument } from '../src/server/index.js'

const program = normalizeProgram(JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'program', 'test', 'fixtures', 'cloudnord-2026.json'), 'utf8'),
))

const sidecar: Pick<Sidecar, 'sessionId' | 'title' | 'speakers' | 'category'> = {
  sessionId: 'cmq3nx20102h901ppuyjkennd',
  title: 'Titre du jour',
  speakers: [{ name: 'Quelqu’un', company: null }],
  category: null,
}

describe('what the intro and outro show', () => {
  it('takes the talk from the program: title, photos, category colour', () => {
    const h = buildVodHabillage({ program, boucle: null, sidecar, eventName: null, localize: (ref) => ref })
    expect(vodHabillageSchema.parse(h)).toEqual(h)
    expect(h.event).toMatchObject({ name: 'Cloud Nord 2026', date: '30 octobre 2026' })
    expect(h.talk).toMatchObject({ category: 'Data & IA', color: '#a14a68' })
    expect(h.speakers.map((s) => s.name)).toEqual(['Guillaume Leroy', 'Mazlum Tosun'])
    expect(h.speakers.every((s) => s.photoUrl != null)).toBe(true)
  })

  it('falls back on the sidecar for a talk the program does not know', () => {
    const h = buildVodHabillage({ program, boucle: null, sidecar: { ...sidecar, sessionId: 'inconnue' }, eventName: 'CN', localize: (ref) => ref })
    expect(h.talk.title).toBe('Titre du jour')
    expect(h.speakers).toEqual([{ name: 'Quelqu’un', company: null, photoUrl: null }])
    expect(h.event.name).toBe('CN')
  })

  it('lays the sponsors out as the loop does when the console set nothing', () => {
    const h = buildVodHabillage({ program, boucle: null, sidecar, eventName: null, localize: (ref) => ref })
    // The last two tiers only hold sponsors already shown higher up: they go.
    expect(h.sponsorPages.map((p) => p.titre)).toEqual(['', 'Digital'])
    expect(h.merci).toBe('Merci à nos sponsors')
  })

  it('shows each sponsor once, in its highest tier', () => {
    const h = buildVodHabillage({ program, boucle: null, sidecar, eventName: null, localize: (ref) => ref })
    const names = h.sponsorPages.flatMap((p) => p.rangs.flatMap((r) => r.logos.map((l) => l.nom.toLowerCase())))
    expect(new Set(names).size).toBe(names.length)
    // Ape Factory took three packs: it stays in the first one it appears in.
    const tierOf = (name: string) => h.sponsorPages.findIndex((p) => p.rangs.some((r) => r.logos.some((l) => l.nom.toLowerCase().includes(name))))
    expect(tierOf('ape factory')).toBe(h.sponsorPages.findIndex((p) => p.titre === 'Digital'))
  })

  it('recognises a sponsor laid out by hand under another spelling', () => {
    const h = buildVodHabillage({
      program: null,
      boucle: {
        logo: null,
        merciSponsors: 'Merci',
        sponsorPages: [
          { titre: '', duree: null, rangs: [{ taille: 1, logos: [{ sponsor: 'Ape Factory', nom: null, logo: null, echelle: 0.7 }] }] },
          { titre: 'Autres', duree: null, rangs: [{ taille: 1, logos: [
            { sponsor: 'APE-factory', nom: null, logo: null, echelle: 0.7 },
            { sponsor: 'Jetdev', nom: null, logo: null, echelle: 0.7 },
          ] }] },
        ],
      },
      sidecar,
      eventName: null,
      localize: (ref) => ref,
    })
    expect(h.sponsorPages.map((p) => p.rangs.flatMap((r) => r.logos.map((l) => l.nom)))).toEqual([['Ape Factory'], ['Jetdev']])
  })

  it('prefers the console’s logo, and shows nothing it cannot localise', () => {
    const h = buildVodHabillage({
      program,
      boucle: { logo: 'hub-image:abc.png', sponsorPages: null, merciSponsors: 'Merci !' },
      sidecar,
      eventName: null,
      localize: (ref) => (ref?.startsWith('hub-image:') ? '/assets/x' : null),
    })
    expect(h.event.logoUrl).toBe('/assets/x')
    expect(h.speakers.every((s) => s.photoUrl == null)).toBe(true)
    expect(h.merci).toBe('Merci !')
  })
})

describe('the clip document', () => {
  const habillage = buildVodHabillage({ program, boucle: null, sidecar, eventName: null, localize: (ref) => ref })

  it('carries its content and freezes only when captured', () => {
    const preview = renderVodDocument({ clip: 'intro', habillage })
    expect(preview).toContain('id="vod-donnees"')
    expect(preview).not.toContain('__VOD_CAPTURE__ = true')
    expect(renderVodDocument({ clip: 'outro', habillage, capture: true })).toContain('__VOD_CAPTURE__ = true')
  })

  it('cannot be closed early by a title', () => {
    const html = renderVodDocument({ clip: 'intro', habillage: { ...habillage, talk: { ...habillage.talk, title: '</script><b>x' } } })
    expect(html).not.toContain('</script><b>x')
  })
})
