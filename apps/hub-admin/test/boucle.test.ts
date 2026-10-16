import { DEFAULT_BOUCLE, type Boucle } from '@conference-operator/contract'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import BoucleView from '../src/views/BoucleView.vue'
import { ImageRefused, absentSponsors, findSponsor, placeSponsor, prepareImage, useBoucleStore } from '../src/stores/boucle.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * The « Boucle » view.
 *
 * What is worth holding: each panel sends its own sections and nothing else —
 * the hub merges section by section, and a panel that sent everything would
 * undo, on save, what another operator saved meanwhile; a panel being edited is
 * not redrawn by the refresh; the sponsor pages go from automatic to laid out
 * and back; and a logo naming a sponsor the program does not know says so.
 */

interface Call {
  path: string
  input: unknown
}

const APE = { key: 'https://nova-atelier.test', name: 'NOVA Atelier', website: 'https://nova-atelier.test', logoPreview: '/assets/ape', tiers: ['Gold', 'Silver'] }
const ZEPHYRA = { key: 'https://zephyra.example', name: 'Zephyra', website: 'https://zephyra.example', logoPreview: null, tiers: ['Gold'] }
const DEFAULT_PAGES = [
  {
    titre: '',
    duree: null,
    rangs: [
      {
        taille: 1,
        logos: [
          { sponsor: APE.key, nom: null, logo: null, echelle: 0.8 },
          { sponsor: ZEPHYRA.key, nom: null, logo: null, echelle: 0.8 },
        ],
      },
    ],
  },
]

const ANCIEN = {
  id: 'ancien',
  nom: 'Ancien thème',
  sha: 'a'.repeat(64),
  version: '1',
  auteur: null,
  importeLe: '2026-10-01T08:00:00.000Z',
  taille: 1024,
}

function stub(boucle: Boucle = DEFAULT_BOUCLE) {
  const calls: Call[] = []
  // Held like the hub: section by section.
  let current: Boucle = JSON.parse(JSON.stringify(boucle))
  const settings = () => ({ openFeedbackProjectId: 'cloud-nord-2026', boucle: JSON.parse(JSON.stringify(current)) })
  const client = {
    token: { read: () => 'jeton', write: () => {}, clear: () => {} },
    rpc: {
      settings: {
        get: async () => {
          calls.push({ path: 'settings/get', input: undefined })
          return settings()
        },
        update: async (input: { boucle?: Partial<Boucle> }) => {
          calls.push({ path: 'settings/update', input })
          current = { ...current, ...(input.boucle ?? {}) }
          return settings()
        },
      },
      rooms: {
        list: async () => [
          { id: 'track-1', name: 'Track #1' },
          { id: 'track-2', name: 'Track #2' },
          { id: 'hands-on', name: 'Hands on' },
        ],
      },
      boucle: {
        // The hub's theme packages: one, not worn (the default theme is).
        themes: async () => [ANCIEN],
        gitSource: async () => null,
        removeTheme: async (input: { sha: string }) => {
          calls.push({ path: 'boucle/removeTheme', input })
          return { ok: true }
        },
        catalogue: async () => {
          calls.push({ path: 'boucle/catalogue', input: undefined })
          return { sponsors: [APE, ZEPHYRA], pagesParDefaut: DEFAULT_PAGES }
        },
        previews: async (input: { refs: string[] }) => {
          calls.push({ path: 'boucle/previews', input })
          return Object.fromEntries(input.refs.map((ref) => [ref, null]))
        },
        uploadImage: async (input: { contentType: string; base64: string }) => {
          calls.push({ path: 'boucle/uploadImage', input })
          return { ref: `hub-image:${'c'.repeat(64)}.svg`, preview: '/assets/deposee' }
        },
      },
    },
  }
  return { calls, client }
}

async function mountView(boucle?: Boucle) {
  const fake = stub(boucle)
  useSessionStore().client = fake.client as never
  const wrapper = mount(BoucleView, { attachTo: document.body })
  await useBoucleStore().load()
  await flushPromises()
  return { calls: fake.calls, wrapper }
}

const updates = (calls: Call[]) =>
  calls.filter((call) => call.path === 'settings/update').map((call) => (call.input as { boucle: Partial<Boucle> }).boucle)

beforeEach(() => {
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})

describe('saving one panel', () => {
  it('sends only the durations that differ from the reference', async () => {
    const { calls, wrapper } = await mountView()
    const sponsors = wrapper.find('#boucle-duree-sponsors')
    expect(sponsors.attributes('placeholder')).toBe('8')
    await sponsors.setValue('12')
    await wrapper.find('#boucle-duree-accueil').setValue('10')
    await wrapper.find('#btn-boucle-durees').trigger('click')
    await flushPromises()
    // Ten is the welcome's own duration: sending it would pin it.
    expect(updates(calls)).toEqual([{ durees: { sponsors: 12 } }])
  })

  it('refuses a duration the hub would refuse', async () => {
    const { calls, wrapper } = await mountView()
    await wrapper.find('#boucle-duree-wallsio').setValue('1')
    await wrapper.find('#btn-boucle-durees').trigger('click')
    await flushPromises()
    expect(updates(calls)).toEqual([])
  })

  it('creates a public link to the preview, and takes it back', async () => {
    const { calls, wrapper } = await mountView()
    await wrapper.find('#btn-boucle-lien-creer').trigger('click')
    await flushPromises()
    const key = updates(calls)[0]!.lienPublic!
    expect(key).toMatch(/^[A-Za-z0-9_-]{24,64}$/)
    expect((wrapper.find('#boucle-lien-public').element as HTMLInputElement).value).toContain(`/boucle/apercu?cle=${key}`)
    await wrapper.find('#btn-boucle-lien-desactiver').trigger('click')
    await flushPromises()
    expect(updates(calls)[1]).toEqual({ lienPublic: null })
  })

  it('keeps only the other rooms\' schedules that differ from the default', async () => {
    const { calls, wrapper } = await mountView()
    await flushPromises()
    await wrapper.find('#boucle-planning-hands-on-afficher').setValue(false)
    const duree = wrapper.find('#boucle-planning-track-2-duree')
    await duree.setValue('30')
    await duree.trigger('change')
    await wrapper.find('#btn-boucle-plannings').trigger('click')
    await flushPromises()
    expect(updates(calls)).toEqual([
      { plannings: { 'hands-on': { afficher: false, duree: 15 }, 'track-2': { afficher: true, duree: 30 } } },
    ])
  })

  it('sends its own section and nothing else', async () => {
    const { calls, wrapper } = await mountView()

    await wrapper.get('#boucle-message-silence').setValue('Chut !')
    await wrapper.get('#btn-boucle-messages').trigger('click')
    await flushPromises()

    const [patch] = updates(calls)
    expect(Object.keys(patch!)).toEqual(['messages'])
    expect(patch!.messages?.silence.texte).toBe('Chut !')
    expect(patch!.messages?.bienvenue).toEqual(DEFAULT_BOUCLE.messages.bienvenue)
  })

  it('sends the sections of the identity panel together', async () => {
    const { calls, wrapper } = await mountView()

    await wrapper.get('#boucle-logo-avec-nom').setValue(true)
    await wrapper.get('#boucle-signature-on').setValue(false)
    await wrapper.get('#boucle-barre-hashtag').setValue('#CN27')
    await wrapper.get('#btn-boucle-identite').trigger('click')
    await flushPromises()

    const [patch] = updates(calls)
    expect(Object.keys(patch!).sort()).toEqual(['accueil', 'barreBas', 'logo', 'logoAvecNom', 'signature'])
    expect(patch!.logoAvecNom).toBe(true)
    expect(patch!.signature).toBeNull()
    expect(patch!.barreBas?.hashtag).toBe('#CN27')
  })

  it('sends no address rather than an empty one', async () => {
    const { calls, wrapper } = await mountView()

    await wrapper.get('#btn-boucle-conduite').trigger('click')
    await flushPromises()

    expect(updates(calls)[0]!.conduite?.url).toBeNull()
    expect(wrapper.find('[data-role="qr-hidden"]').exists()).toBe(true)
  })

  it('shows the derived feedback address without pinning it', async () => {
    const { wrapper } = await mountView()

    const field = wrapper.get('#boucle-feedbacks-url').element as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('https://openfeedback.io/cloud-nord-2026')
  })
})

describe('a panel being edited', () => {
  it('is not redrawn by the refresh', async () => {
    const { wrapper } = await mountView()

    await wrapper.get('#boucle-merci-texte').setValue('Merci à\ntous')
    expect(wrapper.find('#boucle-merci [data-role="dirty"]').exists()).toBe(true)

    await useBoucleStore().load()
    await flushPromises()

    expect((wrapper.get('#boucle-merci-texte').element as HTMLTextAreaElement).value).toBe('Merci à\ntous')
  })

  it('follows the hub again once saved', async () => {
    const { wrapper } = await mountView()

    await wrapper.get('#boucle-merci-texte').setValue('Merci !')
    await wrapper.get('#btn-boucle-merci').trigger('click')
    await flushPromises()

    expect(wrapper.find('#boucle-merci [data-role="dirty"]').exists()).toBe(false)
  })
})

describe('the sponsor pages', () => {
  it('start automatic, then copy the automatic layout to be corrected', async () => {
    const { calls, wrapper } = await mountView()

    expect(wrapper.get('#boucle-pages').text()).toContain('Automatique (une page par palier)')
    await wrapper.get('#btn-boucle-personnaliser').trigger('click')
    expect(wrapper.findAll('[data-role="sponsor-page"]')).toHaveLength(1)

    await wrapper.get('#boucle-page-0-titre').setValue('Nos\npartenaires')
    await wrapper.get('#btn-boucle-pages').trigger('click')
    await flushPromises()

    const [patch] = updates(calls)
    expect(Object.keys(patch!)).toEqual(['sponsorPages'])
    expect(patch!.sponsorPages).toEqual([{ ...DEFAULT_PAGES[0], titre: 'Nos\npartenaires' }])
  })

  it('go back to automatic with a null', async () => {
    const { calls, wrapper } = await mountView({ ...DEFAULT_BOUCLE, sponsorPages: DEFAULT_PAGES })

    await wrapper.get('#btn-boucle-automatique').trigger('click')
    await wrapper.get('#btn-boucle-pages').trigger('click')
    await flushPromises()

    expect(updates(calls)).toEqual([{ sponsorPages: null }])
    expect(wrapper.find('[data-role="automatic"]').exists()).toBe(true)
  })

  it('moves a logo within its row', async () => {
    const { calls, wrapper } = await mountView({ ...DEFAULT_BOUCLE, sponsorPages: DEFAULT_PAGES })

    const firstLogo = wrapper.get('[data-sponsor-picker="boucle-page-0-rang-0-logo-0"]').element.parentElement!
    ;(firstLogo.querySelector('[data-action="down"]') as HTMLButtonElement).click()
    await flushPromises()
    await wrapper.get('#btn-boucle-pages').trigger('click')
    await flushPromises()
    expect(updates(calls)[0]!.sponsorPages![0]!.rangs[0]!.logos.map((logo) => logo.sponsor)).toEqual([ZEPHYRA.key, APE.key])
  })

  it('flag a logo the program does not know', async () => {
    const pages = [
      {
        duree: null,
        titre: '',
        rangs: [
          {
            taille: 1,
            logos: [
              // By name, as the default announcement names it: recognised.
              { sponsor: 'NOVA Atelier', nom: null, logo: null, echelle: 0.7 },
              { sponsor: 'MTG', nom: null, logo: null, echelle: 0.7 },
            ],
          },
        ],
      },
    ]
    const { wrapper } = await mountView({ ...DEFAULT_BOUCLE, sponsorPages: pages })

    const badge = (index: number) =>
      wrapper.get(`[data-sponsor-picker="boucle-page-0-rang-0-logo-${index}"]`).find('[data-role="missing-sponsor"]')
    expect(badge(0).exists()).toBe(false)
    expect(badge(1).exists()).toBe(true)
    expect(badge(1).text()).toBe('absent du programme')
  })

  it('flag a program sponsor no page holds, and add it to its tier\'s page', async () => {
    const onlyApe = [{ ...DEFAULT_PAGES[0]!, rangs: [{ taille: 1, logos: [DEFAULT_PAGES[0]!.rangs[0]!.logos[0]!] }] }]
    const { calls, wrapper } = await mountView({ ...DEFAULT_BOUCLE, sponsorPages: onlyApe })

    const absent = wrapper.get('[data-role="absent-sponsors"]')
    expect(absent.findAll('[data-absent]').map((item) => item.attributes('data-absent'))).toEqual([ZEPHYRA.key])
    await absent.get('[data-action="add-absent"]').trigger('click')
    expect(wrapper.find('[data-role="absent-sponsors"]').exists()).toBe(false)

    await wrapper.get('#btn-boucle-pages').trigger('click')
    await flushPromises()
    expect(updates(calls)[0]!.sponsorPages).toEqual(DEFAULT_PAGES)
  })

  it('say nothing of absent sponsors while automatic', async () => {
    const { wrapper } = await mountView()
    expect(wrapper.find('[data-role="absent-sponsors"]').exists()).toBe(false)
  })

  it('refuse to save a logo with no sponsor', async () => {
    const { calls, wrapper } = await mountView({ ...DEFAULT_BOUCLE, sponsorPages: DEFAULT_PAGES })

    await wrapper.get('[data-action="add-logo"]').trigger('click')
    await wrapper.get('#btn-boucle-pages').trigger('click')
    await flushPromises()

    expect(updates(calls)).toEqual([])
  })
})

describe('placing an absent sponsor', () => {
  const LIMITS = { pages: 8, rows: 4, logos: 12 }
  const logo = (sponsor: string) => ({ sponsor, nom: null, logo: null, echelle: 0.8 })
  const SILVER = { key: 'https://silver.test', name: 'Silver Co', website: null, logoPreview: null, tiers: ['Silver'] }
  const defaults = [
    DEFAULT_PAGES[0]!,
    { titre: 'Silver', duree: null, rangs: [{ taille: 1, logos: [{ ...logo(SILVER.key), echelle: 0.6 }] }] },
  ]

  it('is found by name too, like the rooms find it', () => {
    expect(absentSponsors([{ ...DEFAULT_PAGES[0]!, rangs: [{ taille: 1, logos: [logo('nova atelier')] }] }], [APE, ZEPHYRA]))
      .toEqual([ZEPHYRA])
  })

  it('opens a new row past four logos', () => {
    const pages = [{ titre: '', duree: null, rangs: [{ taille: 1.2, logos: ['a', 'b', 'c', 'd'].map(logo) }] }]
    expect(placeSponsor(pages, ZEPHYRA, defaults, LIMITS)).toBe(0)
    expect(pages[0]!.rangs).toHaveLength(2)
    expect(pages[0]!.rangs[1]).toEqual({ taille: 1.2, logos: [logo(ZEPHYRA.key)] })
  })

  it('adds its tier\'s page when the layout has none, with the automatic circle', () => {
    const pages = [DEFAULT_PAGES[0]!]
    expect(placeSponsor(pages, SILVER, defaults, LIMITS)).toBe(1)
    expect(pages[1]).toEqual({ titre: 'Silver', duree: null, rangs: [{ taille: 1, logos: [{ ...logo(SILVER.key), echelle: 0.6 }] }] })
    expect(placeSponsor([DEFAULT_PAGES[0]!], SILVER, defaults, { ...LIMITS, pages: 1 })).toBeNull()
  })
})

describe('matching a sponsor', () => {
  it('by key, then by name, whatever the accents and the case', () => {
    const catalogue = [APE, ZEPHYRA]
    const ref = (sponsor: string) => ({ sponsor, nom: null, logo: null, echelle: 0.7 })
    expect(findSponsor(ref(APE.key), catalogue)).toBe(APE)
    expect(findSponsor(ref('nova atelier'), catalogue)).toBe(APE)
    expect(findSponsor(ref('Zéphyra'), catalogue)).toBe(ZEPHYRA)
    expect(findSponsor(ref('MTG'), catalogue)).toBeNull()
  })
})

describe('removing a theme', () => {
  it('asks first, then removes it once confirmed', async () => {
    const { calls, wrapper } = await mountView()
    await wrapper.get('[data-theme="ancien"] button').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('Supprimer le thème « Ancien thème » ?')
    expect(calls.filter((call) => call.path === 'boucle/removeTheme')).toHaveLength(0)

    const confirm = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Supprimer') && button.title === '')
    confirm!.click()
    await flushPromises()
    expect(calls.filter((call) => call.path === 'boucle/removeTheme')).toEqual([
      { path: 'boucle/removeTheme', input: { sha: ANCIEN.sha } },
    ])
  })
})

describe('uploading an image', () => {
  it('sends the file, then holds the reference the hub gave', async () => {
    const { calls, wrapper } = await mountView()

    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'
    const input = wrapper.get('[data-upload="boucle-logo"]')
    Object.defineProperty(input.element, 'files', {
      value: [new File([svg], 'logo.svg', { type: 'image/svg+xml' })],
    })
    await input.trigger('change')
    await flushPromises()

    const upload = calls.find((call) => call.path === 'boucle/uploadImage')
    // An SVG travels as is: it has no pixels to reduce.
    expect(upload?.input).toEqual({ contentType: 'image/svg+xml', base64: btoa(svg) })
    expect(wrapper.get('[data-image-field="boucle-logo"] img').attributes('src')).toBe('/assets/deposee')

    await wrapper.get('#btn-boucle-identite').trigger('click')
    await flushPromises()
    expect(updates(calls)[0]!.logo).toBe(`hub-image:${'c'.repeat(64)}.svg`)
  })

  it('refuses a format the rooms cannot show, before sending', async () => {
    await expect(prepareImage(new File(['%PDF'], 'logo.pdf', { type: 'application/pdf' }))).rejects.toBeInstanceOf(
      ImageRefused,
    )
  })
})
