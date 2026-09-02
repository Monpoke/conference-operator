import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DisplayPayload } from '@cloudnord/contract'
import App from '../src/App.vue'
import PairingVeil from '../src/components/PairingVeil.vue'
import { useRoomStore } from '../src/stores/room.js'
import { payload } from './fixtures.js'

/**
 * L'écran d'une machine qui n'est encore liée à rien.
 *
 * Un état, et pas une modale : rien de ce qu'il recouvre n'est utilisable. Une
 * modale se ferme — sur Échap, sur un clic à côté — et laisserait une régie
 * complète à l'écran, dont chaque bouton échouerait sans dire pourquoi.
 */

const SALLES = [
  { id: 'track-1', name: 'Track #1' },
  { id: 'track-2', name: 'Track #2' },
]

interface Envoi {
  url: string
  body: unknown
}

let envois: Envoi[]
const montees: { unmount: () => void }[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  envois = []
  vi.stubGlobal(
    'EventSource',
    class {
      onopen: unknown = null
      onerror: unknown = null
      onmessage: unknown = null
      addEventListener(): void {}
      close(): void {}
    },
  )
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    envois.push({ url, body: init?.body == null ? null : JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    })
  })
})

afterEach(() => {
  for (const montee of montees.splice(0)) montee.unmount()
})

function veil(pairing: DisplayPayload['pairing']): ReturnType<typeof mount> {
  return mount(PairingVeil, { props: { pairing } })
}

describe('choix de la salle', () => {
  it('propose les salles tant qu’aucun code n’a été demandé', async () => {
    const wrapper = veil({ status: 'idle', rooms: SALLES })

    await wrapper.get('[data-room="track-2"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Quelle salle dessert ce poste ?')
    expect(envois[0]?.body).toEqual({ action: 'pairing.chooseRoom', roomId: 'track-2' })
  })

  it('dit que le hub est injoignable plutôt que d’afficher une liste vide', () => {
    // Une liste vide se lirait comme un événement sans salles.
    expect(veil({ status: 'idle', rooms: [] }).text()).toContain('Hub injoignable')
  })
})

describe('code d’appairage', () => {
  it('montre le code et l’adresse où le saisir', () => {
    const wrapper = veil({
      status: 'waiting',
      userCode: 'ABCD-1234',
      verificationUri: 'https://hub.example/appairage',
      rooms: SALLES,
      requestedRoomId: 'track-1',
    })

    expect(wrapper.get('[data-role="pairing-code"]').text()).toBe('ABCD-1234')
    expect(wrapper.text()).toContain('https://hub.example/appairage')
    // La salle demandée accompagne le code : la console la retrouvera
    // pré-sélectionnée, et l'opérateur doit pouvoir vérifier laquelle.
    expect(wrapper.text()).toContain('Track #1')
  })

  it('ne prétend pas connaître un code qu’il n’a pas', () => {
    // Le champ est **absent**, et non nul : c'est ce que la salle produit, et
    // le typage l'a rappelé — un `null` écrit ici décrivait un état qu'elle
    // n'émet jamais.
    const wrapper = veil({ status: 'waiting', rooms: [] })
    expect(wrapper.find('[data-role="pairing-code"]').exists()).toBe(false)
  })

  it('distingue une machine révoquée d’une machine neuve', () => {
    /*
     * `requestedRoomId` renseigné, parce qu'une machine révoquée en a forcément
     * un : `repair()` efface le jeton, pas la salle desservie, et
     * `pairingState()` la porte toujours. L'omettre décrivait une charge utile
     * que le poste ne produit pas.
     */
    const wrapper = veil({
      status: 'expired',
      userCode: 'ABCD-1234',
      rooms: SALLES,
      requestedRoomId: 'track-1',
    })

    /*
     * Un jeton refusé n'est pas un premier démarrage : le dire évite de croire
     * à une machine neuve alors qu'elle a été révoquée, ou que la base du hub a
     * été recréée.
     */
    expect(wrapper.text()).toContain('doit être réappairée')
  })

  it('reprend le refus du hub tel quel', () => {
    const wrapper = veil({
      status: 'failed',
      userCode: 'ABCD-1234',
      message: 'Salle déjà prise',
      requestedRoomId: 'track-1',
    })
    expect(wrapper.text()).toContain('Salle déjà prise')
  })

  it('redemande la salle à une machine qui n’en a jamais choisi', () => {
    // La borne de la règle : sans salle connue, la question se pose — c'est le
    // premier démarrage, ou un poste redémarré avant d'avoir été appairé.
    const wrapper = veil({ status: 'expired', message: 'Jeton refusé', rooms: SALLES })
    expect(wrapper.text()).toContain('Quelle salle dessert ce poste ?')
  })
})

describe('ce que le voile recouvre', () => {
  async function monter(pairing: DisplayPayload['pairing']): Promise<ReturnType<typeof mount>> {
    const etat = payload()
    etat.pairing = pairing
    useRoomStore().seed(etat)
    const wrapper = mount(App, { attachTo: document.body })
    montees.push(wrapper)
    await flushPromises()
    return wrapper
  }

  it('remplace la régie, au lieu de se poser dessus', async () => {
    const wrapper = await monter({ status: 'waiting', userCode: 'ABCD-1234', rooms: SALLES })

    expect(wrapper.find('[data-role="pairing"]').exists()).toBe(true)
    // Pas de bouton fermer, et rien derrière : chaque commande de la régie
    // échouerait sans dire pourquoi sur une machine liée à rien.
    expect(wrapper.find('#btn-rec').exists()).toBe(false)
  })

  it('se lève dès l’approbation', async () => {
    const wrapper = await monter({ status: 'paired' })

    expect(wrapper.find('[data-role="pairing"]').exists()).toBe(false)
    expect(wrapper.find('#btn-rec').exists()).toBe(true)
  })

  it('ne se pose pas du tout sur une salle déjà liée', async () => {
    const wrapper = await monter(null)
    expect(wrapper.find('[data-role="pairing"]').exists()).toBe(false)
  })

  it('coupe les raccourcis, qui viseraient un OBS que la machine n’a pas', async () => {
    await monter({ status: 'waiting', userCode: 'ABCD-1234', rooms: SALLES })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    await flushPromises()

    /*
     * La page d'origine les gardait vivants derrière le voile — son écouteur
     * était global et le voile n'était qu'un attribut sur le `<body>`. Taper
     * « l » récoltait un échec rouge pour toute réponse.
     */
    expect(envois.filter((envoi) => envoi.url === '/control/action')).toEqual([])
  })
})

/**
 * Ce qui se passe entre deux codes.
 *
 * Un code d'appairage vit deux minutes par défaut. Appairer une salle, puis
 * une seconde, suffit à le laisser mourir avant qu'on n'ait fini : la boucle de
 * supervision en redemande un sous quinze secondes, et c'est prévu. Ce qui ne
 * l'était pas, c'est ce que la régie affiche pendant ce trou — elle repartait
 * demander quelle salle dessert le poste, alors que la réponse était donnée
 * depuis longtemps et qu'elle voyage toujours dans `requestedRoomId`.
 */
describe('entre deux codes', () => {
  it('ne redemande pas la salle après une expiration', () => {
    const wrapper = veil({
      status: 'failed',
      message: "Le code d'appairage a expiré, relancer l'opération",
      rooms: SALLES,
      // Le poste sait très bien quelle salle il dessert : c'est le choix qu'on
      // a fait avant de demander le premier code.
      requestedRoomId: 'track-1',
    })
    montees.push(wrapper)

    expect(wrapper.text()).not.toContain('Quelle salle dessert ce poste ?')
    // Et surtout : aucun bouton de salle à re-cliquer.
    expect(wrapper.find('[data-room="track-2"]').exists()).toBe(false)
  })

  it('dit qu’un nouveau code arrive, plutôt que de laisser un écran muet', () => {
    const wrapper = veil({
      status: 'failed',
      message: "Le code d'appairage a expiré, relancer l'opération",
      rooms: SALLES,
      requestedRoomId: 'track-1',
    })
    montees.push(wrapper)

    // La salle desservie reste nommée, et l'attente est annoncée : sans quoi
    // l'écran ressemble à un appairage cassé alors qu'il se répare seul.
    expect(wrapper.text()).toContain('Track #1')
    expect(wrapper.get('[data-role="pairing-attente"]').text()).toContain('nouveau code')
  })

  it('demande la salle tant qu’aucune n’a été choisie', () => {
    // Le premier démarrage, lui, doit bien poser la question.
    const wrapper = veil({ status: 'idle', rooms: SALLES, requestedRoomId: null })
    montees.push(wrapper)

    expect(wrapper.text()).toContain('Quelle salle dessert ce poste ?')
    expect(wrapper.find('[data-room="track-2"]').exists()).toBe(true)
  })
})
