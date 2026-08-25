/// <reference lib="dom" />
// La lib DOM est déclarée ici seulement : l'ajouter au tsconfig laisserait le
// code serveur appeler `document` sans que rien ne proteste.
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aplatirCouchesHtml } from '@cloudnord/ui'
import { renderAdminPage } from '../src/pages/admin-page.js'

/**
 * Comportement de la console, exécutée dans un vrai DOM.
 *
 * Ces pages n'ont pas d'étape de build : sans ce niveau de test, seule leur
 * syntaxe est vérifiée, et un bouton qui ne réagit pas passe inaperçu jusqu'à
 * ce que quelqu'un clique dessus le jour J.
 */
function monterConsole(options: Parameters<typeof renderAdminPage>[0] = {}): void {
  document.documentElement.innerHTML = aplatirCouchesHtml(renderAdminPage(options))
  // `innerHTML` n'exécute pas les <script> : on les rejoue à la main.
  for (const script of document.querySelectorAll('script:not([type])')) {
    // eslint-disable-next-line no-new-func
    new Function(script.textContent ?? '')()
  }
}

const $ = (id: string) => document.getElementById(id)!

/**
 * Visibilité **effective**, feuille de style comprise.
 *
 * Vérifier l'attribut `hidden` ne suffit pas : la règle du navigateur qui le
 * traduit en `display: none` vient de la feuille user-agent, et la moindre
 * règle d'auteur posant un `display` la bat. C'est ce qui rendait les onglets
 * sans effet alors que l'attribut, lui, changeait bien.
 */
function estVisible(id: string): boolean {
  const element = $(id)
  if (element.hasAttribute('hidden')) {
    const calcule = globalThis.getComputedStyle(element).display
    return calcule !== 'none'
  }
  return true
}

/**
 * Visibilité d'un élément que seule une règle CSS montre ou cache.
 *
 * `estVisible` regarde d'abord l'attribut `hidden` ; les modales, elles, sont
 * pilotées par un attribut sur `body`, et n'en portent jamais.
 */
function affiche(id: string): boolean {
  return globalThis.getComputedStyle($(id)).display !== 'none'
}

beforeEach(() => {
  localStorage.clear()
  // Chaque onglet a son adresse : sans remise à zéro, un test qui change de vue
  // ouvrirait le suivant sur la sienne.
  globalThis.history.replaceState(null, '', '/admin')
  // Session présente : la console s'affiche directement, sans écran de connexion.
  localStorage.setItem('hub-admin', 'jeton-de-test')
  /**
   * Réponse par défaut : une liste vide.
   *
   * Sauf pour les routes qui ne rendent pas de liste — un tableau là où la
   * console attend un objet la fait échouer sur une route sans rapport avec ce
   * qu'un test vérifie, et le message d'erreur atterrit dans l'avis partagé.
   */
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const chemin = String(url).replace('/rpc/', '')
      const json = chemin === 'program/globalBreak' ? null : []
      return new Response(JSON.stringify({ json }), { status: 200 })
    }),
  )
  monterConsole()
})

describe('fond de page', () => {
  it('peint son propre fond, sans compter sur celui du navigateur', () => {
    // Le fond venait d'une règle `body` de l'ancienne feuille. En la
    // remplaçant sans reposer de classes, la console s'est retrouvée sur le
    // blanc par défaut du navigateur — illisible sur un thème sombre.
    const fond = globalThis.getComputedStyle(document.body).backgroundColor
    expect(fond).not.toBe('')
    expect(fond).not.toMatch(/transparent|rgba\(0, 0, 0, 0\)|(^|[^0-9])255, 255, 255/)
  })
})

describe('feuille de style vue par le DOM de test', () => {
  it('les utilitaires Tailwind sont bien chargés', () => {
    // Garde-fou du garde-fou : happy-dom ignore `@layer`, où vit toute la
    // feuille. Sans aplatissement, `getComputedStyle` renverrait du vide et
    // `estVisible` répondrait « visible » pour tout — les tests d'onglets
    // passeraient sans rien vérifier.
    const sonde = document.createElement('div')
    sonde.className = 'flex'
    document.body.append(sonde)
    expect(globalThis.getComputedStyle(sonde).display).toBe('flex')
  })
})

describe('navigation de la console', () => {
  it('affiche l\'exploitation seule par défaut', () => {
    expect(estVisible('vue-exploitation')).toBe(true)
    expect(estVisible('vue-conferences')).toBe(false)
    expect(estVisible('vue-reglages')).toBe(false)
    expect($('nav-exploitation').classList.contains('actif')).toBe(true)
  })

  it('bascule sur les conférences', () => {
    $('nav-conferences').click()

    expect(estVisible('vue-conferences')).toBe(true)
    // Sans la règle qui rend `hidden` prioritaire, l'exploitation resterait
    // affichée sous les conférences et l'onglet semblerait inerte.
    expect(estVisible('vue-exploitation')).toBe(false)
    expect($('nav-conferences').classList.contains('actif')).toBe(true)
    expect($('nav-exploitation').classList.contains('actif')).toBe(false)
  })

  it('bascule sur les réglages', () => {
    $('nav-reglages').click()
    expect(estVisible('vue-reglages')).toBe(true)
    expect(estVisible('vue-conferences')).toBe(false)
    expect($('auto-delai')).toBeTruthy()
  })

  it('revient à l\'exploitation', () => {
    $('nav-reglages').click()
    $('nav-exploitation').click()
    expect(estVisible('vue-exploitation')).toBe(true)
    expect(estVisible('vue-reglages')).toBe(false)
  })

  it('offre un écran dédié à la modération', () => {
    $('nav-moderation').click()
    expect(estVisible('vue-moderation')).toBe(true)
    // Elle ne doit plus encombrer l'écran d'exploitation.
    expect(estVisible('vue-exploitation')).toBe(false)
    expect($('moderation')).toBeTruthy()
  })

  /**
   * Chaque onglet a son adresse.
   *
   * Sans cela, la console vivait entièrement sur `/admin` : rafraîchir la page
   * ramenait à l'exploitation, aucun onglet ne se mettait en favori ni ne
   * s'envoyait à un collègue, et le bouton Retour quittait la console.
   */
  it('inscrit l\'onglet courant dans l\'adresse', () => {
    $('nav-moderation').click()
    expect(globalThis.location.pathname).toBe('/admin/moderation')

    // L'exploitation est la racine : c'est l'adresse qu'on écrit de mémoire.
    $('nav-exploitation').click()
    expect(globalThis.location.pathname).toBe('/admin')
  })

  it('ouvre la vue que porte l\'adresse', () => {
    globalThis.history.replaceState(null, '', '/admin/conferences')
    monterConsole()

    expect(estVisible('vue-conferences')).toBe(true)
    expect(estVisible('vue-exploitation')).toBe(false)
  })

  it('retombe sur l\'exploitation quand l\'adresse ne dit rien', () => {
    // L'historique du navigateur peut porter une vue retirée depuis — un
    // `/admin/developpement` d'après un hub redémarré en production.
    globalThis.history.replaceState(null, '', '/admin/developpement')
    monterConsole()

    expect(estVisible('vue-exploitation')).toBe(true)
  })

  it('suit le bouton Retour du navigateur', () => {
    $('nav-messages').click()
    expect(estVisible('vue-messages')).toBe(true)

    // Le retour ne réécrit pas l'adresse : il la suit.
    globalThis.history.replaceState(null, '', '/admin')
    globalThis.dispatchEvent(new Event('popstate'))

    expect(estVisible('vue-exploitation')).toBe(true)
    expect(estVisible('vue-messages')).toBe(false)
  })

  it('une seule vue à la fois, quel que soit l\'onglet', () => {
    const ONGLETS = ['exploitation', 'appairage', 'conferences', 'moderation', 'messages', 'reglages']
    for (const onglet of ONGLETS) {
      $('nav-' + onglet).click()
      const visibles = ONGLETS.filter((vue) => estVisible('vue-' + vue))
      expect(visibles).toEqual([onglet])
    }
  })

  it('ne charge que la vue affichée', async () => {
    const mock = globalThis.fetch as unknown as { mock: { calls: [string][]; }; mockClear: () => void }
    // Le chargement initial appelle tout : on repart d'une ardoise propre pour
    // n'observer que ce que déclenche la bascule.
    await new Promise((resolve) => setTimeout(resolve, 10))
    mock.mockClear()

    $('nav-reglages').click()
    await new Promise((resolve) => setTimeout(resolve, 10))

    const urls = mock.mock.calls.map((appel) => String(appel[0]))
    // Rafraîchir des panneaux invisibles solliciterait le hub pour rien.
    expect(urls.some((url) => url.includes('settings/get'))).toBe(true)
    expect(urls.some((url) => url.includes('wall/pending'))).toBe(false)
  })
})

/**
 * Mode d'exécution, rendu côté serveur.
 *
 * Servi avec la page plutôt que chargé ensuite : il décrit le hub qui répond,
 * pas un état applicatif, et doit être là même si tout le reste échoue.
 */
describe('mode du hub', () => {
  it('ne dit rien en production', () => {
    monterConsole()

    expect(document.body.textContent).not.toContain('mode dev')
  })

  it('affiche un badge en développement', () => {
    monterConsole({ mode: 'dev' })

    expect(document.body.textContent).toContain('mode dev')
  })

  it('annonce les réglages de développement neutralisés', () => {
    // Quelqu'un croit avoir réglé quelque chose, et ce quelque chose ne
    // s'applique pas : le taire ferait chercher ailleurs pendant des heures.
    monterConsole({
      mode: 'production',
      ignores: [{ variable: 'SIMULATED_TIME', raison: 'réservé au mode développement (MODE=dev)' }],
    })

    const texte = document.body.textContent ?? ''
    expect(texte).toContain('SIMULATED_TIME')
    // La raison accompagne la variable : deux causes possibles, deux
    // corrections différentes.
    expect(texte).toContain('réservé au mode développement')
  })
})

/**
 * Supervision au téléphone.
 *
 * La console se regarde debout, au fond d'une salle : un tableau de sept
 * colonnes y devient illisible, et « qu'est-ce qui se passe » doit tenir dans
 * un écran de 390 px.
 */
/**
 * Appairage.
 *
 * Vue à part : le geste n'a lieu qu'à la mise en route et demande de
 * l'attention — se tromper de salle envoie les commandes au mauvais
 * vidéoprojecteur. Le mêler à la supervision le noyait.
 */
describe('appairage', () => {
  it('a sa propre vue, hors de la supervision', () => {
    monterConsole()

    expect(document.getElementById('vue-appairage')).toBeTruthy()
    // Les panneaux ont bien quitté l'exploitation.
    expect(document.getElementById('vue-exploitation')?.contains(document.getElementById('appairages'))).toBe(false)
  })

  it('tranche sur le code de l\'URL, sans faire chercher dans la file', async () => {
    // Arriver par le lien de la régie et lire une file de demandes ne dit rien
    // de *ce* code-là : il peut être mort pendant que trois autres attendent.
    globalThis.history.replaceState(null, '', '/admin/devices?user_code=HK62AA49')
    localStorage.setItem('hub-admin', 'jeton')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        new Response(
          JSON.stringify({
            json: String(url).endsWith('/devices/lookup')
              ? { status: null, reason: 'expire', clientId: null, requestedRoomId: null, requestedRoomName: null }
              : [],
          }),
          { status: 200 },
        ),
      ),
    )
    monterConsole()
    await vi.waitFor(() => expect($('verdict-titre').textContent).toBe('Code expiré'))

    expect(affiche('verdict-code')).toBe(true)
    // Le code est rappelé : l'opérateur en a souvent deux sous les yeux.
    expect($('verdict-texte').textContent).toContain('HK62AA49')

    ;($('verdict-fermer') as HTMLButtonElement).click()
    expect(affiche('verdict-code')).toBe(false)
    globalThis.history.replaceState(null, '', '/admin')
  })

  it('approuve la machine depuis la modale, salle demandée en tête', async () => {
    /**
     * Le code qu'on tient est là, la machine aussi : renvoyer vers la liste
     * derrière la modale faisait rechercher la bonne ligne pour refaire le
     * geste qu'on venait de valider des yeux.
     */
    globalThis.history.replaceState(null, '', '/admin/devices?user_code=YBFACMQT')
    localStorage.setItem('hub-admin', 'jeton')
    const appels: { chemin: string; entree: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const chemin = String(url).replace('/rpc/', '')
      appels.push({ chemin, entree: JSON.parse(String(init.body)).json })
      const json = chemin === 'devices/lookup'
        ? {
            status: 'pending',
            reason: null,
            clientId: '01M0NGT9NMRNE1986V7XGWHBER',
            requestedRoomId: 'track-2',
            requestedRoomName: 'Track #2',
          }
        : chemin === 'rooms/list'
          ? [{ id: 'track-1', name: 'Track #1' }, { id: 'track-2', name: 'Track #2' }]
          : { ok: true }
      return new Response(JSON.stringify({ json }), { status: 200 })
    }))
    monterConsole()
    await vi.waitFor(() => expect($('verdict-approuver').hidden).toBe(false))

    // La salle demandée est pré-sélectionnée, sans engager : c'est la console
    // qui tranche, et se tromper envoie les commandes au mauvais projecteur.
    expect(($('verdict-salle') as HTMLSelectElement).value).toBe('track-2')

    ;($('verdict-approuver') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(appels.some((appel) => appel.chemin === 'devices/approve')).toBe(true))

    expect(appels.find((appel) => appel.chemin === 'devices/approve')?.entree).toMatchObject({
      userCode: 'YBFACMQT',
      clientId: '01M0NGT9NMRNE1986V7XGWHBER',
      roomId: 'track-2',
    })
    // La modale se referme une fois le geste passé : elle n'a plus rien à dire.
    await vi.waitFor(() => expect(affiche('verdict-code')).toBe(false))
  })

  it('refuse depuis la modale, sans choisir de salle', async () => {
    globalThis.history.replaceState(null, '', '/admin/devices?user_code=YBFACMQT')
    localStorage.setItem('hub-admin', 'jeton')
    const appels: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const chemin = String(url).replace('/rpc/', '')
      appels.push(chemin)
      const json = chemin === 'devices/lookup'
        ? { status: 'pending', reason: null, clientId: '01M0', requestedRoomId: null, requestedRoomName: null }
        : chemin === 'rooms/list' ? [] : { ok: true }
      return new Response(JSON.stringify({ json }), { status: 200 })
    }))
    monterConsole()
    await vi.waitFor(() => expect($('verdict-refuser').hidden).toBe(false))

    ;($('verdict-refuser') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(appels).toContain('devices/deny'))

    expect(appels).not.toContain('devices/approve')
  })

  it('garde la modale ouverte quand le hub refuse le geste', async () => {
    // Un code ouvert par un autre opérateur se refuse à l'approbation : le
    // message tient en une phrase qu'il faut lire, pas en un avis fugace.
    globalThis.history.replaceState(null, '', '/admin/devices?user_code=YBFACMQT')
    localStorage.setItem('hub-admin', 'jeton')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const chemin = String(url).replace('/rpc/', '')
      if (chemin === 'devices/approve') {
        return new Response(JSON.stringify({ json: { message: 'Ce code a été ouvert par un autre opérateur' } }), { status: 403 })
      }
      const json = chemin === 'devices/lookup'
        ? { status: 'pending', reason: null, clientId: '01M0', requestedRoomId: 'track-1', requestedRoomName: 'Track #1' }
        : chemin === 'rooms/list' ? [{ id: 'track-1', name: 'Track #1' }] : { ok: true }
      return new Response(JSON.stringify({ json }), { status: 200 })
    }))
    monterConsole()
    await vi.waitFor(() => expect($('verdict-approuver').hidden).toBe(false))

    ;($('verdict-approuver') as HTMLButtonElement).click()
    await vi.waitFor(() => expect($('verdict-erreur').textContent).toContain('autre opérateur'))

    expect(affiche('verdict-code')).toBe(true)
    // Le bouton se réarme : un refus passager ne doit pas geler la modale.
    expect(($('verdict-approuver') as HTMLButtonElement).disabled).toBe(false)
  })

  it('ne montre aucun verdict sans code dans l\'URL', () => {
    monterConsole()

    expect(affiche('verdict-code')).toBe(false)
  })

  it('s\'ouvre sur le code quand la machine y renvoie', () => {
    // Better Auth renvoie la machine vers `/admin/devices?user_code=…` : sans
    // cela, l'opérateur cherche le champ dans un onglet qu'il ne connaît pas.
    globalThis.history.replaceState(null, '', '/admin/devices?user_code=FH9BAXGZ')
    localStorage.setItem('hub-admin', 'jeton')
    monterConsole()

    expect(document.getElementById('vue-appairage')?.hidden).toBe(false)
    expect(document.getElementById('vue-exploitation')?.hidden).toBe(true)
    globalThis.history.replaceState(null, '', '/admin')
  })
})

/**
 * Notifications du navigateur.
 *
 * La console se regarde sur un téléphone, dans un couloir : savoir qu'une salle
 * déborde ne doit pas demander d'avoir la page sous les yeux.
 */
describe('notifications', () => {
  class NotificationFactice {
    static permission = 'default'
    static demandes = 0
    static envoyees: { titre: string; corps: string | undefined }[] = []
    onclick: (() => void) | null = null
    static async requestPermission(): Promise<string> {
      NotificationFactice.demandes += 1
      NotificationFactice.permission = 'granted'
      return 'granted'
    }
    constructor(titre: string, options?: { body?: string }) {
      NotificationFactice.envoyees.push({ titre, corps: options?.body })
    }
    close(): void {}
  }

  /** Rejoue un cycle de rafraîchissement avec l'état de salles donné. */
  async function avecSalles(salles: unknown[]): Promise<void> {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const chemin = String(url).replace('/rpc/', '')
      return new Response(JSON.stringify({ json: chemin === 'rooms/statuses' ? salles : [] }), { status: 200 })
    }))
    $('btn-rafraichir').click()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  const SALLE = {
    roomId: 'track-1',
    name: 'Track #1',
    connectivity: 'ONLINE',
    sceneRole: 'LIVE',
    recording: false,
    streaming: false,
    outboxDepth: 0,
    lastSeenAt: new Date().toISOString(),
    programContentHash: 'h',
    currentSession: null,
    conference: 'en-cours',
  }

  beforeEach(() => {
    NotificationFactice.permission = 'default'
    NotificationFactice.demandes = 0
    NotificationFactice.envoyees = []
    vi.stubGlobal('Notification', NotificationFactice)
    localStorage.setItem('hub-admin', 'jeton')
  })

  it("explique un refus du service de push sans parler du hub", async () => {
    /**
     * S'abonner exige que le *navigateur* joigne le service de push de son
     * éditeur, sur Internet — même pour un hub local. Le message brut
     * (« push service error ») faisait chercher la panne côté hub.
     */
    NotificationFactice.permission = 'granted'
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      serviceWorker: {
        register: async () => { throw new Error('Registration failed - push service error') },
        ready: Promise.resolve({}),
      },
    })
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const chemin = String(url).replace('/rpc/', '')
      // Seule la clé publique compte ici ; le reste doit rester lisible par la
      // console, sinon son erreur vient couvrir celle qu'on vient vérifier.
      const json = chemin === 'push/publicKey' ? { publicKey: 'BJ' }
        : chemin === 'program/globalBreak' ? null
          : []
      return new Response(JSON.stringify({ json }), { status: 200 })
    }))
    monterConsole()

    $('btn-notifs').click()
    $('notif-appliquer').click()
    await vi.waitFor(() => expect($('avis').textContent).toContain('service de notifications'))

    // Et l'essentiel reste acquis : les alertes console ouverte fonctionnent.
    expect(localStorage.getItem('hub-notifs')).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('propose le réglage, sans rien demander au chargement', () => {
    monterConsole()

    // Un navigateur qui voit la question arriver seule la refuse pour de bon.
    expect(NotificationFactice.demandes).toBe(0)
    expect($('btn-notifs').hidden).toBe(false)
  })

  it("demande la permission à l'application, et retient les niveaux", async () => {
    monterConsole()

    $('btn-notifs').click()
    // Le panneau s'ouvre sur les défauts : l'essentiel des deux familles.
    expect(($('notif-technique') as HTMLSelectElement).value).toBe('essentiel')
    ;($('notif-exploitation') as HTMLSelectElement).value = 'tout'
    $('notif-appliquer').click()

    await vi.waitFor(() => expect(localStorage.getItem('hub-notifs')).toBeTruthy())
    expect(JSON.parse(localStorage.getItem('hub-notifs')!)).toEqual({
      technique: 'essentiel',
      exploitation: 'tout',
    })
    expect(NotificationFactice.demandes).toBe(1)
  })

  it('éteint tout sans redemander la permission', async () => {
    monterConsole()
    $('btn-notifs').click()
    $('notif-appliquer').click()
    await vi.waitFor(() => expect(NotificationFactice.demandes).toBe(1))

    $('btn-notifs').click()
    ;($('notif-technique') as HTMLSelectElement).value = 'rien'
    ;($('notif-exploitation') as HTMLSelectElement).value = 'rien'
    $('notif-appliquer').click()
    await vi.waitFor(() => expect($('avis').textContent).toContain('éteintes'))

    // Le réglage reste écrit : rallumer ne doit pas repasser par une
    // permission qu'un refus rendrait définitive.
    expect(JSON.parse(localStorage.getItem('hub-notifs')!).technique).toBe('rien')
    expect(NotificationFactice.demandes).toBe(1)
  })

  it('ne dit rien du premier chargement, prévient du changement', async () => {
    localStorage.setItem('hub-notifs', JSON.stringify({ technique: 'tout', exploitation: 'tout' }))
    NotificationFactice.permission = 'granted'
    monterConsole()
    await avecSalles([SALLE])
    // Ouvrir la console sur une salle en cours n'est pas un événement.
    expect(NotificationFactice.envoyees).toEqual([])

    await avecSalles([{ ...SALLE, conference: 'depassement' }])
    expect(NotificationFactice.envoyees.map((n) => n.titre)).toEqual(['Track #1 déborde'])

    // Le même état au rafraîchissement suivant ne renotifie pas : répéter
    // ferait couper les notifications, et on ne les rallume pas.
    await avecSalles([{ ...SALLE, conference: 'depassement' }])
    expect(NotificationFactice.envoyees).toHaveLength(1)
  })

  it('prévient quand une salle tombe, puis quand elle revient', async () => {
    // « Revenue » est un soulagement, pas une décision : il faut « tout ».
    localStorage.setItem('hub-notifs', JSON.stringify({ technique: 'tout', exploitation: 'tout' }))
    NotificationFactice.permission = 'granted'
    monterConsole()
    await avecSalles([SALLE])

    await avecSalles([{ ...SALLE, connectivity: 'OFFLINE' }])
    await avecSalles([SALLE])

    expect(NotificationFactice.envoyees.map((n) => n.titre)).toEqual([
      'Track #1 ne répond plus',
      'Track #1 est revenue',
    ])
  })

  it('respecte le niveau : le rythme de la journée ne passe pas en « essentiel »', async () => {
    localStorage.setItem(
      'hub-notifs',
      JSON.stringify({ technique: 'essentiel', exploitation: 'essentiel' }),
    )
    NotificationFactice.permission = 'granted'
    monterConsole()
    await avecSalles([SALLE])

    // Une fin qui approche rythme la journée ; elle ne demande pas d'arbitrage.
    await avecSalles([{ ...SALLE, conference: 'fin-proche' }])
    expect(NotificationFactice.envoyees).toEqual([])

    // Un dépassement, si.
    await avecSalles([{ ...SALLE, conference: 'depassement' }])
    expect(NotificationFactice.envoyees.map((n) => n.titre)).toEqual(['Track #1 déborde'])
  })

  it('annonce début et fin quand on veut tout suivre', async () => {
    localStorage.setItem(
      'hub-notifs',
      JSON.stringify({ technique: 'rien', exploitation: 'tout' }),
    )
    NotificationFactice.permission = 'granted'
    monterConsole()
    await avecSalles([{ ...SALLE, conference: 'pas-commencee' }])

    await avecSalles([{ ...SALLE, conference: 'en-cours' }])
    await avecSalles([{ ...SALLE, conference: 'terminee' }])

    expect(NotificationFactice.envoyees.map((n) => n.titre)).toEqual([
      "Track #1 · c'est parti",
      'Track #1 · terminé',
    ])
  })

  it('se tait tant que le réglage est éteint', async () => {
    NotificationFactice.permission = 'granted'
    monterConsole()
    await avecSalles([SALLE])
    await avecSalles([{ ...SALLE, conference: 'depassement' }])

    expect(NotificationFactice.envoyees).toEqual([])
  })
})

/**
 * Connexion Google Workspace.
 *
 * Tout compte du domaine autorisé est un opérateur : le bouton est la seule
 * porte que la plupart des gens pousseront, et elle ne doit exister que si le
 * hub sait s'en servir.
 */
describe('connexion Google', () => {
  it("ne propose rien quand le hub n'a pas d'identifiants", () => {
    monterConsole()

    // Un bouton qui échoue à chaque clic vaut moins que pas de bouton.
    expect($('btn-google')).toBeNull()
  })

  it('dit quel domaine ouvre la console', () => {
    monterConsole({ google: { domaine: 'cloudnord.fr' } })

    expect($('btn-google')).toBeTruthy()
    // Sans cette mention, on s'obstine avec une adresse personnelle que Google
    // refusera de toute façon.
    expect($('connexion').textContent).toContain('@cloudnord.fr')
  })

  it('part vers Google et suit son adresse', async () => {
    const aller = vi.fn()
    vi.stubGlobal('location', { ...globalThis.location, assign: aller, search: '', pathname: '/admin' })
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ url: 'https://accounts.google.com/o/oauth2/v2/auth?hd=cloudnord.fr' }), { status: 200 })))
    localStorage.clear()
    monterConsole({ google: { domaine: 'cloudnord.fr' } })

    ;($('btn-google') as HTMLButtonElement).click()
    // Better Auth ne redirige pas lui-même : il rend l'URL, la page la suit.
    await vi.waitFor(() => expect(aller).toHaveBeenCalledWith(expect.stringContaining('accounts.google.com')))
    vi.unstubAllGlobals()
  })

  it('ouvre la console sur la session que le retour a posée', async () => {
    /**
     * La redirection pose un cookie, pas le jeton porteur du formulaire : sans
     * cette reconnaissance, l'opérateur revenait de Google authentifié… sur
     * l'écran de connexion.
     */
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      new Response(
        JSON.stringify(String(url).includes('get-session') ? { user: { email: 'ops@cloudnord.fr' } } : { json: [] }),
        { status: 200 },
      )))
    monterConsole({ google: { domaine: 'cloudnord.fr' } })

    await vi.waitFor(() => expect($('console').hidden).toBe(false))
    expect($('identite').textContent).toBe('ops@cloudnord.fr')
  })

  it('reste sur le formulaire quand aucune session ne répond', async () => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    monterConsole()

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect($('console').hidden).toBe(true)
    expect($('connexion').hidden).toBe(false)
  })
})

/**
 * Fermer la console.
 *
 * Le bouton n'existait pas : on ne pouvait quitter la console qu'en attendant
 * l'expiration de la session, sur un poste souvent partagé.
 */
describe('déconnexion', () => {
  it('révoque la session côté hub avant de rendre la main', async () => {
    const appels = vi.fn(async (url: string) => {
      void url
      return new Response(JSON.stringify({ json: [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', appels)
    monterConsole()

    ;($('btn-deconnexion') as HTMLButtonElement).click()
    // Oublier le jeton sans le révoquer laisserait une session valide derrière.
    await vi.waitFor(() => expect(appels.mock.calls.some(([url]) => url === '/api/auth/sign-out')).toBe(true))

    expect(localStorage.getItem('hub-admin')).toBeNull()
    expect($('console').hidden).toBe(true)
    expect($('connexion').hidden).toBe(false)
  })

  it('rend la main même quand le hub ne répond pas', async () => {
    // Un hub injoignable ne doit pas retenir un opérateur devant sa console.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('réseau coupé') }))
    monterConsole()

    ;($('btn-deconnexion') as HTMLButtonElement).click()
    await vi.waitFor(() => expect($('connexion').hidden).toBe(false))

    expect(localStorage.getItem('hub-admin')).toBeNull()
  })
})

/**
 * Tenue sur un téléphone.
 *
 * La console se regarde debout, au fond d'une salle, sur l'écran qu'on a dans
 * la poche : rien ne doit déborder latéralement, sous peine de pousser la page
 * entière hors cadre pour une colonne trop large.
 */
describe('console sur téléphone', () => {
  it('ne force jamais une colonne plus large que l\'écran', () => {
    // `minmax(260px, 1fr)` déborde dès que l'écran fait 360 px marges
    // comprises ; le `min()` plafonne la colonne à la largeur disponible.
    const colonnes = globalThis.getComputedStyle($('salles')).gridTemplateColumns
    expect(colonnes).toContain('min(')
  })

  it('fait défiler la barre d\'onglets plutôt que de l\'empiler', () => {
    // Sept onglets sur trois lignes pousseraient le contenu sous la ligne de
    // flottaison, sur l'écran où l'on a le moins de place pour ça.
    const nav = document.querySelector('nav')!
    expect(globalThis.getComputedStyle(nav).overflowX).toBe('auto')
  })

  it('laisse les tableaux défiler pour eux-mêmes', () => {
    // Sans conteneur, les six colonnes des conférences emportent la page.
    for (const tableau of document.querySelectorAll('table')) {
      const parent = tableau.parentElement!
      expect(globalThis.getComputedStyle(parent).overflowX).toBe('auto')
    }
  })
})

/**
 * Le menu Développement, et ce qu'il emporte avec lui.
 *
 * L'heure du hub y a déménagé : elle déplace tout le système — les trois salles
 * s'alignent, les timecodes VOD se décalent, les clôtures automatiques partent
 * à contretemps — et n'a rien à faire à côté des réglages qu'on touche le jour J.
 */
describe('menu Développement', () => {
  it('n\'est pas rendu en production, l\'horloge avec lui', () => {
    // Pas *masqué* : absent. Un panneau à un attribut `hidden` près se rouvre
    // depuis l'inspecteur, et son JavaScript, lui, serait bien câblé.
    expect(document.getElementById('nav-developpement')).toBeNull()
    expect(document.getElementById('vue-developpement')).toBeNull()
    expect(document.getElementById('horloge-cible')).toBeNull()
  })

  it('regroupe l\'heure simulée en mode dev', () => {
    monterConsole({ mode: 'dev' })

    expect(document.getElementById('vue-developpement')).toBeTruthy()
    const champ = document.getElementById('horloge-cible')
    expect(champ).toBeTruthy()
    // Et plus dans les réglages : c'est ce qu'on vient d'en sortir.
    expect($('vue-reglages').contains(champ)).toBe(false)
    expect($('vue-developpement').contains(champ)).toBe(true)
  })

  it('se laisse ouvrir comme les autres vues', () => {
    monterConsole({ mode: 'dev' })
    $('nav-developpement').click()

    expect(estVisible('vue-developpement')).toBe(true)
    expect(estVisible('vue-reglages')).toBe(false)
  })

  it('laisse le reste de la console vivant en production', () => {
    // Les boutons d'horloge n'existent plus : les câbler sans vérifier
    // lèverait, et tout le script de la console mourrait avec — sans un mot.
    $('nav-messages').click()

    expect(estVisible('vue-messages')).toBe(true)
  })
})

/**
 * Le programme vit dans les réglages, en un seul encart.
 *
 * Sa source change quand le programme change, c'est-à-dire pendant l'événement.
 * Les versions déjà importées l'accompagnent : on ne réimporte jamais sans
 * regarder ce que ça donne, et revenir à celle d'avant est le geste qui suit
 * immédiatement un import raté.
 */
describe('programme', () => {
  const REGLAGES = {
    autoEndEnabled: true,
    autoEndGraceMinutes: 5,
    programSourceUrl: 'https://exemple.test/programme.json',
  }

  let appels: { chemin: string; entree: unknown }[]

  /** Stub des appels oRPC, avec les réglages qu'on veut voir arriver. */
  function brancher(reglages: Record<string, unknown>): void {
    appels = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const chemin = String(url).replace('/rpc/', '')
      appels.push({ chemin, entree: JSON.parse(String(init.body)).json })
      const json =
        chemin === 'settings/get' || chemin === 'settings/update'
          ? reglages
          : chemin === 'program/import'
            ? { contentHash: 'h', program: { sessions: [] } }
            : []
      return new Response(JSON.stringify({ json }), { status: 200 })
    }))
    monterConsole()
    $('nav-reglages').click()
  }

  const attendre = () => new Promise((resolve) => setTimeout(resolve, 20))

  it('tient dans les réglages, source et versions ensemble', () => {
    brancher(REGLAGES)

    for (const id of ['url-programme', 'btn-reimporter', 'snapshots']) {
      expect($('vue-reglages').contains($(id))).toBe(true)
    }
    // L'exploitation n'en garde rien : c'est l'écran qu'on laisse ouvert toute
    // la journée, il montre les salles.
    expect($('vue-exploitation').textContent).not.toContain('Programme')
  })

  it('remplit le champ avec la source enregistrée', async () => {
    brancher(REGLAGES)
    await attendre()

    expect(($('url-programme') as HTMLInputElement).value).toBe(REGLAGES.programSourceUrl)
    expect(($('btn-reimporter') as HTMLButtonElement).disabled).toBe(false)
  })

  it('réimporte depuis l\'URL enregistrée, sans rien recopier', async () => {
    brancher(REGLAGES)
    await attendre()
    $('btn-reimporter').click()
    await attendre()

    expect(appels).toContainEqual({
      chemin: 'program/import',
      entree: { sourceUrl: REGLAGES.programSourceUrl },
    })
  })

  it('attend que la saisie soit enregistrée avant de réimporter', async () => {
    // Sinon il tirerait l'ancienne adresse pendant qu'on en lit une nouvelle
    // à l'écran — un malentendu qu'on ne remarque qu'après.
    brancher(REGLAGES)
    await attendre()
    const champ = $('url-programme') as HTMLInputElement
    champ.value = 'https://exemple.test/autre.json'
    champ.dispatchEvent(new Event('input'))

    expect(($('btn-reimporter') as HTMLButtonElement).disabled).toBe(true)
  })

  it('n\'offre pas d\'import quand aucune source n\'est réglée', async () => {
    // Bouton mort plutôt qu'erreur au clic : l'état se voit avant d'appuyer.
    brancher({ ...REGLAGES, programSourceUrl: null })
    await attendre()

    expect(($('btn-reimporter') as HTMLButtonElement).disabled).toBe(true)
  })

  it('enregistre une URL vidée comme une absence de source', async () => {
    brancher({ ...REGLAGES, programSourceUrl: null })
    await attendre()
    ;($('url-programme') as HTMLInputElement).value = '  '
    $('btn-source-programme').click()
    await attendre()

    expect(appels).toContainEqual({ chemin: 'settings/update', entree: { programSourceUrl: null } })
  })
})

describe('liste des salles', () => {
  /** Le créneau en cours de Track #1, que chaque cas retouche à sa façon. */
  const CRENEAU = {
    id: 'ses-1',
    title: 'HoneySwamp',
    endsAt: '2026-10-30T10:50:00.000Z',
    remainingMs: 23 * 60_000,
  }

  const SALLES = [
    {
      roomId: 'track-1',
      name: 'Track #1',
      connectivity: 'ONLINE',
      sceneRole: 'LIVE',
      recording: true,
      streaming: false,
      outboxDepth: 0,
      lastSeenAt: new Date().toISOString(),
      programContentHash: 'h',
      currentSession: CRENEAU,
      conference: 'en-cours',
    },
    {
      roomId: 'hands-on',
      name: 'Hands on',
      connectivity: 'OFFLINE',
      sceneRole: null,
      recording: false,
      streaming: false,
      outboxDepth: 12,
      lastSeenAt: null,
      programContentHash: null,
      currentSession: null,
      conference: 'aucune',
    },
  ]

  /** Remonte la console sur un état de salles et un créneau commun donnés. */
  async function avecSallesEtGlobal(salles: unknown, global: unknown = null): Promise<void> {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const chemin = String(url).replace('/rpc/', '')
      const json = chemin === 'rooms/statuses' ? salles
        : chemin === 'program/globalBreak' ? global
          : []
      return new Response(JSON.stringify({ json }), { status: 200 })
    }))
    localStorage.setItem('hub-admin', 'jeton')
    monterConsole()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  beforeEach(async () => {
    await avecSallesEtGlobal(SALLES)
  })

  /** Remonte la console sur une seule salle, dont le créneau est retouché. */
  async function avecCreneau(patch: {
    endsAt?: string | null
    remainingMs?: number | null
  }): Promise<void> {
    await avecSallesEtGlobal([{ ...SALLES[0], currentSession: { ...CRENEAU, ...patch } }])
  }

  /**
   * Un créneau commun ne se présente pas comme une conférence.
   *
   * Pendant le déjeuner, la carte annonçait « Déjeuner · 22 min restantes »
   * exactement comme elle annonce un talk : même place, même forme, même
   * décompte. On lisait une salle occupée là où il n'y a personne.
   */
  describe('créneau commun', () => {
    const DEJEUNER = {
      state: 'en-cours',
      title: 'Déjeuner',
      startsAt: '2026-10-30T11:15:00.000Z',
      endsAt: '2026-10-30T12:05:00.000Z',
    }

    it('marque la salle d\'une étiquette et se tait sur le reste', async () => {
      await avecSallesEtGlobal([
        {
          ...SALLES[0],
          conference: 'pause',
          currentSession: { ...CRENEAU, title: 'Déjeuner' },
          breakBadge: DEJEUNER,
        },
      ])

      const carte = document.getElementById('salles')!.textContent ?? ''
      expect(carte).toContain('BREAK')
      // Ni le titre du créneau, ni son décompte : le détail vit dans l'encart.
      expect(carte).not.toContain('Déjeuner')
      expect(carte).not.toContain('restantes')
      // La pastille le dit en toutes lettres : il n'y a personne.
      expect(carte).toContain('rien dans la salle')
    })

    it("l'annonce pendant que la conférence court encore", async () => {
      await avecSallesEtGlobal([
        { ...SALLES[0], breakBadge: { ...DEJEUNER, state: 'a-venir' } },
      ])

      const carte = document.getElementById('salles')!.textContent ?? ''
      expect(carte).toContain('BREAK à venir')
      // La conférence, elle, continue de s'afficher : c'est le cas qui compte —
      // celui où l'on décide de ne pas enchaîner.
      expect(carte).toContain('HoneySwamp')
    })

    it('ouvre un encart Global pendant le créneau commun', async () => {
      await avecSallesEtGlobal(SALLES, {
        ...DEJEUNER,
        rooms: 3,
        serverTime: '2026-10-30T11:43:00.000Z',
      })

      expect(document.getElementById('encart-global')!.hidden).toBe(false)
      expect(document.getElementById('global-titre')!.textContent).toBe('Déjeuner')
      // Le décompte se calcule sur l'heure du hub, jamais sur celle du poste :
      // sinon la console annonce « dans 6010 min » en heure simulée.
      expect(document.getElementById('global-detail')!.textContent)
        .toBe('reprise dans 22 min · 3 salles')
    })

    it("l'annonce à venir, puis le referme quand il n'y a rien", async () => {
      await avecSallesEtGlobal(SALLES, {
        ...DEJEUNER,
        state: 'a-venir',
        rooms: 3,
        serverTime: '2026-10-30T11:03:00.000Z',
      })

      expect(document.getElementById('global-titre')!.textContent).toBe('Déjeuner — à venir')
      expect(document.getElementById('global-detail')!.textContent).toBe('dans 12 min · 3 salles')

      // Rien de commun en cours : l'encart disparaît. Un encart vide se lirait
      // comme une panne.
      await avecSallesEtGlobal(SALLES, null)
      expect(document.getElementById('encart-global')!.hidden).toBe(true)
    })
  })

  it('dit ce qui se joue dans chaque salle', () => {
    // La première chose qu'on vient vérifier — elle manquait au tableau.
    const texte = document.getElementById('salles')?.textContent ?? ''
    expect(texte).toContain('HoneySwamp')
    expect(texte).toContain('Rien au programme')
  })

  it('dit combien de temps il reste au créneau', () => {
    // Savoir ce qui se joue ne dit pas si la salle déborde : c'est le restant
    // qui déclenche une décision, et il vient du hub, pas de l'horloge du poste.
    const texte = document.getElementById('salles')?.textContent ?? ''
    expect(texte).toContain('23 min restantes')
  })

  it('signale le dépassement plutôt que de compter à l\'envers', async () => {
    await avecCreneau({ remainingMs: -4 * 60_000 })

    const carte = document.getElementById('salles')!
    expect(carte.textContent).toContain('dépassement de 4 min')
    expect(carte.innerHTML).toContain('text-alerte')
  })

  it('ne dit rien sur un créneau de fin inconnue', async () => {
    // « 0 min restantes » sous un créneau sans horaire de fin serait un mensonge.
    await avecCreneau({ endsAt: null, remainingMs: null })

    const texte = document.getElementById('salles')?.textContent ?? ''
    expect(texte).toContain('HoneySwamp')
    expect(texte).not.toContain('restantes')
  })

  it('résume l\'état sans tableau', () => {
    const texte = document.getElementById('salles')?.textContent ?? ''
    expect(texte).toContain('REC')
    expect(texte).toContain('12 en file')
    expect(document.getElementById('salles')?.querySelector('table')).toBeNull()
  })

  /**
   * La pastille dit deux choses à la fois : remplissage pour la conférence,
   * contour pour la confiance. Elle ne portait que la connectivité — une salle
   * en dépassement de dix minutes s'affichait en vert.
   */
  it('peint la conférence, et creuse la pastille des salles muettes', async () => {
    const pastilles = [...$('salles').querySelectorAll('.pastille')].map((p) => p.className)
    // Track #1 joue son talk dans les temps : remplissage par défaut, pas de contour.
    expect(pastilles[0]).toBe('pastille ')
    // Hands on ne répond plus : on ne sait pas ce qui s'y joue, on ne le peint pas.
    expect(pastilles[1]).toContain('muette')
    expect($('salles').textContent).toContain('salle muette')
  })

  it("ne dit pas « en cours » d'un talk que personne n'a lancé", async () => {
    // Le créneau tourne, la régie n'a pas appuyé sur Commencer : la pastille
    // passait au vert sur une salle où il ne se passait rien.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const chemin = String(url).replace('/rpc/', '')
      const json = chemin === 'rooms/statuses' ? [{ ...SALLES[0], conference: 'retard' }] : []
      return new Response(JSON.stringify({ json }), { status: 200 })
    }))
    monterConsole()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect($('salles').querySelector('.pastille')?.className).toContain('retard')
    expect($('salles').textContent).toContain('retard au démarrage')
  })

  it('signale un dépassement en rouge, avec le mot', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const chemin = String(url).replace('/rpc/', '')
      const json = chemin === 'rooms/statuses'
        ? [{ ...SALLES[0], conference: 'depassement' }]
        : []
      return new Response(JSON.stringify({ json }), { status: 200 })
    }))
    monterConsole()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect($('salles').querySelector('.pastille')?.className).toContain('depassement')
    // Le mot accompagne la couleur : la carte se regarde de loin, et tout le
    // monde ne distingue pas les teintes.
    expect($('salles').textContent).toContain('dépassement')
  })

  it('mène au mur public de la salle', () => {
    const lien = document.getElementById('salles')?.querySelector('a')
    expect(lien?.getAttribute('href')).toBe('/mur?salle=track-1')
  })

  it('ne compte pas à rebours quand la date vient du futur', () => {
    // Les horloges du hub et du navigateur ne sont pas la même : « vu
    // -6010436 s » ne veut rien dire pour personne.
    expect(document.getElementById('salles')?.textContent).not.toContain('-')
  })
})

/**
 * Vue Conférences.
 *
 * Deux tableaux, deux questions. Celui du haut ne connaît que les conférences
 * démarrées et répond à « où en est-on » ; le planning répond à « et après, il
 * y a quoi », que l'organisateur s'entend poser toute la journée.
 */
describe('vue Conférences', () => {
  const ETATS = [
    {
      sessionId: 'ses-1',
      roomId: 'track-1',
      roomName: 'Track #1',
      title: 'HoneySwamp',
      status: 'running',
      scheduledStartsAt: '2026-10-30T10:00:00.000Z',
      scheduledEndsAt: '2026-10-30T10:50:00.000Z',
      remainingMs: 23 * 60_000,
      decidedBy: 'regie@cloudnord.fr',
    },
  ]

  const PLANNING = {
    contentHash: 'a1b2c3',
    timezone: 'Europe/Paris',
    // 10:12 UTC : « HoneySwamp » court, le déjeuner n'a pas commencé.
    serverTime: '2026-10-30T10:12:00.000Z',
    openFeedbackProjectId: 'cloud-nord-2026',
    rooms: [
      { id: 'track-1', name: 'Track #1' },
      { id: 'hands-on', name: 'Hands on' },
    ],
    sessions: [
      {
        id: 'ses-1', title: 'HoneySwamp', speakers: ['Steven LE ROUX'],
        startsAt: '2026-10-30T10:00:00.000Z', endsAt: '2026-10-30T10:50:00.000Z',
        roomId: 'track-1', roomName: 'Track #1', kind: 'talk',
        feedbackUrl: 'https://openfeedback.io/cloud-nord-2026/2026-10-30/ses-1',
        // Lancée avec quatre minutes de retard, pas encore terminée.
        startedAt: '2026-10-30T10:04:00.000Z', endedAt: null,
        decidedBy: 'regie@cloudnord.fr',
      },
      {
        id: 'pause', title: 'Déjeuner', speakers: [],
        startsAt: '2026-10-30T11:00:00.000Z', endsAt: '2026-10-30T12:00:00.000Z',
        roomId: null, roomName: null, kind: 'break', feedbackUrl: null,
      },
      {
        id: 'ses-2', title: 'Event Iterators', speakers: ['Alex Martin'],
        startsAt: '2026-10-30T12:00:00.000Z', endsAt: '2026-10-30T12:50:00.000Z',
        roomId: 'hands-on', roomName: 'Hands on', kind: 'talk',
        feedbackUrl: 'https://openfeedback.io/cloud-nord-2026/2026-10-30/ses-2',
        startedAt: null, endedAt: null,
      },
    ],
  }

  /** Appels partis vers le hub depuis l'ouverture de la vue. */
  let appels: { chemin: string; entree: unknown }[] = []

  /** Ce que le hub répond au dossier VOD, réglable par test. */
  let dossierVod: unknown = {
    sessionId: 'ses-1',
    roomId: 'track-1',
    roomName: 'Track #1',
    stockageConfigure: false,
    captations: [],
    televersements: [],
  }

  /** Ouvre la console sur l'onglet Conférences, hub simulé. */
  async function ouvrir(planning: unknown = PLANNING, etats: unknown = ETATS): Promise<void> {
    appels = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const chemin = String(url).replace('/rpc/', '')
      appels.push({ chemin, entree: JSON.parse(String(init.body)).json })
      const json =
        chemin === 'sessions/states' ? etats
          : chemin === 'program/planning' ? planning
            : chemin === 'program/snapshots' ? [{ contentHash: 'a1b2c3', active: true }]
              : chemin === 'sessions/override' ? { ok: true, contentHash: 'a1b2c3~ff' }
                : chemin === 'vod/conference' ? dossierVod
                  : []
      return new Response(JSON.stringify({ json }), { status: 200 })
    }))
    localStorage.setItem('hub-admin', 'jeton')
    monterConsole()
    $('nav-conferences').click()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  /** Le menu d'actions d'une ligne du planning, repéré par son créneau. */
  function menuDe(sessionId: string): HTMLSelectElement | null {
    return $('planning').querySelector('select[data-session="' + sessionId + '"]')
  }

  it('compte le restant sur l\'horloge du hub', async () => {
    // Soustraire ici la fin du créneau de l'heure du navigateur affichait
    // « +6010 min » sur un talk à l'heure dès que l'horloge du hub était
    // simulée — et c'est elle qui fait foi pour toute la journée.
    await ouvrir()

    expect($('conferences').textContent).toContain('23 min')
  })

  it('signale le dépassement, seul cas qui déclenche une décision', async () => {
    await ouvrir(PLANNING, [{ ...ETATS[0], remainingMs: -6 * 60_000 }])

    expect($('conferences').textContent).toContain('+6 min')
    expect($('conferences').innerHTML).toContain('text-alerte')
  })

  it('ne dit rien sur un créneau de fin inconnue', async () => {
    // « 0 min » sous un créneau sans horaire de fin serait un mensonge.
    await ouvrir(PLANNING, [{ ...ETATS[0], scheduledEndsAt: null, remainingMs: null }])

    expect($('conferences').textContent).toContain('HoneySwamp')
    // La colonne « Reste », et elle seule : le bouton « Terminer » contient
    // lui aussi les trois lettres de « min ».
    expect($('conferences').querySelectorAll('td')[3]?.textContent).toBe('—')
  })

  it('relit le planning entier, pas seulement ce qui a démarré', async () => {
    await ouvrir()

    const texte = $('planning').textContent ?? ''
    expect(texte).toContain('HoneySwamp')
    expect(texte).toContain('Event Iterators')
    // Les pauses font partie de la journée : les cacher ferait douter d'un trou
    // dans le planning.
    expect(texte).toContain('Déjeuner')
    expect(texte).toContain('Steven LE ROUX')
  })

  /**
   * Ce qui était prévu et ce qui s'est passé, côte à côte.
   *
   * L'écart est la seule chose qu'on vient chercher : un retard au démarrage,
   * un dépassement, une durée réelle pour le montage. Il ne se lit que si les
   * deux colonnes sont sur la même ligne — recroiser deux tableaux de tête est
   * exactement ce que cette vue existe pour éviter.
   */
  describe('horaires réels du planning', () => {
    /** La ligne d'un créneau, repérée par son titre. */
    function ligneDe(titre: string): HTMLTableRowElement {
      return [...$('planning').querySelectorAll('tr')].find(
        (tr) => tr.textContent?.includes(titre),
      ) as HTMLTableRowElement
    }

    it('affiche le début réel en regard du prévu', async () => {
      await ouvrir()
      const cellules = ligneDe('HoneySwamp').querySelectorAll('td')

      // 10:00 UTC = 11:00 à Paris ; lancée à 10:04 UTC, soit 11:04.
      expect(cellules[0]?.textContent).toContain('11:00')
      expect(cellules[1]?.textContent).toContain('11:04')
    })

    it('ne referme pas un créneau que personne n\'a terminé', async () => {
      await ouvrir()

      expect(ligneDe('HoneySwamp').querySelectorAll('td')[1]?.textContent).toContain('en cours')
    })

    it('donne l\'instant complet et l\'auteur en infobulle', async () => {
      await ouvrir()
      const infobulle = ligneDe('HoneySwamp').innerHTML

      // L'heure suffit pour lire la journée ; la date entière sert au montage.
      expect(infobulle).toContain('2026-10-30T10:04:00.000Z')
      // Et l'auteur, qui est ce qu'on cherche devant une décision dont personne
      // ne se souvient.
      expect(infobulle).toContain('regie@cloudnord.fr')
    })

    it('nomme la règle horaire plutôt que de dire « auto »', async () => {
      await ouvrir({
        ...PLANNING,
        sessions: [
          { ...PLANNING.sessions[0], endedAt: '2026-10-30T10:53:00.000Z', decidedBy: 'auto' },
          ...PLANNING.sessions.slice(1),
        ],
      })

      expect(ligneDe('HoneySwamp').innerHTML).toContain('la règle horaire')
    })

    it('affiche la fin réelle une fois la conférence terminée', async () => {
      await ouvrir({
        ...PLANNING,
        sessions: [
          { ...PLANNING.sessions[0], endedAt: '2026-10-30T10:53:00.000Z' },
          ...PLANNING.sessions.slice(1),
        ],
      })

      // Dépassement de trois minutes : 10:53 UTC = 11:53 à Paris.
      expect(ligneDe('HoneySwamp').querySelectorAll('td')[1]?.textContent).toContain('11:53')
    })

    it('ne fabrique rien sur un créneau que personne n\'a piloté', async () => {
      await ouvrir()

      // Une heure reprise du programme affirmerait qu'un talk s'est tenu quand
      // rien ne l'atteste — et une pause n'est jamais pilotée.
      expect(ligneDe('Event Iterators').querySelectorAll('td')[1]?.textContent).toBe('—')
      expect(ligneDe('Déjeuner').querySelectorAll('td')[1]?.textContent).toBe('—')
    })
  })

  it('lit les heures dans le fuseau de l\'événement', async () => {
    // 10:00 UTC, c'est 11:00 à Paris. La console s'ouvre aussi depuis ailleurs ;
    // le programme, lui, ne se décale pas.
    await ouvrir()

    expect($('planning').textContent).toContain('11:00')
  })

  it('mène à l\'OpenFeedback de chaque conférence', async () => {
    await ouvrir()

    const liens = [...$('planning').querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(liens).toEqual([
      'https://openfeedback.io/cloud-nord-2026/2026-10-30/ses-1',
      'https://openfeedback.io/cloud-nord-2026/2026-10-30/ses-2',
    ])
    // Rien à noter sur un déjeuner : la ligne existe, le lien non.
    expect(liens).not.toContain(null)
  })

  it('explique une colonne « Feedback » vide au lieu de la laisser vide', async () => {
    // Sans projet réglé, la colonne n'est qu'une suite de tirets, et rien ne
    // dit s'il manque un réglage ou si OpenFeedback n'est pas de la partie. La
    // différence tient en un champ, encore faut-il savoir où il est.
    await ouvrir({
      ...PLANNING,
      openFeedbackProjectId: null,
      sessions: PLANNING.sessions.map((session) => ({ ...session, feedbackUrl: null })),
    })

    const aide = $('planning-feedback-aide') as HTMLElement
    expect(aide.hidden).toBe(false)
    expect(aide.textContent).toContain('Réglages')
  })

  it('ne dit rien du réglage OpenFeedback quand il est en place', async () => {
    await ouvrir()

    expect(($('planning-feedback-aide') as HTMLElement).hidden).toBe(true)
  })

  it('replie la colonne « Action » au premier abord', async () => {
    // Elle est la seule de ce tableau qui *écrit*, et ce qu'elle écrit se
    // propage partout : un créneau marqué break disparaît de l'antenne, de la
    // régie et des QR. Un menu déroulant posé sur chaque ligne d'un planning
    // qu'on parcourt toute la journée finit par se cliquer sans qu'on l'ait
    // voulu, et rien dans le tableau ne le rattrape.
    await ouvrir()

    expect(document.body.dataset.planningActions).toBe('repliees')
    // Repliée, pas absente : les menus restent dans le DOM, sous une règle CSS.
    expect(menuDe('ses-1')).not.toBeNull()
    expect(menuDe('ses-1')?.closest('td')?.className).toContain('col-action')
    expect($('btn-planning-actions').getAttribute('aria-expanded')).toBe('false')
  })

  it('déplie la colonne « Action » sur demande, et le redit', async () => {
    await ouvrir()

    $('btn-planning-actions').click()

    expect(document.body.dataset.planningActions).toBe('depliees')
    expect($('btn-planning-actions').getAttribute('aria-expanded')).toBe('true')
    expect($('btn-planning-actions').textContent).toContain('Masquer')
  })

  it('annonce les décisions en vigueur sans qu\'on déplie', async () => {
    // Replier une colonne ne doit pas revenir à cacher qu'on a corrigé des
    // créneaux : le bouton porte le compte.
    await ouvrir({
      ...PLANNING,
      sessions: PLANNING.sessions.map((session) =>
        session.id === 'ses-1' ? { ...session, overriddenAs: 'break' } : session),
    })

    expect($('btn-planning-actions').textContent).toContain('1 décision')
  })

  it('ouvre le dossier VOD d\'une conférence', async () => {
    dossierVod = {
      sessionId: 'ses-1',
      roomId: 'track-1',
      roomName: 'Track #1',
      stockageConfigure: true,
      captations: [
        {
          roomId: 'track-1', obs: 'B', startedAt: '2026-10-30T10:04:00.000Z',
          endedAt: '2026-10-30T10:52:00.000Z', durationMs: 2_880_000,
          file: '/rushes/honeyswamp.mkv', sidecarWritten: true, enCours: false,
          rattachement: 'session',
        },
      ],
      televersements: [
        {
          roomId: 'track-1', roomName: 'Track #1', file: 'honeyswamp.mkv', kind: 'rush',
          sessionId: 'ses-1', objectKey: 'cn26/track-1/honeyswamp.mkv', state: 'termine',
          sizeBytes: 1000, bytesSent: 1000, debitOctetsS: null,
          startedAt: '2026-10-30T11:00:00.000Z', lastProgressAt: null,
          finishedAt: '2026-10-30T11:20:00.000Z', attempts: 1, lastError: null,
        },
      ],
    }
    await ouvrir()

    const bouton = $('planning').querySelector('[data-vod-session="ses-1"]') as HTMLElement
    expect(bouton).not.toBeNull()
    bouton.click()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(document.body.dataset.vod).toBe('ouvert')
    expect($('vod-titre').textContent).toBe('HoneySwamp')
    const corps = $('vod-corps').textContent ?? ''
    // Les deux moitiés, dans l'ordre où la question se pose : est-ce que la
    // salle l'a, puis est-ce que c'est parti.
    expect(corps).toContain('/rushes/honeyswamp.mkv')
    expect(corps).toContain('cn26/track-1/honeyswamp.mkv')
    expect(appels.some((appel) => appel.chemin === 'vod/conference')).toBe(true)
  })

  it('dit qu\'aucune prise n\'a été remontée plutôt que de rester muet', async () => {
    // Le hub ne lit pas le disque de la régie : « rien ici » veut dire « rien
    // n'a été signalé », pas « il n'y a rien sur le disque ». La nuance décide
    // si on va voir en salle avant de démonter.
    dossierVod = {
      sessionId: 'ses-1', roomId: 'track-1', roomName: 'Track #1',
      stockageConfigure: false, captations: [], televersements: [],
    }
    await ouvrir()

    ;($('planning').querySelector('[data-vod-session="ses-1"]') as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 20))

    const corps = $('vod-corps').textContent ?? ''
    expect(corps).toContain('Aucune prise remontée')
    // Sans stockage, « rien de monté » ne veut rien dire : on le dit autrement.
    expect(corps).toContain('Aucun stockage configuré')
  })

  it('n\'offre pas de dossier VOD sur une pause', async () => {
    // Personne ne cherche le rush du déjeuner, et un bouton qui ouvrirait une
    // modale vide sur une ligne ferait douter des autres.
    await ouvrir()

    expect($('planning').querySelector('[data-vod-session="pause"]')).toBeNull()
  })

  it('referme le dossier VOD sur Échap', async () => {
    await ouvrir()
    ;($('planning').querySelector('[data-vod-session="ses-1"]') as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 20))

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(document.body.dataset.vod).toBe('ferme')
  })

  it('se filtre sur une salle sans redemander au hub', async () => {
    await ouvrir()
    const appelsAvant = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length

    const filtre = $('planning-salle') as HTMLSelectElement
    expect([...filtre.options].map((o) => o.value)).toEqual(['', 'track-1', 'hands-on'])
    filtre.value = 'hands-on'
    filtre.dispatchEvent(new Event('change'))

    const texte = $('planning').textContent ?? ''
    expect(texte).toContain('Event Iterators')
    expect(texte).not.toContain('HoneySwamp')
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(appelsAvant)
  })

  it('surligne le créneau en cours sur l\'heure du hub', async () => {
    // Un planning de vingt-sept lignes se lit en cherchant d'abord « on en est
    // où ». L'heure vient du hub : simulée depuis le menu Développement, celle
    // du navigateur pointerait un créneau d'une tout autre semaine.
    await ouvrir()

    const lignes = [...$('planning').querySelectorAll('tr')]
    expect(lignes[0]?.textContent).toContain('en ce moment')
    expect(lignes[0]?.className).toContain('bg-surface2')
    // Le déjeuner ne commence qu'à midi : rien ne doit le désigner.
    expect(lignes[1]?.textContent).not.toContain('en ce moment')
  })

  it('efface ce qui est passé sans le faire disparaître', async () => {
    // On y retrouve encore le lien de feedback d'un talk terminé — c'est même
    // le moment où on vient le chercher.
    await ouvrir({ ...PLANNING, serverTime: '2026-10-30T13:30:00.000Z' })

    const lignes = [...$('planning').querySelectorAll('tr')]
    expect(lignes.every((ligne) => ligne.className.includes('opacity-55'))).toBe(true)
    expect($('planning').textContent).not.toContain('en ce moment')
    expect($('planning').querySelectorAll('a')).toHaveLength(2)
  })

  it('ne désigne rien avant le début de la journée', async () => {
    await ouvrir({ ...PLANNING, serverTime: '2026-10-30T07:00:00.000Z' })

    expect($('planning').textContent).not.toContain('en ce moment')
    expect($('planning').innerHTML).not.toContain('opacity-55')
  })

  it('le dit plutôt que de rester vide sans programme', async () => {
    await ouvrir({
      contentHash: null,
      timezone: 'Europe/Paris',
      serverTime: '2026-10-30T10:12:00.000Z',
      rooms: [],
      sessions: [],
    })

    expect($('planning').textContent).toContain('Aucun programme actif')
  })

  /**
   * La colonne Action.
   *
   * L'export amont ne distingue pas un déjeuner d'une conférence : les deux
   * sont des créneaux avec un titre et une salle. C'est ici qu'on le corrige,
   * ligne par ligne, sans réimport.
   */
  describe('corriger le genre d\'un créneau', () => {
    /** Les entrées d'un menu, dans l'ordre : (valeur, libellé). */
    function entrees(menu: HTMLSelectElement): [string, string][] {
      return [...menu.options].map((option) => [option.value, option.textContent ?? ''])
    }

    it('offre l\'action qui contredit l\'export, jamais celle qui ne ferait rien', async () => {
      await ouvrir()

      // Une conférence ne se propose qu'en break…
      expect(entrees(menuDe('ses-1')!)).toEqual([
        ['', 'Aucune — conférence au programme'],
        ['break', 'Considérer comme break'],
      ])
      // …et une pause qu'en conférence. C'est le cas de la keynote d'ouverture,
      // que l'export donne pour une pause faute de speaker annoncé.
      expect(entrees(menuDe('pause')!)).toEqual([
        ['', 'Aucune — pause au programme'],
        ['talk', 'Considérer comme conférence'],
      ])
    })

    it('envoie « conférence » sur un créneau que l\'export donne pour une pause', async () => {
      await ouvrir()
      appels.length = 0

      const menu = menuDe('pause')!
      menu.value = 'talk'
      menu.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(appels).toContainEqual({
        chemin: 'sessions/override',
        entree: { sessionId: 'pause', action: 'talk' },
      })
      expect($('avis').textContent).toContain('conférence')
    })

    it('déduit l\'export de la décision appliquée, sans le redemander', async () => {
      // Le hub sert la keynote en conférence, en disant que c'est une décision :
      // l'export, lui, la donne pour une pause. Le menu doit donc proposer de
      // la lui rendre, pas de la re-déclarer conférence.
      await ouvrir({
        ...PLANNING,
        sessions: PLANNING.sessions.map((session) =>
          session.id === 'pause'
            ? { ...session, kind: 'talk', overriddenAs: 'talk' }
            : session),
      })

      const menu = menuDe('pause')!
      expect(entrees(menu)).toEqual([
        ['', 'Aucune — pause au programme'],
        ['talk', 'Considérer comme conférence'],
      ])
      expect(menu.value).toBe('talk')
    })

    it('envoie la décision au hub, puis relit le planning', async () => {
      await ouvrir()
      appels.length = 0

      const menu = menuDe('ses-1')!
      menu.value = 'break'
      menu.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(appels).toContainEqual({
        chemin: 'sessions/override',
        entree: { sessionId: 'ses-1', action: 'break' },
      })
      // Relu depuis le hub : c'est lui qui sert le programme corrigé, et le
      // reconstruire dans la page le ferait diverger de ce que voient les salles.
      expect(appels.some((appel) => appel.chemin === 'program/planning')).toBe(true)
      expect($('avis').textContent).toContain('break')
    })

    it('montre la décision en cours, et sert à la retirer', async () => {
      // Le hub sert déjà le créneau en break, en disant d'où vient ce break.
      await ouvrir({
        ...PLANNING,
        sessions: PLANNING.sessions.map((session) =>
          session.id === 'ses-1'
            ? { ...session, kind: 'break', feedbackUrl: null, overriddenAs: 'break' }
            : session),
      })


      const menu = menuDe('ses-1')!
      expect(menu.value).toBe('break')

      appels.length = 0
      menu.value = ''
      menu.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(appels).toContainEqual({
        chemin: 'sessions/override',
        entree: { sessionId: 'ses-1', action: null },
      })
    })

    it("n'édite pas une pause héritée d'une autre salle", async () => {
      // Elle n'existe pas dans l'export : c'est le créneau d'origine qu'on
      // corrige, et la projection suit. Un menu sur la copie laisserait croire
      // à deux décisions indépendantes.
      await ouvrir({
        ...PLANNING,
        sessions: [
          ...PLANNING.sessions,
          {
            id: 'pause@hands-on', title: 'Déjeuner', speakers: [],
            startsAt: '2026-10-30T11:00:00.000Z', endsAt: '2026-10-30T12:00:00.000Z',
            roomId: 'hands-on', roomName: 'Hands on', kind: 'break',
            feedbackUrl: null, sharedFrom: 'pause',
          },
        ],
      })

      expect(menuDe('pause@hands-on')).toBeNull()
      expect($('planning').textContent).toContain('héritée')
    })

    it('remet le menu où il était quand le hub refuse', async () => {
      await ouvrir()
      // Un créneau disparu du programme entre l'affichage et le clic : le menu
      // ne doit pas rester sur une décision que personne n'a enregistrée.
      vi.stubGlobal('fetch', vi.fn(async () =>
        new Response(JSON.stringify({ json: { message: 'Créneau inconnu' } }), { status: 404 })))

      const menu = menuDe('ses-1')!
      menu.value = 'break'
      menu.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(menu.value).toBe('')
      expect($('avis').className).toContain('erreur')
    })
  })
})

/**
 * Les comptes de l'événement.
 *
 * Réglage du hub et non constante du code : l'export amont ne porte que les
 * réseaux des speakers, et corriger un handle ne doit pas demander de rejouer
 * une release sur les trois machines de salle.
 */
describe('réseaux de l\'événement', () => {
  const REGLAGES = {
    autoEndEnabled: true,
    autoEndGraceMinutes: 5,
    programSourceUrl: null,
    socialLinks: [
      { network: 'Bluesky', handle: '@cloudnord.fr', url: 'https://bsky.app/profile/cloudnord.fr' },
    ],
  }

  let appels: { chemin: string; entree: unknown }[]

  function brancher(reglages: Record<string, unknown> = REGLAGES): void {
    appels = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const chemin = String(url).replace('/rpc/', '')
      appels.push({ chemin, entree: JSON.parse(String(init.body)).json })
      const json = chemin.startsWith('settings/') ? reglages : []
      return new Response(JSON.stringify({ json }), { status: 200 })
    }))
    localStorage.setItem('hub-admin', 'jeton')
    monterConsole()
    $('nav-reglages').click()
  }

  const attendre = () => new Promise((resolve) => setTimeout(resolve, 20))

  it('affiche les comptes déjà enregistrés', async () => {
    brancher()
    await attendre()

    const champs = [...$('reseaux').querySelectorAll('input')] as HTMLInputElement[]
    expect(champs.map((champ) => champ.value)).toEqual([
      'Bluesky', '@cloudnord.fr', 'https://bsky.app/profile/cloudnord.fr',
    ])
  })

  it('le dit quand il n\'y en a aucun', async () => {
    // Une zone vide laisserait croire à un panneau cassé, alors que c'est un
    // état légitime — la boucle saute simplement sa page.
    brancher({ ...REGLAGES, socialLinks: [] })
    await attendre()

    expect($('reseaux').textContent).toContain('Aucun compte déclaré')
  })

  it('ajoute et enregistre un compte', async () => {
    brancher({ ...REGLAGES, socialLinks: [] })
    await attendre()
    $('btn-reseau-ajouter').click()

    const champs = [...$('reseaux').querySelectorAll('input')] as HTMLInputElement[]
    const saisir = (champ: HTMLInputElement, valeur: string) => {
      champ.value = valeur
      champ.dispatchEvent(new Event('input'))
    }
    saisir(champs[0]!, 'LinkedIn')
    saisir(champs[1]!, 'Cloud Nord')
    saisir(champs[2]!, 'https://www.linkedin.com/company/cloud-nord')
    $('btn-reseaux').click()
    await attendre()

    expect(appels).toContainEqual({
      chemin: 'settings/update',
      entree: {
        socialLinks: [
          { network: 'LinkedIn', handle: 'Cloud Nord', url: 'https://www.linkedin.com/company/cloud-nord' },
        ],
      },
    })
  })

  it('écarte une ligne laissée vide', async () => {
    // Ajouter une ligne puis se raviser est un geste normal ; le hub, lui,
    // refuserait une URL vide et l'enregistrement entier échouerait.
    brancher({ ...REGLAGES, socialLinks: [] })
    await attendre()
    $('btn-reseau-ajouter').click()
    $('btn-reseaux').click()
    await attendre()

    expect(appels).toContainEqual({ chemin: 'settings/update', entree: { socialLinks: [] } })
  })

  it('retire un compte', async () => {
    brancher()
    await attendre()
    ;($('reseaux').querySelector('button') as HTMLButtonElement).click()

    expect($('reseaux').textContent).toContain('Aucun compte déclaré')
  })
})

/**
 * Le panneau « L'événement ».
 *
 * Il existe pour que le dépôt n'ait pas à connaître l'événement qu'il sert. Le
 * cas normal est qu'il reste **vide** : le hub lit le nom dans le programme
 * importé. Ce qui se teste ici est donc surtout ce qui permet de relâcher un
 * réglage — sans ça, le renseigner une fois serait un aller sans retour.
 */
describe('identité de l\'événement, dans la console', () => {
  const IDENTITE = {
    resolved: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
    derived: { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' },
  }
  const REGLAGES = {
    autoEndEnabled: true,
    autoEndGraceMinutes: 5,
    programSourceUrl: null,
    socialLinks: [],
    eventName: null,
    eventShortName: null,
    openFeedbackProjectId: null,
  }

  let appels: { chemin: string; entree: unknown }[]

  function brancher(reglages: Record<string, unknown> = REGLAGES): void {
    appels = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const chemin = String(url).replace('/rpc/', '')
      appels.push({ chemin, entree: JSON.parse(String(init.body)).json })
      const json = chemin.startsWith('settings/')
        ? reglages
        : chemin === 'event/identity'
          ? IDENTITE
          : []
      return new Response(JSON.stringify({ json }), { status: 200 })
    }))
    localStorage.setItem('hub-admin', 'jeton')
    monterConsole({ event: IDENTITE })
    $('nav-reglages').click()
  }

  const attendre = () => new Promise((resolve) => setTimeout(resolve, 20))

  it('laisse les champs vides et montre la déduction en repère', async () => {
    brancher()
    await attendre()

    // Pré-remplir avec la valeur déduite ferait croire qu'elle est figée — et
    // le premier enregistrement l'aurait effectivement figée : le nom cesserait
    // de suivre les imports suivants.
    expect(($('event-nom') as HTMLInputElement).value).toBe('')
    expect(($('event-nom') as HTMLInputElement).placeholder).toBe('Cloud Nord 2026')
    expect(($('event-nom-court') as HTMLInputElement).placeholder).toBe('Cloud Nord')
    expect($('event-aide').textContent).toContain('Déduit du programme importé')
  })

  it('enregistre un nom qui contredit l\'export amont', async () => {
    brancher()
    await attendre()
    ;($('event-nom') as HTMLInputElement).value = 'Cloud Nord — répétition'
    ;($('event-openfeedback') as HTMLInputElement).value = 'cloud-nord-2026'
    $('btn-event').click()
    await attendre()

    expect(appels).toContainEqual({
      chemin: 'settings/update',
      entree: {
        eventName: 'Cloud Nord — répétition',
        eventShortName: null,
        openFeedbackProjectId: 'cloud-nord-2026',
      },
    })
  })

  it('relâche un réglage quand on vide le champ', async () => {
    // Distinguer « vide » de « absent » est tout l'intérêt : sans ça, on ne
    // pourrait plus jamais revenir au nom du programme.
    brancher({ ...REGLAGES, eventName: 'Cloud Nord — répétition' })
    await attendre()
    expect(($('event-nom') as HTMLInputElement).value).toBe('Cloud Nord — répétition')
    expect($('event-aide').textContent).toContain('Nom imposé ici')

    ;($('event-nom') as HTMLInputElement).value = '   '
    $('btn-event').click()
    await attendre()

    expect(appels).toContainEqual({
      chemin: 'settings/update',
      entree: { eventName: null, eventShortName: null, openFeedbackProjectId: null },
    })
  })

  it('titre la console du nom de l\'événement', async () => {
    brancher()
    await attendre()

    expect($('titre-console').textContent).toBe('Cloud Nord 2026 — console hub')
  })
})

/**
 * Resynchronisation des salles.
 *
 * Le geste part vers des machines qu'on ne voit pas, et porte à toutes les
 * salles par défaut : il ne doit pas tenir en un clic.
 */
describe('resynchronisation des salles', () => {
  let appels: { chemin: string; entree: unknown }[]

  const SALLES = [
    { id: 'track-1', name: 'Track #1' },
    { id: 'track-2', name: 'Track #2' },
  ]

  function brancher(): void {
    appels = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const chemin = String(url).replace('/rpc/', '')
      appels.push({ chemin, entree: JSON.parse(String(init.body)).json })
      const json =
        chemin === 'rooms/list'
          ? SALLES
          : chemin === 'rooms/resync'
            ? { ok: true, rooms: 2 }
            : chemin.startsWith('settings/')
              ? { autoEndEnabled: true, autoEndGraceMinutes: 5, socialLinks: [] }
              : []
      return new Response(JSON.stringify({ json }), { status: 200 })
    }))
    monterConsole()
    $('nav-reglages').click()
  }

  const attendre = () => new Promise((resolve) => setTimeout(resolve, 20))

  it('propose les salles du hub, « toutes » en tête', async () => {
    brancher()
    await attendre()

    const choix = $('resync-salle') as HTMLSelectElement
    expect([...choix.options].map((option) => option.textContent)).toEqual([
      'Toutes les salles',
      'Track #1',
      'Track #2',
    ])
    // Le défaut est le cas le plus large : raison de plus pour confirmer.
    expect(choix.value).toBe('')
  })

  it('ne demande rien avant confirmation', async () => {
    brancher()
    await attendre()

    $('btn-resync').click()
    await attendre()

    expect(affiche('confirmer-resync')).toBe(true)
    expect(appels.some((appel) => appel.chemin === 'rooms/resync')).toBe(false)
  })

  it('nomme la salle visée plutôt que de la sous-entendre', async () => {
    brancher()
    await attendre()

    ;($('resync-salle') as HTMLSelectElement).value = 'track-2'
    $('btn-resync').click()

    expect($('resync-texte').textContent).toContain('Track #2')
  })

  it('envoie la demande une fois confirmée', async () => {
    brancher()
    await attendre()

    ;($('resync-salle') as HTMLSelectElement).value = 'track-1'
    $('btn-resync').click()
    $('resync-confirmer').click()
    await attendre()

    expect(appels).toContainEqual({ chemin: 'rooms/resync', entree: { roomId: 'track-1' } })
    // La modale se referme : la laisser ouverte ferait renvoyer la demande.
    expect(affiche('confirmer-resync')).toBe(false)
    expect($('avis').textContent).toContain('Track #1')
  })

  it('vise toutes les salles quand aucune n\'est choisie', async () => {
    brancher()
    await attendre()

    $('btn-resync').click()
    expect($('resync-texte').textContent).toContain('toutes les salles')
    $('resync-confirmer').click()
    await attendre()

    expect(appels).toContainEqual({ chemin: 'rooms/resync', entree: { roomId: null } })
    expect($('avis').textContent).toContain('2 salle(s)')
  })

  it('renonce sans rien envoyer', async () => {
    brancher()
    await attendre()

    $('btn-resync').click()
    $('resync-annuler').click()
    await attendre()

    expect(affiche('confirmer-resync')).toBe(false)
    expect(appels.some((appel) => appel.chemin === 'rooms/resync')).toBe(false)
  })
})

/**
 * Rapatriement des rushes, depuis la console.
 *
 * L'onglet répond à une seule question, et c'est la dernière de la journée :
 * « peut-on démonter cette salle ? ». Un rush qui n'est pas encore parti n'est
 * nulle part ailleurs que sur un disque qu'on s'apprête à débrancher, et
 * personne ne le saura avant de chercher la VOD des semaines plus tard.
 *
 * D'où ce que ces tests tiennent : que la page dise laquelle des trois
 * situations elle décrit — pas de clés, clés sans bucket, prêt —, parce
 * qu'elles ne se corrigent pas au même endroit ; et qu'aucun secret du stockage
 * ne transite par une console qu'on ouvre depuis un téléphone.
 */
describe('onglet VOD', () => {
  const STATUT_PRET = {
    configure: true,
    endpoint: 'https://s3.exemple.test',
    bucket: 'rushes',
    prefix: 'cn26',
    politique: {
      actif: true,
      debitMaxOctetsS: 2_048_000,
      cpuMax: 0.7,
      margeConferenceMinutes: 10,
      taillePartMo: 8,
    },
  }

  const LIGNE = {
    roomId: 'track-1',
    roomName: 'Track #1',
    file: '2026-10-30_track1_1000_honeyswamp.mkv',
    kind: 'rush',
    sessionId: 'ses-1',
    objectKey: 'cn26/2026-10-30/track-1/2026-10-30_track1_1000_honeyswamp.mkv',
    state: 'echoue',
    sizeBytes: 1000,
    bytesSent: 250,
    debitOctetsS: null,
    startedAt: '2026-10-30T11:00:00.000Z',
    lastProgressAt: '2026-10-30T11:01:00.000Z',
    finishedAt: null,
    attempts: 3,
    lastError: 'Le stockage a refusé (AccessDenied) : quota dépassé',
  }

  let envoyees: { chemin: string; entree: unknown }[] = []

  function servir(statut: unknown, lignes: unknown[] = []): void {
    envoyees = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        const chemin = String(url).replace('/rpc/', '')
        if (init?.body != null) {
          envoyees.push({ chemin, entree: (JSON.parse(init.body) as { json: unknown }).json })
        }
        const json =
          chemin === 'vod/status'
            ? statut
            : chemin === 'vod/uploads'
              ? lignes
              : chemin === 'rooms/list'
                ? [{ id: 'track-1', name: 'Track #1' }]
                : chemin === 'program/globalBreak'
                  ? null
                  // Le panneau du stockage vit dans les Réglages : les ouvrir
                  // charge aussi le reste de l'onglet, qui attend un objet.
                  : chemin === 'settings/get'
                    ? { autoEndEnabled: true, autoEndGraceMinutes: 10, socialLinks: [] }
                    : []
        return new Response(JSON.stringify({ json }), { status: 200 })
      }),
    )
    monterConsole()
  }

  const attendre = () => new Promise((resolve) => setTimeout(resolve, 0))

  async function ouvrir(statut: unknown, lignes: unknown[] = []): Promise<void> {
    servir(statut, lignes)
    $('nav-vod').click()
    await attendre()
    await attendre()
  }

  /**
   * Le stockage se règle dans les Réglages, pas dans l'onglet VOD.
   *
   * L'onglet ne garde que ce qui se regarde le jour même — l'avancement et la
   * relance ; ce qui se pose une fois pour l'édition a rejoint le reste des
   * réglages.
   */
  async function ouvrirStockage(statut: unknown): Promise<void> {
    servir(statut)
    $('nav-reglages').click()
    await attendre()
    await attendre()
  }

  it('a son onglet et son adresse, comme les autres', async () => {
    await ouvrir(STATUT_PRET)
    expect(estVisible('vue-vod')).toBe(true)
    expect(estVisible('vue-exploitation')).toBe(false)
    // Un onglet est une adresse : rafraîchir doit revenir dessus, et le lien
    // s'envoyer à un collègue qui démonte la salle d'à côté.
    expect(globalThis.location.pathname).toBe('/admin/vod')
  })

  it('règle le stockage dans les Réglages, et garde la relance dans l\'onglet', async () => {
    // Deux moments différents : le bucket et le rythme se posent une fois pour
    // l'édition, avec le reste des réglages ; l'avancement se regarde le jour
    // même, salle par salle, pendant qu'on démonte.
    await ouvrirStockage(STATUT_PRET)

    expect($('vue-reglages').contains($('vod-bucket'))).toBe(true)
    expect($('vue-reglages').contains($('btn-vod-eprouver'))).toBe(true)
    expect($('vue-vod').contains($('vod-bucket'))).toBe(false)
    expect($('vue-vod').contains($('btn-vod-relancer'))).toBe(true)
  })

  it('ne demande plus le stockage pour afficher les téléversements', async () => {
    // L'onglet ne porte plus le formulaire : l'interroger toutes les dix
    // secondes solliciterait le hub pour un panneau qui n'est pas à l'écran.
    servir(STATUT_PRET, [LIGNE])
    const mock = globalThis.fetch as unknown as { mock: { calls: [string][] }; mockClear: () => void }
    await attendre()
    mock.mockClear()

    $('nav-vod').click()
    await attendre()
    await attendre()

    const urls = mock.mock.calls.map((appel) => String(appel[0]))
    expect(urls.some((url) => url.includes('vod/uploads'))).toBe(true)
    expect(urls.some((url) => url.includes('vod/status'))).toBe(false)
  })

  it('dit qu\'il n\'y a pas de clés, et où elles se posent', async () => {
    // Le cas normal : un hub d'événement n'a pas forcément de stockage. Sans
    // cette phrase, on remplirait le formulaire en se demandant pourquoi rien
    // ne part — et les clés ne se règlent justement pas ici.
    await ouvrirStockage({ configure: false, endpoint: null, bucket: null, prefix: null, politique: STATUT_PRET.politique })

    const texte = $('vod-etat').textContent ?? ''
    expect(texte).toContain('Aucun stockage S3 configuré')
    expect(texte).toContain('S3_ACCESS_KEY_ID')
  })

  it('distingue « pas de clés » de « pas de bucket »', async () => {
    // L'état le plus déroutant des trois : les clés sont là, la page s'ouvre,
    // et rien ne part. Les deux causes ne se corrigent pas au même endroit —
    // l'une dans un fichier d'environnement, l'autre dans le champ du dessous.
    await ouvrirStockage({ ...STATUT_PRET, configure: false, bucket: null })

    const texte = $('vod-etat').textContent ?? ''
    expect(texte).toContain('aucun bucket')
    expect(texte).not.toContain('S3_ACCESS_KEY_ID')
  })

  it('relit les réglages du hub dans ses champs', async () => {
    await ouvrirStockage(STATUT_PRET)

    expect(($('vod-bucket') as HTMLInputElement).value).toBe('rushes')
    expect(($('vod-prefixe') as HTMLInputElement).value).toBe('cn26')
    expect(($('vod-auto') as HTMLInputElement).checked).toBe(true)
    // Saisi en kilo-octets par seconde, stocké en octets : c'est l'unité dans
    // laquelle un débit réseau se pense, pas celle dans laquelle il se compte.
    expect(($('vod-debit') as HTMLInputElement).value).toBe('2000')
    expect(($('vod-cpu') as HTMLInputElement).value).toBe('70')
  })

  it('enregistre la politique dans les unités du contrat', async () => {
    await ouvrirStockage(STATUT_PRET)
    ;($('vod-debit') as HTMLInputElement).value = '500'
    ;($('vod-cpu') as HTMLInputElement).value = '60'
    ;($('btn-vod-reglages') as HTMLButtonElement).click()
    await attendre()

    const envoi = envoyees.find((appel) => appel.chemin === 'settings/update')
    expect(envoi?.entree).toMatchObject({
      vodBucket: 'rushes',
      vodPrefix: 'cn26',
      vodPolitique: { debitMaxOctetsS: 512_000, cpuMax: 0.6, actif: true },
    })
  })

  it('rend un plafond vide comme « pas de plafond », et non comme zéro', async () => {
    await ouvrirStockage(STATUT_PRET)
    ;($('vod-debit') as HTMLInputElement).value = ''
    ;($('btn-vod-reglages') as HTMLButtonElement).click()
    await attendre()

    // Zéro voudrait dire « aucun octet par seconde », c'est-à-dire un
    // téléversement qui n'avance jamais et que personne ne saurait expliquer.
    const envoi = envoyees.find((appel) => appel.chemin === 'settings/update')
    expect((envoi?.entree as { vodPolitique: { debitMaxOctetsS: unknown } }).vodPolitique.debitMaxOctetsS).toBeNull()
  })

  it('montre l\'erreur du stockage telle qu\'elle est venue', async () => {
    await ouvrir(STATUT_PRET, [LIGNE])

    const texte = $('vod-lignes').textContent ?? ''
    expect(texte).toContain('Track #1')
    expect(texte).toContain('en échec')
    expect(texte).toContain('25 %')
    // « AccessDenied » est le seul mot qu'on puisse porter à qui tient le
    // bucket : le traduire le ferait perdre.
    expect(texte).toContain('AccessDenied')
  })

  it('relance un fichier précis, et pas la salle entière', async () => {
    await ouvrir(STATUT_PRET, [LIGNE])
    envoyees = []
    ;($('vod-lignes').querySelector('[data-vod-relancer]') as HTMLButtonElement).click()
    await attendre()

    expect(envoyees.find((appel) => appel.chemin === 'vod/request')?.entree).toEqual({
      roomId: 'track-1',
      file: '2026-10-30_track1_1000_honeyswamp.mkv',
    })
  })

  it('ne propose pas de relancer ce qui est déjà arrivé', async () => {
    // Repayer trois gigaoctets sur le réseau de l'événement au premier clic
    // distrait est exactement ce qu'on évite.
    await ouvrir(STATUT_PRET, [{ ...LIGNE, state: 'termine', bytesSent: LIGNE.sizeBytes }])
    expect($('vod-lignes').querySelector('[data-vod-relancer]')).toBeNull()
  })

  it('refuse un « tout relancer » sans salle, plutôt que de ne rien faire', async () => {
    await ouvrir(STATUT_PRET, [LIGNE])
    envoyees = []
    ;($('btn-vod-relancer') as HTMLButtonElement).click()
    await attendre()

    // La demande descend vers une machine précise : sans salle choisie, il n'y
    // a personne à qui parler, et un bouton qui ne fait rien se reclique.
    expect(envoyees.find((appel) => appel.chemin === 'vod/request')).toBeUndefined()
  })

  it('éprouve la connexion et rend le verdict étape par étape', async () => {
    await ouvrirStockage(STATUT_PRET)
    const appels: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const chemin = String(url).replace('/rpc/', '')
        appels.push(chemin)
        const json =
          chemin === 'vod/check'
            ? {
                ok: false,
                etapes: [
                  { nom: 'joindre', ok: true, detail: null },
                  { nom: 'authentifier', ok: false, detail: 'AccessDenied : pas le droit d\'écrire' },
                ],
              }
            : chemin === 'vod/status'
              ? STATUT_PRET
              : []
        return new Response(JSON.stringify({ json }), { status: 200 })
      }),
    )
    ;($('btn-vod-eprouver') as HTMLButtonElement).click()
    await attendre()
    await attendre()

    expect(appels).toContain('vod/check')
    const verdict = $('vod-controle').textContent ?? ''
    // Jusqu'où on est allé compte autant que là où on s'est arrêté : savoir que
    // le stockage répond écarte d'emblée le pare-feu et le certificat.
    expect(verdict).toContain('Joindre le stockage')
    expect(verdict).toContain('Clés et bucket')
    // Et le code du stockage, repris tel quel : c'est le seul mot qu'on puisse
    // porter à qui tient le bucket.
    expect(verdict).toContain('AccessDenied')
  })

  it('n\'offre rien à éprouver quand le hub n\'a pas de clés', async () => {
    // Un bouton qui échouerait à chaque clic est pire qu'un bouton grisé, et
    // le panneau dit déjà en haut ce qui manque et où le poser.
    await ouvrirStockage({ configure: false, endpoint: null, bucket: null, prefix: null, politique: STATUT_PRET.politique })
    expect(($('btn-vod-eprouver') as HTMLButtonElement).disabled).toBe(true)
  })

  it('ne fait transiter aucun secret du stockage', async () => {
    // Cette console s'ouvre depuis un téléphone, sur le réseau de l'événement.
    // Ce qu'elle affiche du stockage se limite à son adresse et à son bucket.
    await ouvrir(STATUT_PRET, [LIGNE])
    const rendu = document.documentElement.innerHTML
    expect(rendu).not.toMatch(/S3_SECRET_ACCESS_KEY\s*[:=]/)
    expect(rendu).not.toContain('secretAccessKey')
  })
})
