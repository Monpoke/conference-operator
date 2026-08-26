import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsView from '../src/views/SettingsView.vue'
import { orNull, useSettingsStore } from '../src/stores/settings.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * Les réglages.
 *
 * Six panneaux et une contrainte commune : la vue se rafraîchit toutes les dix
 * secondes, et aucun champ ne doit se réécrire pendant qu'on tape dedans. Rien
 * n'est plus déroutant, et c'est invisible en relecture — d'où le test.
 *
 * Trois autres décisions valent d'être tenues : « vide » n'est pas « absent »,
 * « Réimporter » part de l'URL enregistrée et non de celle à l'écran, et le
 * compte-rendu de resynchronisation donne le nombre de salles atteintes plutôt
 * qu'un « c'est parti » qui serait exact sur un hub vide.
 */

interface Call {
  path: string
  input: unknown
}

const REGLAGES = {
  eventName: null,
  eventShortName: null,
  openFeedbackProjectId: null,
  programSourceUrl: 'https://exemple/programme.json',
  autoEndEnabled: true,
  autoEndGraceMinutes: 5,
  socialLinks: [],
}

const STOCKAGE = {
  endpoint: 's3.exemple',
  bucket: 'rushes',
  prefix: 'cn26',
  configure: true,
  politique: {
    actif: true,
    debitMaxOctetsS: 2048,
    cpuMax: 0.8,
    margeConferenceMinutes: 5,
    taillePartMo: 16,
  },
}

function stub(options: {
  reglages?: Record<string, unknown>
  stockage?: Record<string, unknown> | null
  resyncRooms?: number
  snapshots?: unknown[]
}): { calls: Call[]; client: unknown; reglages: Record<string, unknown> } {
  const calls: Call[] = []
  // Muté par les tests qui simulent un changement venu d'ailleurs — un autre
  // opérateur, un import — entre deux tours de rafraîchissement.
  const reglages: Record<string, unknown> = { ...REGLAGES, ...(options.reglages ?? {}) }
  const note =
    (path: string, result: unknown) =>
    async (input: unknown = undefined) => {
      calls.push({ path, input })
      return result
    }
  return {
    calls,
    reglages,
    client: {
      token: { read: () => 'jeton', write: () => {}, clear: () => {} },
      rpc: {
        settings: {
          // Un objet neuf à chaque appel, comme le ferait un vrai aller-retour
          // RPC. Renvoyer la même référence contournerait la réactivité et
          // ferait passer le test sur un artefact du bouchon.
          get: async (input?: unknown) => {
            calls.push({ path: 'settings/get', input })
            return { ...reglages }
          },
          update: async (input?: unknown) => {
            calls.push({ path: 'settings/update', input })
            return { ...reglages }
          },
        },
        event: {
          identity: note('event/identity', {
            derived: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
          }),
        },
        program: {
          snapshots: note('program/snapshots', options.snapshots ?? []),
          activate: note('program/activate', { ok: true }),
          import: note('program/import', { program: { sessions: [1, 2, 3] } }),
        },
        rooms: {
          list: note('rooms/list', [{ id: 'track-1', name: 'Track #1' }]),
          resync: note('rooms/resync', { rooms: options.resyncRooms ?? 2 }),
        },
        vod: {
          status: note('vod/status', options.stockage === null ? { configure: false, politique: STOCKAGE.politique } : { ...STOCKAGE, ...(options.stockage ?? {}) }),
          check: note('vod/check', { ok: true, etapes: [{ nom: 'joindre', ok: true }] }),
        },
      },
    },
  }
}

async function monter(options: Parameters<typeof stub>[0] = {}): Promise<{
  calls: Call[]
  wrapper: ReturnType<typeof mount>
  reglages: Record<string, unknown>
}> {
  const fake = stub(options)
  useSessionStore().client = fake.client as never
  const wrapper = mount(SettingsView, { attachTo: document.body })
  await useSettingsStore().load()
  await flushPromises()
  return { calls: fake.calls, wrapper, reglages: fake.reglages }
}

beforeEach(() => {
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})

describe('vide contre absent', () => {
  it('rend un champ vidé à la déduction plutôt que de le figer', () => {
    // Sans cette distinction, on ne pourrait plus jamais relâcher le réglage :
    // le nom cesserait de suivre les imports de programme, définitivement.
    expect(orNull('   ')).toBe(null)
    expect(orNull('')).toBe(null)
    expect(orNull(' Cloud Nord ')).toBe('Cloud Nord')
  })
})

describe('vue des réglages', () => {
  it("n'écrase pas un champ pendant qu'on tape dedans", async () => {
    const { wrapper } = await monter()

    const champ = wrapper.get('#event-nom')
    ;(champ.element as HTMLInputElement).focus()
    await champ.setValue('Cloud Nord 2027')

    // Le rafraîchissement de dix secondes passe : le hub répond toujours `null`,
    // et le champ doit rester sur ce que l'opérateur est en train d'écrire.
    await useSettingsStore().load()
    await flushPromises()

    expect((wrapper.get('#event-nom').element as HTMLInputElement).value).toBe('Cloud Nord 2027')
  })

  it('reprend la valeur du hub une fois le champ quitté', async () => {
    const { wrapper, reglages } = await monter()

    // Quitter le champ est exactement le moment où un changement fait ailleurs
    // — un autre opérateur, un import — doit devenir visible.
    ;(wrapper.get('#event-nom').element as HTMLInputElement).blur()
    reglages['eventName'] = 'Renommé ailleurs'
    await useSettingsStore().load()
    await flushPromises()

    expect((wrapper.get('#event-nom').element as HTMLInputElement).value).toBe('Renommé ailleurs')
  })

  it('montre en placeholder ce que le hub déduirait, sans le pré-remplir', async () => {
    const { wrapper } = await monter()

    const champ = wrapper.get('#event-nom').element as HTMLInputElement
    // Pré-rempli, il ferait croire que la valeur est figée — et le premier
    // enregistrement l'aurait effectivement figée.
    expect(champ.value).toBe('')
    expect(champ.placeholder).toBe('Cloud Nord 2026')
  })

  it('bloque « Réimporter » tant que l’URL affichée diffère de l’enregistrée', async () => {
    const { wrapper } = await monter()

    expect(wrapper.get('#btn-reimporter').attributes('disabled')).toBeUndefined()

    await wrapper.get('#url-programme').setValue('https://autre/programme.json')
    await flushPromises()

    // Sinon on tape une adresse, on clique, et le hub relit l'ancienne sans que
    // rien ne le dise.
    expect(wrapper.get('#btn-reimporter').attributes('disabled')).toBeDefined()
  })

  it('réimporte depuis l’URL enregistrée', async () => {
    const { calls, wrapper } = await monter()

    await wrapper.get('#btn-reimporter').trigger('click')
    await flushPromises()

    expect(calls).toContainEqual({
      path: 'program/import',
      input: { sourceUrl: 'https://exemple/programme.json' },
    })
  })

  it('écarte les lignes de réseaux laissées vides', async () => {
    const { calls, wrapper } = await monter()

    await wrapper.get('#btn-reseau-ajouter').trigger('click')
    await flushPromises()
    await wrapper.get('#btn-reseaux').trigger('click')
    await flushPromises()

    // Ajouter une ligne puis se raviser est un geste normal, et le hub
    // refuserait une URL vide.
    const envoi = calls.find((appel) => appel.path === 'settings/update')
    expect((envoi?.input as { socialLinks: unknown[] }).socialLinks).toEqual([])
  })

  it('convertit le débit affiché en Ko/s vers des octets', async () => {
    const { calls, wrapper } = await monter()

    await wrapper.get('#vod-debit').setValue('512')
    await wrapper.get('#btn-vod-reglages').trigger('click')
    await flushPromises()

    const envoi = calls.find((appel) => appel.path === 'settings/update')
    expect((envoi?.input as { vodPolitique: { debitMaxOctetsS: number } }).vodPolitique.debitMaxOctetsS)
      .toBe(512 * 1024)
  })

  it("n'offre pas d'éprouver un stockage dont le hub n'a pas les clés", async () => {
    const { wrapper } = await monter({ stockage: null })

    // Sans clés il n'y a rien à éprouver, et le panneau le dit déjà en haut.
    expect(wrapper.get('#btn-vod-eprouver').attributes('disabled')).toBeDefined()
    expect(wrapper.get('#vod-etat').text()).toContain('Aucun stockage S3 configuré')
  })

  it('distingue « clés posées, bucket manquant » des deux autres cas', async () => {
    const { wrapper } = await monter({ stockage: { configure: false } })

    // Le cas le plus déroutant des trois : la page est ouverte, les clés sont
    // là, et rien ne part parce qu'il manque un nom de bucket.
    expect(wrapper.get('#vod-etat').text()).toContain('aucun bucket')
  })

  it('demande confirmation avant de resynchroniser, et dit ce qui va partir', async () => {
    const { calls, wrapper } = await monter()

    await wrapper.get('#btn-resync').trigger('click')
    await flushPromises()

    expect(document.querySelector('#resync-texte')?.textContent).toContain('toutes les salles')
    expect(calls.filter((appel) => appel.path === 'rooms/resync')).toHaveLength(0)
  })

  it('dit combien de salles la demande a atteintes, pas qu’elle est partie', async () => {
    const { calls, wrapper } = await monter({ resyncRooms: 0 })

    await wrapper.get('#btn-resync').trigger('click')
    await flushPromises()
    ;(document.querySelector('#resync-texte')!
      .closest('[role="alertdialog"]')!
      .querySelectorAll('button')[1] as HTMLButtonElement).click()
    await flushPromises()

    // Un hub sans aucune salle appairée accepte la demande sans que rien ne
    // parte : « demandé » serait alors exact et trompeur.
    expect(calls).toContainEqual({ path: 'rooms/resync', input: { roomId: null } })
  })
})
