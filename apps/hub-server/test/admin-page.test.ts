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
  localStorage.setItem('cloudnord-admin', 'jeton-de-test')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ json: [] }), { status: 200 })),
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
    localStorage.setItem('cloudnord-admin', 'jeton')
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
    localStorage.setItem('cloudnord-admin', 'jeton')
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
    localStorage.setItem('cloudnord-admin', 'jeton')
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
    localStorage.setItem('cloudnord-admin', 'jeton')
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
    localStorage.setItem('cloudnord-admin', 'jeton')
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
    localStorage.setItem('cloudnord-admin', 'jeton')
  })

  it('propose le réglage, sans rien demander au chargement', () => {
    monterConsole()

    // Un navigateur qui voit la question arriver seule la refuse pour de bon.
    expect(NotificationFactice.demandes).toBe(0)
    expect($('btn-notifs').hidden).toBe(false)
  })

  it("demande la permission au clic, et retient le choix de l'appareil", async () => {
    monterConsole()

    $('btn-notifs').click()
    await vi.waitFor(() => expect(localStorage.getItem('cloudnord-notifs')).toBe('1'))
    expect(NotificationFactice.demandes).toBe(1)

    // Deuxième clic : on éteint, sans redemander la permission.
    $('btn-notifs').click()
    expect(localStorage.getItem('cloudnord-notifs')).toBeNull()
    expect(NotificationFactice.demandes).toBe(1)
  })

  it('ne dit rien du premier chargement, prévient du changement', async () => {
    localStorage.setItem('cloudnord-notifs', '1')
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
    localStorage.setItem('cloudnord-notifs', '1')
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

    expect(localStorage.getItem('cloudnord-admin')).toBeNull()
    expect($('console').hidden).toBe(true)
    expect($('connexion').hidden).toBe(false)
  })

  it('rend la main même quand le hub ne répond pas', async () => {
    // Un hub injoignable ne doit pas retenir un opérateur devant sa console.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('réseau coupé') }))
    monterConsole()

    ;($('btn-deconnexion') as HTMLButtonElement).click()
    await vi.waitFor(() => expect($('connexion').hidden).toBe(false))

    expect(localStorage.getItem('cloudnord-admin')).toBeNull()
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

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const chemin = String(url).replace('/rpc/', '')
      const json = chemin === 'rooms/statuses' ? SALLES : []
      return new Response(JSON.stringify({ json }), { status: 200 })
    }))
    localStorage.setItem('cloudnord-admin', 'jeton')
    monterConsole()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  /** Remonte la console sur une seule salle, dont le créneau est retouché. */
  async function avecCreneau(patch: {
    endsAt?: string | null
    remainingMs?: number | null
  }): Promise<void> {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const chemin = String(url).replace('/rpc/', '')
      const json = chemin === 'rooms/statuses'
        ? [{ ...SALLES[0], currentSession: { ...CRENEAU, ...patch } }]
        : []
      return new Response(JSON.stringify({ json }), { status: 200 })
    }))
    monterConsole()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

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
      },
    ],
  }

  /** Ouvre la console sur l'onglet Conférences, hub simulé. */
  async function ouvrir(planning: unknown = PLANNING, etats: unknown = ETATS): Promise<void> {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const chemin = String(url).replace('/rpc/', '')
      const json =
        chemin === 'sessions/states' ? etats
          : chemin === 'program/planning' ? planning
            : chemin === 'program/snapshots' ? [{ contentHash: 'a1b2c3', active: true }]
              : []
      return new Response(JSON.stringify({ json }), { status: 200 })
    }))
    localStorage.setItem('cloudnord-admin', 'jeton')
    monterConsole()
    $('nav-conferences').click()
    await new Promise((resolve) => setTimeout(resolve, 20))
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
    localStorage.setItem('cloudnord-admin', 'jeton')
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
