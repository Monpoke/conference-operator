import type { ConfigVisible, ObsState } from '@cloudnord/contract'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ObsConfigBlock from '../src/components/ObsConfigBlock.vue'
import ScreensMenu from '../src/components/ScreensMenu.vue'
import { useConfigStore } from '../src/stores/config.js'
import { useRoomStore } from '../src/stores/room.js'
import { obsState, payload } from './fixtures.js'

/**
 * La configuration de la salle, saisie sur un brouillon.
 *
 * Le formulaire est peuplé à l'ouverture et jamais à chaque état reçu : la
 * régie en reçoit un toutes les quelques secondes, et repeupler les champs sous
 * les doigts effacerait la saisie en cours.
 */

const CONFIG: ConfigVisible = {
  obs: {
    A: { url: 'ws://127.0.0.1:4455', hasPassword: true, pending: false },
    B: { url: 'ws://127.0.0.1:4456', hasPassword: false, pending: false },
  },
  sceneRoles: { A: { LIVE: 'Direct', TALK: 'Plan large' }, B: {} },
  displayPort: 7788,
  recordingRoot: null,
  fileSlug: null,
  relaySourceRoomId: null,
  openFeedbackProjectId: null,
  promptRecordingOnStart: true,
  sceneOnStart: 'LIVE',
}

interface Envoi {
  body: unknown
}

let envois: Envoi[]
let refuse: boolean

function salle(overrides: Partial<ConfigVisible> = {}) {
  const etat = payload()
  etat.diagnostics!.config = { ...CONFIG, ...overrides }
  useRoomStore().seed(etat)
  return etat
}

beforeEach(() => {
  setActivePinia(createPinia())
  envois = []
  refuse = false
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    envois.push({ body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({ ok: !refuse, message: refuse ? 'Refusé' : 'Fait' }), {
      headers: { 'content-type': 'application/json' },
    })
  })
})

describe('brouillon', () => {
  it('se peuple à l’ouverture, pas à chaque état reçu', () => {
    salle()
    const config = useConfigStore()
    config.show()

    config.draft!.fileSlug = 'track-1'
    // Un nouvel état arrive : la régie en reçoit un toutes les quelques
    // secondes, et repeupler effacerait la saisie en cours.
    useRoomStore().payload!.diagnostics!.config = { ...CONFIG, fileSlug: 'autre' }

    expect(config.draft?.fileSlug).toBe('track-1')
  })

  it('ne propose rien à configurer tant que le hub n’a pas répondu', () => {
    const etat = payload()
    etat.diagnostics!.config = null
    useRoomStore().seed(etat)
    const config = useConfigStore()

    config.show()

    // Un formulaire vide se remplirait de zéros et les enverrait.
    expect(config.draft).toBe(null)
    expect(config.patch()).toBe(null)
  })
})

describe('ce que le formulaire envoie', () => {
  it('ne renvoie pas un mot de passe qu’il n’a jamais eu', () => {
    salle()
    const config = useConfigStore()
    config.show()

    const patch = config.patch() as { obs: { A: Record<string, unknown> } }

    // Champ vide vaut « inchangé » : la page n'a jamais eu le mot de passe,
    // elle ne peut pas le renvoyer pour le conserver.
    expect(patch.obs.A).toEqual({ url: 'ws://127.0.0.1:4455' })
  })

  it('sait retirer un mot de passe, ce qu’un champ vide ne dit pas', () => {
    salle()
    const config = useConfigStore()
    config.show()
    config.draft!.obs.A.clearPassword = true

    expect((config.patch() as { obs: { A: { password: unknown } } }).obs.A.password).toBe(null)
  })

  it('garde un rôle mappé hors des trois proposés pour l’instance', () => {
    salle()
    const config = useConfigStore()
    config.show()
    config.draft!.sceneRoles.A.LIVE = 'Antenne'

    /*
     * `TALK` sur OBS-A : les trois rôles offerts par instance sont une
     * convention du formulaire, pas une contrainte du modèle — la carte accepte
     * n'importe lequel des six des deux côtés. Le brouillon repart de
     * l'existant, sinon ouvrir la modale et enregistrer suffirait à perdre un
     * réglage qu'on n'a pas touché.
     */
    const patch = config.patch() as { sceneRoles: { A: Record<string, string> } }
    expect(patch.sceneRoles.A).toEqual({ LIVE: 'Antenne', TALK: 'Plan large' })
  })

  it('efface un rôle qu’on remet à « non configuré »', () => {
    salle()
    const config = useConfigStore()
    config.show()
    config.draft!.sceneRoles.A.LIVE = ''

    expect((config.patch() as { sceneRoles: { A: Record<string, string> } }).sceneRoles.A).toEqual({
      TALK: 'Plan large',
    })
  })

  it('retombe sur le port existant plutôt que sur zéro', () => {
    salle()
    const config = useConfigStore()
    config.show()
    config.draft!.displayPort = 'sept-mille'

    // `Number('sept-mille')` vaut NaN : l'envoyer couperait l'écran local au
    // prochain démarrage, sans rien à l'écran pour dire pourquoi.
    expect((config.patch() as { displayPort: number }).displayPort).toBe(7788)
  })

  it('rend nuls les champs texte laissés vides', () => {
    salle({ fileSlug: 'track-1', recordingRoot: '/rushes' })
    const config = useConfigStore()
    config.show()
    config.draft!.fileSlug = '   '
    config.draft!.recordingRoot = ''

    const patch = config.patch() as { fileSlug: unknown; recordingRoot: unknown }
    expect(patch.fileSlug).toBe(null)
    expect(patch.recordingRoot).toBe(null)
  })
})

describe('enregistrer', () => {
  it('repeuple sur ce que le hub a retenu, pas sur ce qu’on a tapé', async () => {
    salle()
    const config = useConfigStore()
    config.show()
    config.draft!.fileSlug = 'saisi'

    await config.save()
    await flushPromises()

    // C'est la seule façon de voir ce qui a réellement été retenu : le hub
    // normalise, et un champ refusé resterait à l'écran comme s'il tenait.
    expect(config.draft?.fileSlug).toBe('')
    expect(config.notice).toEqual({ text: 'Enregistré.', tone: 'ok' })
  })

  it('garde la saisie quand le hub refuse', async () => {
    salle()
    const config = useConfigStore()
    config.show()
    config.draft!.fileSlug = 'saisi'
    refuse = true

    await config.save()

    expect(config.draft?.fileSlug).toBe('saisi')
    expect(config.notice).toEqual({ text: 'Refusé', tone: 'alerte' })
  })

  it('enregistre avant de connecter, pour ne pas brancher la mauvaise adresse', async () => {
    salle()
    const config = useConfigStore()
    config.show()

    await config.connect('A')

    // Brancher sur l'ancienne adresse pendant que la nouvelle est à l'écran
    // donnerait une connexion réussie sur le mauvais OBS, et rien pour le dire.
    expect(envois.map((envoi) => (envoi.body as { action: string }).action)).toEqual([
      'room.configure',
      'obs.connect',
    ])
  })

  it('ne connecte pas si l’enregistrement échoue', async () => {
    salle()
    const config = useConfigStore()
    config.show()
    refuse = true

    await config.connect('A')

    expect(envois.map((envoi) => (envoi.body as { action: string }).action)).toEqual([
      'room.configure',
    ])
  })

  it('connecte quand même hors ligne, sans passer par le hub', async () => {
    const etat = salle()
    etat.state.connectivity = 'OFFLINE'
    const config = useConfigStore()
    config.show()

    await config.connect('A')

    // La configuration s'enregistre sur le hub ; brancher OBS, non — c'est un
    // geste local, et c'est justement quand le hub manque qu'on en a besoin.
    expect(envois.map((envoi) => (envoi.body as { action: string }).action)).toEqual(['obs.connect'])
  })
})

describe('bloc OBS', () => {
  function bloc(obs: Partial<ObsState>, config: ConfigVisible = CONFIG) {
    salle()
    const store = useConfigStore()
    store.show()
    return mount(ObsConfigBlock, {
      props: {
        instance: 'A',
        title: 'OBS-A — projection',
        draft: store.draft!,
        config,
        obs: obsState(obs),
      },
    })
  }

  it('interdit de reconnecter sous une prise en cours', () => {
    const wrapper = bloc({ connected: true, recording: true, scenes: [], currentSceneName: 'X' })

    // Reconnecter, c'est couper.
    expect(wrapper.get('[data-connect="A"]').attributes('disabled')).toBeDefined()
  })

  it('laisse reconnecter une instance déconnectée qui disait « enregistre »', () => {
    // Son dernier état connu est justement périmé.
    const wrapper = bloc({ connected: false, recording: true, scenes: [] })
    expect(wrapper.get('[data-connect="A"]').attributes('disabled')).toBeUndefined()
  })

  it('dit qu’un réglage enregistré n’est pas encore branché', () => {
    const wrapper = bloc({ connected: true, recording: false, scenes: [], currentSceneName: 'X' }, {
      ...CONFIG,
      obs: { ...CONFIG.obs, A: { ...CONFIG.obs.A, pending: true } },
    })

    // Sans le dire, un réglage juste resterait sans effet sans que personne ne
    // voie pourquoi : enregistrer ne reconnecte pas.
    expect(wrapper.get('[data-etat="A"]').text()).toContain('réglages non appliqués')
  })

  it('garde dans la liste une scène qu’OBS ne connaît pas, dite pour ce qu’elle est', () => {
    const wrapper = bloc({ connected: true, recording: false, scenes: ['Autre'] })

    // C'est même le défaut qu'on vient réparer ici : l'effacer en ouvrant la
    // modale ferait disparaître le réglage fautif sans le montrer.
    expect(wrapper.get('#cfg-role-A-LIVE').text()).toContain("Direct — absente d'OBS")
  })
})

describe('menu des écrans', () => {
  it('n’ajoute le mur public que quand la salle en connaît l’adresse', async () => {
    const sans = mount(ScreensMenu, { props: { payload: payload() } })
    await sans.get('[data-role="btn-ecrans"]').trigger('click')
    expect(sans.text()).not.toContain('Mur public')

    const avec = mount(ScreensMenu, {
      props: { payload: payload({ wall: { url: 'https://mur.example', qrSvg: '' } }) },
    })
    await avec.get('[data-role="btn-ecrans"]').trigger('click')

    // Un lien mort dans cette liste enverrait chercher une panne de réseau là
    // où il n'y a qu'un réglage absent.
    expect(avec.text()).toContain('https://mur.example')
  })

  it('ouvre chaque écran dans un autre onglet', async () => {
    const wrapper = mount(ScreensMenu, { props: { payload: payload() } })
    await wrapper.get('[data-role="btn-ecrans"]').trigger('click')

    // Ouvrir la projection dans la fenêtre de régie remplacerait les commandes
    // par l'écran de salle, en pleine intervention.
    for (const lien of wrapper.findAll('a')) expect(lien.attributes('target')).toBe('_blank')
  })
})
