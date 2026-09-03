import type { VisibleConfig, ObsState } from '@cloudnord/contract'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
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

const CONFIG: VisibleConfig = {
  // Poste installé : c'est lui qui sait ouvrir un sélecteur.
  canBrowse: true,
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
  promptRecordingOnStop: true,
  sceneOnStart: 'LIVE',
}

interface Envoi {
  body: unknown
}

let envois: Envoi[]
let refuse: boolean
/** Ce que le poste répond, quand le geste rapporte quelque chose. */
let reponse: { ok: boolean; detail?: unknown } | null

function salle(overrides: Partial<VisibleConfig> = {}) {
  const etat = payload()
  etat.diagnostics!.config = { ...CONFIG, ...overrides }
  useRoomStore().seed(etat)
  return etat
}

beforeEach(() => {
  setActivePinia(createPinia())
  envois = []
  refuse = false
  reponse = null
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    envois.push({ body: JSON.parse(String(init?.body)) })
    const corps = reponse ?? { ok: !refuse, message: refuse ? 'Refusé' : 'Fait' }
    return new Response(JSON.stringify(corps), {
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
    useRoomStore().payload!.diagnostics!.config = { ...CONFIG, fileSlug: 'other' }

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
    expect(config.notice).toEqual({ text: 'Refusé', tone: 'alert' })
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
  function bloc(obs: Partial<ObsState>, config: VisibleConfig = CONFIG) {
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
    await sans.get('[data-role="btn-screens"]').trigger('click')
    expect(sans.text()).not.toContain('Mur public')

    const avec = mount(ScreensMenu, {
      props: { payload: payload({ wall: { url: 'https://mur.example', qrSvg: '' } }) },
    })
    await avec.get('[data-role="btn-screens"]').trigger('click')

    // Un lien mort dans cette liste enverrait chercher une panne de réseau là
    // où il n'y a qu'un réglage absent.
    expect(avec.text()).toContain('https://mur.example')
  })

  it('ouvre chaque écran dans un autre onglet', async () => {
    const wrapper = mount(ScreensMenu, { props: { payload: payload() } })
    await wrapper.get('[data-role="btn-screens"]').trigger('click')

    // Ouvrir la projection dans la fenêtre de régie remplacerait les commandes
    // par l'écran de salle, en pleine intervention.
    for (const lien of wrapper.findAll('a')) expect(lien.attributes('target')).toBe('_blank')
  })
})

/**
 * Le dossier des VOD, choisi plutôt que retapé.
 *
 * Un chemin de disque se saisit à la main sans erreur seulement quand on l'a
 * sous les yeux — et c'est justement le disque de la **machine de salle** qu'il
 * désigne, pas celui d'où l'on regarde la page.
 */
describe('choisir le dossier des VOD', () => {
  function ouvrir(overrides: Partial<VisibleConfig> = {}) {
    salle(overrides)
    const config = useConfigStore()
    config.show()
    return config
  }

  it('remplit le champ avec ce que le poste a choisi', async () => {
    reponse = { ok: true, detail: 'D:\\captations\\2026' }
    const config = ouvrir()

    await config.browse()

    expect(envois.at(-1)?.body).toEqual({ action: 'config.chooseFolder' })
    expect(config.draft?.recordingRoot).toBe('D:\\captations\\2026')
  })

  it('n’enregistre rien au passage', async () => {
    reponse = { ok: true, detail: 'D:\\captations\\2026' }
    const config = ouvrir()

    await config.browse()

    /*
     * C'est « Enregistrer » qui décide, comme pour tout le reste du panneau.
     * Un sélecteur qui écrirait dans la foulée ferait d'un coup d'œil dans
     * l'arborescence une modification de la salle.
     */
    expect(envois.map((envoi) => (envoi.body as { action: string }).action)).toEqual([
      'config.chooseFolder',
    ])
  })

  it('laisse le champ tel quel quand on renonce', async () => {
    // Fermer un sélecteur est un geste, pas une panne.
    reponse = { ok: true, detail: null }
    const config = ouvrir({ recordingRoot: 'D:\\déjà\\là' })

    await config.browse()

    expect(config.draft?.recordingRoot).toBe('D:\\déjà\\là')
  })

  it('n’offre pas le geste quand le poste ne sait pas l’ouvrir', () => {
    /*
     * `dev:headless`, ou la régie ouverte depuis un navigateur : il n'y a pas
     * de sélecteur à ouvrir. Un bouton qui ne répond pas vaut moins qu'un champ
     * à remplir à la main — la modale le masque sur cette valeur.
     */
    expect(ouvrir({ canBrowse: false }).canBrowse).toBe(false)
    expect(ouvrir({ canBrowse: true }).canBrowse).toBe(true)
  })
})

/**
 * Ce qui manque pour piloter la salle, et le panneau qui s'ouvre pour le dire.
 *
 * Le verdict est pris sans attendre : l'installation d'une salle se fait avant
 * la première conférence, pas pendant, et une salle mal réglée doit le dire
 * quand quelqu'un est encore devant l'écran. Ce qui se répare tout seul — le
 * poste rebranche OBS toutes les trois secondes — s'efface de la liste, panneau
 * ouvert, sans le refermer sous les doigts.
 */
describe('salle incomplète au démarrage', () => {
  /** Une salle réglée et branchée : le point de départ, qu'on abîme champ par champ. */
  function configuredRoom(
    overrides: Partial<VisibleConfig> = {},
    obs: { A?: ObsState | null; B?: ObsState | null } = {},
  ) {
    const etat = payload()
    etat.diagnostics!.config = {
      ...CONFIG,
      recordingRoot: 'D:\\captations',
      sceneRoles: { A: { LIVE: 'Direct' }, B: {} },
      ...overrides,
    }
    etat.diagnostics!.obs = {
      A: obs.A === undefined ? obsState({ instance: 'A' }) : obs.A,
      B: obs.B === undefined ? obsState({ instance: 'B' }) : obs.B,
    }
    useRoomStore().seed(etat)
    return useConfigStore()
  }

  const codes = (config: ReturnType<typeof useConfigStore>) =>
    config.missing.map((entry) => entry.code)

  it('ne reproche rien à une salle réglée et branchée', () => {
    expect(configuredRoom().missing).toEqual([])
  })

  it('nomme les deux OBS absents et le dossier des VOD', () => {
    const config = configuredRoom({ recordingRoot: null }, { A: null, B: obsState({ connected: false }) })

    expect(codes(config)).toEqual(['obs-A', 'obs-B', 'vod'])
  })

  it('dit l’adresse manquante plutôt que la déconnexion', () => {
    // « Pas connecté » sur une instance dont l'adresse est vide enverrait
    // chercher du côté du réseau.
    const config = configuredRoom(
      { obs: { A: { url: '', hasPassword: false, pending: false }, B: CONFIG.obs.B } },
      { A: null },
    )

    expect(codes(config)).toContain('obs-A-url')
    expect(codes(config)).not.toContain('obs-A')
  })

  it('signale un rôle configuré mais introuvable dans OBS', () => {
    const config = configuredRoom({}, { B: obsState({ unresolvedRoles: ['TALK'] }) })

    expect(config.missing).toEqual([
      { code: 'roles-B', text: 'Rôles introuvables dans OBS-B : TALK.' },
    ])
  })

  it('ne reproche pas à la captation de n’avoir aucun rôle mappé', () => {
    // Beaucoup de salles ne changent jamais de plan pendant un talk : ce serait
    // un faux motif. La projection sans rôle, elle, n'a aucun bouton.
    expect(configuredRoom({ sceneRoles: { A: { LIVE: 'Direct' }, B: {} } }).missing).toEqual([])
    expect(codes(configuredRoom({ sceneRoles: { A: {}, B: {} } }))).toEqual(['scenes-A'])
  })

  it('ouvre le panneau sans attendre sur une salle incomplète', () => {
    const config = configuredRoom({ recordingRoot: null }, { B: obsState({ connected: false }) })

    config.checkAtStartup()

    expect(config.open).toBe(true)
    // Le bandeau dit pourquoi : un panneau qui s'ouvre tout seul se lit comme
    // une fausse manœuvre tant qu'il n'a pas donné sa raison.
    expect(config.openAtStartup).toBe(true)
    expect(codes(config)).toEqual(['obs-B', 'vod'])
  })

  it('n’ouvre rien sur une salle réglée et branchée', () => {
    const config = configuredRoom()

    config.checkAtStartup()

    expect(config.open).toBe(false)
  })

  it('efface de la liste ce que le poste répare tout seul', () => {
    // OBS est souvent lancé après la régie et le poste réessaie sans fin. La
    // ligne s'en va d'elle-même, sans que le panneau se referme sous les doigts.
    const config = configuredRoom({}, { B: obsState({ connected: false }) })
    config.checkAtStartup()
    expect(codes(config)).toEqual(['obs-B'])

    configuredRoom()

    expect(config.missing).toEqual([])
    expect(config.open).toBe(true)
  })

  it('ne rouvre pas le panneau que l’opérateur vient de fermer', () => {
    const config = configuredRoom({ recordingRoot: null })
    config.checkAtStartup()
    expect(config.open).toBe(true)

    config.open = false
    // Une salle sans dossier de VOD reste pilotable pour tout le reste : un
    // panneau qui se rouvre n'est plus un rappel, c'est un obstacle.
    config.checkAtStartup()

    expect(config.open).toBe(false)
  })

  it('juge dès que le hub rend enfin la configuration', async () => {
    const etat = payload()
    etat.diagnostics!.config = null
    useRoomStore().seed(etat)
    const config = useConfigStore()

    config.checkAtStartup()
    // Une salle dont on ne sait rien n'est pas une salle mal réglée.
    expect(config.open).toBe(false)

    configuredRoom({ recordingRoot: null })
    await nextTick()

    expect(config.open).toBe(true)
  })

  it('ne présente pas comme un rappel un panneau ouvert à la main', () => {
    const config = configuredRoom()
    config.show()
    expect(config.openAtStartup).toBe(false)
  })
})
