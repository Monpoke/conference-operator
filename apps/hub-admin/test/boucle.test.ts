import { DEFAULT_BOUCLE, type Boucle } from '@conference-operator/contract'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import BoucleView from '../src/views/BoucleView.vue'
import { ImageRefused, findSponsor, prepareImage, useBoucleStore } from '../src/stores/boucle.js'
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

const APE = { key: 'https://apefactory.fr', name: 'APE Factory', website: 'https://apefactory.fr', logoPreview: '/assets/ape', tiers: ['Gold', 'Silver'] }
const ZENIKA = { key: 'https://zenika.com', name: 'Zenika', website: 'https://zenika.com', logoPreview: null, tiers: ['Gold'] }
const DEFAULT_PAGES = [
  {
    titre: '',
    duree: null,
    rangs: [
      {
        taille: 1,
        logos: [
          { sponsor: APE.key, nom: null, logo: null, echelle: 0.8 },
          { sponsor: ZENIKA.key, nom: null, logo: null, echelle: 0.8 },
        ],
      },
    ],
  },
]

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
        catalogue: async () => {
          calls.push({ path: 'boucle/catalogue', input: undefined })
          return { sponsors: [APE, ZENIKA], pagesParDefaut: DEFAULT_PAGES }
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

  it('sends the four sections of the identity panel together', async () => {
    const { calls, wrapper } = await mountView()

    await wrapper.get('#boucle-signature-on').setValue(false)
    await wrapper.get('#boucle-barre-hashtag').setValue('#CN27')
    await wrapper.get('#btn-boucle-identite').trigger('click')
    await flushPromises()

    const [patch] = updates(calls)
    expect(Object.keys(patch!).sort()).toEqual(['accueil', 'barreBas', 'logo', 'signature'])
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
    expect(updates(calls)[0]!.sponsorPages![0]!.rangs[0]!.logos.map((logo) => logo.sponsor)).toEqual([ZENIKA.key, APE.key])
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
              { sponsor: 'APE Factory', nom: null, logo: null, echelle: 0.7 },
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

  it('refuse to save a logo with no sponsor', async () => {
    const { calls, wrapper } = await mountView({ ...DEFAULT_BOUCLE, sponsorPages: DEFAULT_PAGES })

    await wrapper.get('[data-action="add-logo"]').trigger('click')
    await wrapper.get('#btn-boucle-pages').trigger('click')
    await flushPromises()

    expect(updates(calls)).toEqual([])
  })
})

describe('matching a sponsor', () => {
  it('by key, then by name, whatever the accents and the case', () => {
    const catalogue = [APE, ZENIKA]
    const ref = (sponsor: string) => ({ sponsor, nom: null, logo: null, echelle: 0.7 })
    expect(findSponsor(ref(APE.key), catalogue)).toBe(APE)
    expect(findSponsor(ref('ape factory'), catalogue)).toBe(APE)
    expect(findSponsor(ref('Zénika'), catalogue)).toBe(ZENIKA)
    expect(findSponsor(ref('MTG'), catalogue)).toBeNull()
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
