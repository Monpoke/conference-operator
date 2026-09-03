import type { ControlCommand, ControlRoom, ControlView } from '@cloudnord/contract'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App.vue'
import SalleSelect from '../src/components/SalleSelect.vue'
import VerrouBanner from '../src/components/VerrouBanner.vue'
import { payloadDepuisVue } from '../src/lib/porte.js'
import { usePorteStore } from '../src/stores/porte.js'
import { useRoomStore } from '../src/stores/room.js'
import { useSessionStore } from '../src/stores/session.js'
import { useVerrouStore } from '../src/stores/verrou.js'
import { talk } from './fixtures.js'

/**
 * Les trois écrans de la régie mobile, dans l'ordre où on les traverse.
 *
 * Se connecter, choisir une salle, la piloter — et chacun **remplace** le
 * précédent : un pupitre tenu d'une main n'a pas de place pour deux choses à la
 * fois. Ce que ce fichier tient est ce qu'aucun typage ne dit : que le bon
 * écran est monté au bon moment, et qu'on ne pilote rien tant qu'on n'a pas
 * pris la salle.
 */

const AT = Date.parse('2026-10-30T09:10:00.000Z')

function salle(overrides: Partial<ControlRoom> = {}): ControlRoom {
  return {
    roomId: 'track-1',
    name: 'Track #1',
    conference: 'en-cours',
    connectivity: 'ONLINE',
    lock: null,
    ...overrides,
  }
}

/** L'onglet de test : le même que celui que le store fabriquera. */
const MOI = 'session-de-ce-test'
const AUTRE_ONGLET = 'session-tablette'

function verrouDe(holder: string, holderId = AUTRE_ONGLET): ControlRoom['lock'] {
  return {
    roomId: 'track-1',
    holder,
    holderId,
    heldSince: new Date(AT - 12 * 60_000).toISOString(),
    lastSeenAt: new Date(AT).toISOString(),
    expiresAt: new Date(AT + 30_000).toISOString(),
  }
}

function vue(overrides: Partial<ControlView> = {}): ControlView {
  return {
    roomId: 'track-1',
    roomName: 'Track #1',
    event: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
    timezone: 'Europe/Paris',
    serverTime: new Date(AT).toISOString(),
    simulatedClock: false,
    connectivity: 'ONLINE',
    lastSeenAt: new Date(AT).toISOString(),
    conference: 'en-cours',
    targetSession: talk(),
    targetIsUpcoming: false,
    sessionStates: {},
    sessions: [talk()],
    sceneRole: 'HOLD',
    recording: false,
    streaming: false,
    displayMode: 'loop',
    sceneRoles: ['LIVE', 'HOLD'],
    relaySourceRoomId: null,
    promptRecordingOnStart: true,
    promptRecordingOnStop: true,
    sceneOnStart: 'LIVE',
    lock: null,
    ...overrides,
  }
}

/** Le hub, réduit à ce que ces écrans lui demandent. */
function hubFactice(salles: ControlRoom[], vueRendue: Partial<ControlView> = {}) {
  const appels: string[] = []
  /** Ce que la salle recevrait. Séparé de `appels` : on y lit un geste, pas un tour de liste. */
  const commandes: ControlCommand[] = []
  return {
    appels,
    commandes,
    client: {
      rpc: {
        regie: {
          locks: async () => {
            appels.push('locks')
            return salles
          },
          hold: async ({ force }: { force: boolean }) => {
            appels.push(force ? 'hold:force' : 'hold')
            return verrouDe('regie@cloudnord.fr', MOI)
          },
          release: async () => {
            appels.push('release')
            return { ok: true }
          },
          view: async () => vue(vueRendue),
          command: async ({ action }: { action: ControlCommand }) => {
            commandes.push(action)
            return { ok: true, applied: 'queued' as const }
          },
        },
      },
    } as never,
  }
}

function monterDistante(
  salles: ControlRoom[],
  connecte = true,
  vueRendue: Partial<ControlView> = {},
) {
  const porte = usePorteStore()
  porte.start({ portee: 'distante', roomId: null, salles: [], google: null })
  const session = useSessionStore()
  const hub = hubFactice(salles, vueRendue)
  session.client = hub.client
  session.signedIn = connecte
  session.identity = 'regie@cloudnord.fr'
  return hub
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('EventSource', class {} as never)
  // L'identité de l'onglet : figée pour que « c'est moi » et « c'est un autre »
  // soient décidables dans un test.
  globalThis.sessionStorage.setItem('regie-session', MOI)
  /*
   * Faute de jeton, le store demande au hub s'il reste une session par cookie
   * — un vrai appel, et le seul de ces écrans qui ne passe pas par le client
   * oRPC. Y répondre « personne » vaut mieux que le laisser pendre : happy-dom
   * l'interrompt au démontage, et la trace ressemble à une panne.
   */
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }))
})

afterEach(() => {
  // La porte distante sonde chaque seconde : la laisser ouverte ferait courir
  // un minuteur d'un fichier de test au suivant.
  usePorteStore().fermer()
})

describe('les trois écrans', () => {
  it('demande la connexion avant tout le reste', () => {
    monterDistante([salle()], false)
    const wrapper = mount(App)
    // Pas de liste de salles avant d'être connecté : les noms sont publics,
    // mais leur état et leur verrou ne le sont pas.
    expect(wrapper.find('#connexion').exists()).toBe(true)
    expect(wrapper.find('[data-salle="track-1"]').exists()).toBe(false)
  })

  it('propose les salles avant que le hub ait répondu', async () => {
    const porte = usePorteStore()
    porte.start({
      portee: 'distante',
      roomId: null,
      // Les noms sont posés dans la coquille : une liste vide le temps d'un
      // aller-retour se lirait comme un hub sans programme.
      salles: [{ id: 'track-1', name: 'Track #1' }],
      google: null,
    })
    const session = useSessionStore()
    session.client = hubFactice([]).client
    session.signedIn = true

    const wrapper = mount(SalleSelect)
    expect(wrapper.text()).toContain('Track #1')
  })

  it('nomme qui tient une salle, et depuis quand', async () => {
    monterDistante([salle({ lock: verrouDe('nuit@cloudnord.fr') })])
    const wrapper = mount(SalleSelect)
    await flushPromises()

    // « Occupée » seul enverrait chercher qui, à deux salles de là.
    expect(wrapper.text()).toContain('nuit@cloudnord.fr')
  })

  it('entre sans prendre, même sur une salle tenue', async () => {
    const hub = monterDistante([salle({ lock: verrouDe('nuit@cloudnord.fr') })])
    const wrapper = mount(SalleSelect)
    await flushPromises()

    await wrapper.get('[data-salle="track-1"]').trigger('click')
    await flushPromises()

    /*
     * Une seule décision, au même endroit : le voile de la salle.
     *
     * Prendre depuis la liste obligeait à trancher sur la foi d'une ligne, sans
     * voir ce qui se joue dans la salle — alors que c'est exactement ce qu'on
     * veut regarder avant de retirer ses commandes à quelqu'un.
     */
    expect(hub.appels).not.toContain('hold')
    expect(hub.appels).not.toContain('hold:force')
    expect(usePorteStore().roomId).toBe('track-1')
  })

  it('entre sans prendre une salle libre non plus', async () => {
    const hub = monterDistante([salle()])
    const wrapper = mount(SalleSelect)
    await flushPromises()

    await wrapper.get('[data-salle="track-1"]').trigger('click')
    await flushPromises()

    // Le même chemin pour les deux : une salle libre montre le voile « pas
    // prise », dont le bouton dit « Prendre » et non « Reprendre ».
    expect(hub.appels).not.toContain('hold')
    expect(usePorteStore().roomId).toBe('track-1')
  })
})

/**
 * Le voile de verrou : un état, et surtout pas un bouton dans un coin.
 *
 * Ce qu'il tient est la propriété qui manquait : quand cet onglet ne pilote
 * pas, **rien de ce que la page montre n'est utilisable**. Un petit
 * « Reprendre » en barre laissait « Commencer » et « Enregistrer » actifs en
 * apparence, chacun partant se faire refuser au hub — on appuie d'abord, on lit
 * ensuite, et c'est en plein talk qu'on découvre pourquoi rien ne s'est passé.
 */
describe('le voile de verrou', () => {
  function dansLaSalle(lock: ControlRoom['lock']) {
    const hub = monterDistante([salle({ lock })])
    const porte = usePorteStore()
    porte.roomId = 'track-1'
    porte.verrouCourant = lock
    useRoomStore().seed(payloadDepuisVue(vue({ lock }), Date.now()))
    return hub
  }

  it('se lève quand quelqu’un d’autre tient la salle', () => {
    dansLaSalle(verrouDe('nuit@cloudnord.fr'))
    const wrapper = mount(App)

    const veil = wrapper.get('[data-role="verrou-veil"]')
    expect(veil.text()).toContain('pilotée par quelqu’un d’autre')
    expect(veil.text()).toContain('nuit@cloudnord.fr')
    expect(wrapper.get('[data-role="verrou-reprendre"]').text()).toBe('Reprendre le contrôle')
  })

  it('nomme l’autre onglet plutôt que de s’accuser soi-même', () => {
    /*
     * Le cas qui déroutait : la régie ouverte sur le téléphone puis sur la
     * tablette. Son propre nom affiché comme celui d'un tiers se lit comme une
     * panne — on cherche le second compte, et il n'existe pas.
     */
    dansLaSalle(verrouDe('regie@cloudnord.fr', AUTRE_ONGLET))
    const wrapper = mount(App)

    const veil = wrapper.get('[data-role="verrou-veil"]')
    expect(veil.text()).toContain('Vous pilotez déjà cette salle ailleurs')
    expect(veil.get('[data-role="verrou-veil-detail"]').text()).toContain('votre compte')
  })

  it('se lève aussi quand plus personne ne la tient', () => {
    // Une prise expirée — téléphone verrouillé dans une poche, tunnel — laisse
    // la salle libre. Rien n'est cassé, et le bouton ne dit pas « Reprendre »
    // sur une salle que personne ne tient.
    dansLaSalle(null)
    const wrapper = mount(App)

    expect(wrapper.get('[data-role="verrou-veil"]').text()).toContain('n’est pas prise')
    expect(wrapper.get('[data-role="verrou-reprendre"]').text()).toBe('Prendre le contrôle')
  })

  it('disparaît dès que cet onglet tient la salle', () => {
    dansLaSalle(verrouDe('regie@cloudnord.fr', MOI))
    const wrapper = mount(App)

    expect(wrapper.find('[data-role="verrou-veil"]').exists()).toBe(false)
    // Et les commandes sont là : c'est bien la même page dessous.
    expect(wrapper.find('#btn-conf-demarrer').exists()).toBe(true)
  })

  it('reprend sans reposer la question', async () => {
    const hub = dansLaSalle(verrouDe('nuit@cloudnord.fr'))
    const wrapper = mount(App)

    await wrapper.get('[data-role="verrou-reprendre"]').trigger('click')
    await flushPromises()

    // Le voile *est* la question : la reposer en modale en ferait un clic de
    // réflexe, et c'est exactement ce qu'on retire.
    expect(hub.appels).toContain('hold:force')
  })

  it('laisse revenir au choix des salles', async () => {
    const hub = dansLaSalle(verrouDe('nuit@cloudnord.fr'))
    const wrapper = mount(App)

    await wrapper.get('[data-role="verrou-quitter"]').trigger('click')
    await flushPromises()

    expect(usePorteStore().roomId).toBeNull()
    // On ne rend pas ce qu'on ne tient pas : le badge de la salle appartient à
    // son porteur.
    expect(hub.appels).not.toContain('release')
  })
})

/**
 * L'écran de salle, piloté d'un téléphone.
 *
 * Il passe par le flux de commandes descendant, celui-là même qui porte les
 * bascules de scène : rien de neuf ne relie un téléphone à la machine de salle,
 * et une commande qu'elle rate est rattrapée à sa reconnexion — ou périme.
 *
 * Ce que ce bloc tient est la seule chose qu'aucun typage ne dit : que la
 * grille n'offre pas des modes dont le contenu se choisit ailleurs, et qu'elle
 * décrit la salle plutôt que le clic.
 */
describe("l'écran de salle", () => {
  function dansLaSalle(vueRendue: Partial<ControlView> = {}) {
    const lock = verrouDe('regie@cloudnord.fr', MOI)
    const hub = monterDistante([salle({ lock })], true, vueRendue)
    const porte = usePorteStore()
    porte.roomId = 'track-1'
    porte.verrouCourant = lock
    useRoomStore().seed(payloadDepuisVue(vue({ lock, ...vueRendue }), Date.now()))
    return hub
  }

  it('offre les modes que le hub peut tenir, et pas les deux autres', () => {
    dansLaSalle()
    const wrapper = mount(App)
    const modes = wrapper
      .findAll('[data-command]')
      .map((bouton) => bouton.attributes('data-command'))

    expect(modes).toContain('loop')
    expect(modes).toContain('feedback')
    expect(modes).toContain('wall')
    /*
     * « Message » montre le bandeau saisi dans un panneau qui n'est pas monté
     * ici, « Question choisie » la question retenue dans la modération de la
     * régie de salle. Les offrir donnerait un bouton qui prend l'écran de la
     * salle pour y projeter « Aucune question affichée » devant le public : le
     * geste réussirait, et c'est bien ce qui le rend mauvais.
     */
    expect(modes).not.toContain('message')
    expect(modes).not.toContain('question')
  })

  it('allume ce que la salle affiche, pas ce qu\u2019on a demandé', async () => {
    const hub = dansLaSalle({ displayMode: 'sponsors' })
    const wrapper = mount(App)

    expect(wrapper.get('[data-command="sponsors"]').classes().join(' ')).toContain('bg-brand')

    // Le clic poste, et s'arrête là. Le bouton ne bougera qu'au sondage qui
    // rapportera la bascule — comme en régie de salle, où il attend OBS.
    await wrapper.get('[data-command="programme"]').trigger('click')
    await flushPromises()

    expect(hub.commandes).toEqual([{ type: 'display.set', mode: 'programme' }])
    expect(wrapper.get('[data-command="sponsors"]').classes().join(' ')).toContain('bg-brand')
  })
})

describe('le bandeau de verrou', () => {
  function monterBandeau(lock: ControlRoom['lock']) {
    const hub = monterDistante([salle({ lock })])
    const porte = usePorteStore()
    porte.roomId = 'track-1'
    porte.verrouCourant = lock
    useRoomStore().seed(payloadDepuisVue(vue({ lock }), Date.now()))
    return { hub, wrapper: mount(VerrouBanner, { props: { nowMs: AT } }) }
  }

  it('dit qu’on pilote, quand cet onglet tient la salle', () => {
    const { wrapper } = monterBandeau(verrouDe('regie@cloudnord.fr', MOI))
    expect(wrapper.text()).toContain('Vous pilotez cette salle')
  })

  it('ne porte plus de bouton pour reprendre', () => {
    const { wrapper } = monterBandeau(verrouDe('nuit@cloudnord.fr'))

    // La décision vit dans le voile. Ici, une mention, pour que la ligne ne se
    // contredise pas quand le voile se referme.
    expect(wrapper.get('[data-role="verrou-porteur"]').text()).toContain('Lecture seule')
    expect(wrapper.text()).not.toContain('Reprendre')
  })

  it('ramène au choix des salles en rendant ce qu’on tenait', async () => {
    const { hub, wrapper } = monterBandeau(verrouDe('regie@cloudnord.fr', MOI))
    await wrapper.get('button').trigger('click')
    await flushPromises()

    // Rendre en partant : l'expiration couvrirait le cas, mais trente secondes
    // de salle bloquée pendant qu'un collègue attend se voient.
    expect(hub.appels).toContain('release')
    expect(usePorteStore().roomId).toBeNull()
  })
})
