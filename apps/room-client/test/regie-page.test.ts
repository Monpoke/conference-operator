/// <reference lib="dom" />
// La lib DOM est déclarée ici seulement : l'ajouter au tsconfig laisserait le
// code serveur appeler `document` sans que rien ne proteste.
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aplatirCouchesHtml } from '@cloudnord/ui'
import { renderRegiePage } from '../src/core/regie-page.js'
import type { DisplayPayload } from '../src/core/display-server.js'

/**
 * Comportement de la régie dans un vrai DOM.
 *
 * Ce niveau de test manquait, et son absence a coûté cher : une apostrophe mal
 * échappée dans le template avait cassé *l'intégralité* du script, donc tous
 * les boutons à la fois, sans que rien ne le signale.
 */
const ETAT = {
  state: {
    mode: 'sponsors',
    message: null,
    sceneRole: 'HOLD',
    connectivity: 'ONLINE',
    roomId: 'track-1',
    contentHash: 'h',
    currentSession: {
      id: 'ses-1',
      title: 'HoneySwamp',
      startsAt: '2026-10-30T10:00:00.000Z',
      endsAt: '2026-10-30T10:50:00.000Z',
      startsAtMs: Date.parse('2026-10-30T10:00:00Z'),
      endsAtMs: Date.parse('2026-10-30T10:50:00Z'),
      kind: 'talk',
      speakers: [{ name: 'Steven', company: null }],
    },
    nextSession: null,
    targetSession: {
      id: 'ses-1',
      title: 'HoneySwamp',
      startsAt: '2026-10-30T10:00:00.000Z',
      endsAt: '2026-10-30T10:50:00.000Z',
      startsAtMs: Date.parse('2026-10-30T10:00:00Z'),
      endsAtMs: Date.parse('2026-10-30T10:50:00Z'),
      kind: 'talk',
      speakers: [{ name: 'Steven', company: null }],
    },
    targetIsUpcoming: false,
    outboxDepth: 0,
    serverTimeOffsetMs: 0,
    recording: false,
    streaming: false,
    comments: [],
    sessionStates: {},
  },
  roomName: 'Track #1',
  event: null,
  timezone: 'Europe/Paris',
  sessions: [
    {
      id: 'ses-0',
      title: 'Accueil',
      startsAt: '2026-10-30T09:30:00.000Z',
      endsAt: '2026-10-30T10:00:00.000Z',
      startsAtMs: Date.parse('2026-10-30T09:30:00Z'),
      endsAtMs: Date.parse('2026-10-30T10:00:00Z'),
      kind: 'break',
      speakers: [],
    },
    {
      id: 'ses-1',
      title: 'HoneySwamp',
      startsAt: '2026-10-30T10:00:00.000Z',
      endsAt: '2026-10-30T10:50:00.000Z',
      startsAtMs: Date.parse('2026-10-30T10:00:00Z'),
      endsAtMs: Date.parse('2026-10-30T10:50:00Z'),
      kind: 'talk',
      speakers: [{ name: 'Steven', company: null }],
    },
  ],
  sponsorTiers: [],
  wall: { url: 'http://hub/mur?salle=track-1', qrSvg: '<svg></svg>' },
  diagnostics: {
    obs: { A: null, B: null },
    relaySourceRoomId: null,
    outboxDepth: 0,
    journal: [],
    recording: { active: false, markers: 0, startedAtMs: null },
    questions: [
      { id: 'q1', text: 'Comment gérez-vous les faux positifs ?', author: 'Camille', votes: 7 },
      { id: 'q2', text: 'Le code est-il ouvert ?', author: null, votes: 3 },
    ],
    questionsRefreshedAt: '2026-10-30T10:19:00.000Z',
    // Les questions se lisent rattachées à une conférence : sans ça, une liste
    // vide ne dit pas si personne n'a rien demandé ou si rien n'est piloté.
    questionsSession: { id: 'ses-1', title: 'HoneySwamp' },
    config: {
      obs: {
        A: { url: 'ws://127.0.0.1:4455', hasPassword: true },
        B: { url: 'ws://127.0.0.1:4456', hasPassword: false },
      },
      sceneRoles: { A: { LIVE: 'Direct', HOLD: 'Habillage', RELAY: 'Relais NDI' }, B: { TALK: 'Talk' } },
      displayPort: 7788,
      recordingRoot: null,
      fileSlug: 'track1',
      relaySourceRoomId: null,
      openFeedbackProjectId: 'cloud-nord-2026',
    },
    rooms: [
      { roomId: 'track-1', name: 'Track #1', connectivity: 'ONLINE', sceneRole: 'HOLD', recording: false, outboxDepth: 0, lastSeenAt: new Date().toISOString() },
      { roomId: 'track-2', name: 'Track #2', connectivity: 'OFFLINE', sceneRole: null, recording: false, outboxDepth: 7, lastSeenAt: null },
    ],
    roomsRefreshedAt: new Date().toISOString(),
  },
} as unknown as DisplayPayload

/** Programme de la salle voisine : un talk, puis une pause. */
const SESSIONS_TRACK_2 = [
  {
    id: 't2-a',
    title: 'Blind ops',
    startsAt: '2026-10-30T10:00:00.000Z',
    endsAt: '2026-10-30T10:50:00.000Z',
    startsAtMs: Date.parse('2026-10-30T10:00:00Z'),
    endsAtMs: Date.parse('2026-10-30T10:50:00Z'),
    kind: 'talk',
    speakers: [{ name: 'Nuno', company: null }],
  },
  {
    id: 't2-b',
    title: 'Pause café',
    startsAt: '2026-10-30T10:50:00.000Z',
    endsAt: '2026-10-30T11:10:00.000Z',
    startsAtMs: Date.parse('2026-10-30T10:50:00Z'),
    endsAtMs: Date.parse('2026-10-30T11:10:00Z'),
    kind: 'break',
    speakers: [],
  },
  {
    id: 't2-c',
    title: 'Houston',
    startsAt: '2026-10-30T11:10:00.000Z',
    endsAt: '2026-10-30T11:50:00.000Z',
    startsAtMs: Date.parse('2026-10-30T11:10:00Z'),
    endsAtMs: Date.parse('2026-10-30T11:50:00Z'),
    kind: 'talk',
    speakers: [],
  },
]

/**
 * Horloges posées par la page.
 *
 * Monter la régie réexécute son script : sans arrêter l'horloge de l'instance
 * précédente, celle-ci continue de réécrire le DOM — le même, retrouvé par
 * `getElementById` — avec les données de son propre montage. Défaut observé :
 * le flux des salles repartait à l'état monté en `beforeEach`, mais seulement
 * quand la suite tournait assez lentement pour laisser passer une seconde.
 */
const horloges: ReturnType<typeof setInterval>[] = []

function arreterHorloges(): void {
  for (const horloge of horloges.splice(0)) clearInterval(horloge)
}

function monterRegie(payload: DisplayPayload = ETAT): void {
  arreterHorloges()
  document.documentElement.innerHTML = aplatirCouchesHtml(renderRegiePage({ initialPayload: payload }))
  for (const script of document.querySelectorAll('script:not([type])')) {
    // eslint-disable-next-line no-new-func
    new Function(script.textContent ?? '')()
  }
}

afterEach(arreterHorloges)

/** Le flux des autres salles se remplit par `fetch` : il faut laisser tourner. */
const attendre = () => new Promise((resolve) => setTimeout(resolve, 10))

/**
 * Attend qu'une condition se réalise, sans figer un délai.
 *
 * Sert au bandeau de signalements, qui se vide sur le tic d'horloge de la page :
 * attendre une durée fixe rendrait le test dépendant de la charge de la machine.
 */
async function attendreQue(condition: () => boolean, limiteMs = 5_000): Promise<void> {
  const fin = Date.now() + limiteMs
  while (!condition() && Date.now() < fin) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Place la régie à un instant du programme, sans toucher à l'horloge du test. */
function a(instant: string, etat: Record<string, unknown> = {}): DisplayPayload {
  return {
    ...ETAT,
    state: { ...ETAT.state, serverTimeOffsetMs: Date.parse(instant) - Date.now(), ...etat },
  } as unknown as DisplayPayload
}

const $ = (id: string) => document.getElementById(id)!
let envoyees: unknown[]

beforeEach(() => {
  envoyees = []
  const poser = globalThis.setInterval
  vi.stubGlobal('setInterval', (...args: Parameters<typeof setInterval>) => {
    const horloge = poser(...args)
    horloges.push(horloge)
    return horloge
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (init?.body != null) envoyees.push(JSON.parse(init.body))
      if (url.startsWith('/display/sessions')) {
        const salle = new URL(url, 'http://local').searchParams.get('salle')
        return new Response(
          JSON.stringify({
            rooms: [
              { id: 'track-1', name: 'Track #1' },
              { id: 'track-2', name: 'Track #2' },
            ],
            sessions: salle === 'track-2' ? SESSIONS_TRACK_2 : [],
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ ok: true, message: 'fait' }), { status: 200 })
    }),
  )
  monterRegie()
})

describe('menu des écrans', () => {
  it('liste les surfaces servies, mur public compris', () => {
    const liens = [...$('liste-ecrans').querySelectorAll('a')]
    const cibles = liens.map((lien) => lien.getAttribute('href'))

    expect(cibles).toContain('/display/projector')
    expect(cibles).toContain('/display/overlay')
    expect(cibles).toContain('http://hub/mur?salle=track-1')
  })

  it('ouvre chaque écran dans un nouvel onglet', () => {
    // Ouvrir la projection dans la fenêtre de régie remplacerait les commandes
    // par l'écran de salle, en pleine intervention.
    for (const lien of $('liste-ecrans').querySelectorAll('a')) {
      expect(lien.getAttribute('target')).toBe('_blank')
    }
  })

  it('s\'ouvre et se referme', () => {
    const menu = $('menu-ecrans')
    expect(menu.classList.contains('ouvert')).toBe(false)

    $('btn-ecrans').click()
    expect(menu.classList.contains('ouvert')).toBe(true)

    document.dispatchEvent(new Event('click'))
    expect(menu.classList.contains('ouvert')).toBe(false)
  })
})

describe('encart de gauche', () => {
  it('affiche le programme de la salle par défaut', () => {
    expect($('encart-programme').classList.contains('actif')).toBe(true)
    expect($('encart-contenu').querySelector('.timeline')).toBeTruthy()
  })

  it('bascule sur les salles dans le même encart', () => {
    // Une seule zone, plusieurs contenus : c'est ce qui remplace l'ancien
    // panneau déplié en colonne de droite.
    $('encart-salles').click()

    const texte = $('encart-contenu').textContent ?? ''
    expect(texte).toContain('Track #1')
    expect(texte).toContain('Track #2')
    // La file d'attente d'une salle coupée est l'indicateur à surveiller.
    expect(texte).toContain('7 en attente')
    expect($('encart-programme').classList.contains('actif')).toBe(false)
  })

  it('le bouton d\'en-tête ouvre le même encart', () => {
    $('btn-salles').click()
    expect($('encart-salles').classList.contains('actif')).toBe(true)
  })

  it('propose les autres salles, jamais la sienne', () => {
    $('encart-autre').click()

    const choix = $('choix-autre-salle') as HTMLSelectElement
    expect(choix.hidden).toBe(false)
    const valeurs = [...choix.options].map((o) => o.value).filter(Boolean)
    expect(valeurs).toEqual(['track-2'])
  })

  it('n\'affiche le sélecteur que sur l\'onglet concerné', () => {
    expect(($('choix-autre-salle') as HTMLSelectElement).hidden).toBe(true)
    $('encart-autre').click()
    expect(($('choix-autre-salle') as HTMLSelectElement).hidden).toBe(false)
    $('encart-programme').click()
    expect(($('choix-autre-salle') as HTMLSelectElement).hidden).toBe(true)
  })
})

describe('signalements', () => {
  it('n\'affiche rien quand il n\'y a rien à signaler', () => {
    expect($('signalements').textContent).toBe('')
  })

  it('affiche une fin de conférence dans une autre salle', () => {
    monterRegie(a('2026-10-30T10:50:20Z', {
      notifications: [
        {
          id: 'n1',
          level: 'info',
          text: 'HoneySwamp vient de se terminer dans une autre salle',
          at: '2026-10-30T10:50:00.000Z',
        },
      ],
    }))

    expect($('signalements').textContent).toContain('vient de se terminer')
  })

  it('permet d\'écarter un signalement lu', async () => {
    monterRegie(a('2026-10-30T10:50:20Z', {
      notifications: [{ id: 'n1', level: 'info', text: 'coucou', at: '2026-10-30T10:50:00.000Z' }],
    }))

    ;($('signalements').querySelector('.fermer') as HTMLButtonElement).click()
    await attendre()

    expect(envoyees).toContainEqual({ action: 'notification.dismiss', id: 'n1' })
  })

  it('ne montre plus un signalement passé de date', () => {
    // Trente et une secondes : le runtime l'aura retiré au tic suivant, la page
    // n'attend pas pour cesser de l'afficher.
    monterRegie(a('2026-10-30T10:50:31Z', {
      notifications: [{ id: 'n1', level: 'info', text: 'coucou', at: '2026-10-30T10:50:00.000Z' }],
    }))

    expect($('signalements').textContent).toBe('')
  })

  it('efface le bandeau tout seul, sans rien recevoir', async () => {
    // Le cas réel : plus aucun état ne remonte, et le signalement doit partir
    // quand même. Posé à 29,4 s d'âge, il tombe au tic de la seconde suivante.
    monterRegie(a('2026-10-30T10:50:29.400Z', {
      notifications: [{ id: 'n1', level: 'info', text: 'coucou', at: '2026-10-30T10:50:00.000Z' }],
    }))
    expect($('signalements').textContent).toContain('coucou')

    await attendreQue(() => $('signalements').textContent === '')

    expect($('signalements').textContent).toBe('')
  })
})

describe('chronomètre de captation', () => {
  it('reste éteint hors enregistrement et s\'allume pendant', () => {
    // La teinte doit venir de la classe basculée par le JavaScript. En la
    // figeant dans le markup, le chronomètre restait gris en enregistrement —
    // exactement l'indication qu'on regarde pour savoir si ça tourne.
    const eteint = globalThis.getComputedStyle($('duree')).color
    expect($('duree').classList.contains('inactif')).toBe(true)

    monterRegie({
      ...ETAT,
      diagnostics: {
        ...(ETAT as unknown as { diagnostics: Record<string, unknown> }).diagnostics,
        recording: { active: true, markers: 0, startedAtMs: Date.now() - 5_000 },
      },
    } as unknown as DisplayPayload)

    expect($('duree').classList.contains('inactif')).toBe(false)
    expect(globalThis.getComputedStyle($('duree')).color).not.toBe(eteint)
  })
})

describe('temps restant au programme', () => {
  it('annonce les minutes restantes pendant le créneau', () => {
    // 10:20 : « HoneySwamp » court jusqu'à 10:50, il reste 30 minutes.
    monterRegie({
      ...ETAT,
      state: {
        ...ETAT.state,
        sessionStates: { 'ses-1': 'running' },
        serverTimeOffsetMs: Date.parse('2026-10-30T10:20:00Z') - Date.now(),
      },
    } as unknown as DisplayPayload)

    expect($('conf-detail').textContent).toMatch(/30 min restantes/)
  })

  it('passe en heures au-delà du créneau, plutôt qu\'en milliers de minutes', () => {
    // Vu sur un aperçu daté : « 100634 min restantes au programme ». Le calcul
    // était juste, l'affichage inexploitable.
    monterRegie({
      ...ETAT,
      state: {
        ...ETAT.state,
        serverTimeOffsetMs: Date.parse('2026-10-30T07:20:00Z') - Date.now(),
      },
    } as unknown as DisplayPayload)

    expect($('conf-detail').textContent).toMatch(/3 h 30 restantes/)
  })

  it('signale un dépassement plutôt que de compter à rebours dans le vide', () => {
    monterRegie({
      ...ETAT,
      state: {
        ...ETAT.state,
        sessionStates: { 'ses-1': 'running' },
        serverTimeOffsetMs: Date.parse('2026-10-30T11:02:00Z') - Date.now(),
      },
    } as unknown as DisplayPayload)

    // C'est cette information qui déclenche une décision.
    expect($('conf-detail').textContent).toMatch(/dépassement de 12 min/)
  })
})

describe('cycle de vie de la conférence', () => {
  it('propose de commencer un talk dont le créneau court déjà', () => {
    // « prête » plutôt qu'« à venir » : le créneau a commencé au programme,
    // c'est la décision de l'opérateur qui manque.
    expect($('badge-conf').textContent).toBe('prête')
    expect(($('btn-conf-demarrer') as HTMLButtonElement).disabled).toBe(false)
    expect(($('btn-conf-terminer') as HTMLButtonElement).disabled).toBe(true)
  })

  it('envoie la commande de démarrage', async () => {
    $('btn-conf-demarrer').click()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(envoyees).toContainEqual({ action: 'session.start' })
  })

  it('inverse les boutons quand le talk est en cours', () => {
    monterRegie({
      ...ETAT,
      state: { ...ETAT.state, sessionStates: { 'ses-1': 'running' } },
    } as unknown as DisplayPayload)

    expect($('badge-conf').textContent).toBe('en cours')
    expect(($('btn-conf-demarrer') as HTMLButtonElement).disabled).toBe(true)
    expect(($('btn-conf-terminer') as HTMLButtonElement).disabled).toBe(false)
  })

  it('n\'active rien sans conférence à piloter', () => {
    monterRegie({
      ...ETAT,
      state: { ...ETAT.state, currentSession: null, targetSession: null },
    } as unknown as DisplayPayload)

    expect(($('btn-conf-demarrer') as HTMLButtonElement).disabled).toBe(true)
    expect($('titre-conf').textContent).toContain('Aucune conférence')
  })

  it('reste pilotable entre deux talks', () => {
    /**
     * Le cas qui bloquait : à 14:50 le talk précédent vient de finir, le
     * suivant commence à 14:55. Rien n'est « en cours », mais c'est justement
     * le moment où l'opérateur veut démarrer — le speaker s'installe.
     */
    monterRegie({
      ...ETAT,
      state: {
        ...ETAT.state,
        currentSession: null,
        targetIsUpcoming: true,
        targetSession: {
          id: 'ses-2',
          title: 'Blind ops',
          startsAt: '2026-10-30T13:55:00.000Z',
          endsAt: '2026-10-30T14:15:00.000Z',
          startsAtMs: Date.parse('2026-10-30T13:55:00Z'),
          endsAtMs: Date.parse('2026-10-30T14:15:00Z'),
          kind: 'talk',
          speakers: [],
        },
      },
    } as unknown as DisplayPayload)

    expect(($('btn-conf-demarrer') as HTMLButtonElement).disabled).toBe(false)
    expect($('titre-conf').textContent).toContain('Blind ops')
    // L'horaire est rappelé : on doit savoir laquelle on s'apprête à démarrer.
    expect($('titre-conf').textContent).toContain('14:55')
    expect($('badge-conf').textContent).toBe('à venir')
  })
})

describe('commandes de scène et d\'écran', () => {
  it('envoie une bascule de scène', async () => {
    const boutons = [...$('scenes').querySelectorAll('button')]
    boutons.find((b) => b.textContent?.includes('Direct'))!.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(envoyees).toContainEqual({ action: 'scene.set', role: 'LIVE' })
  })

  it('répond aux raccourcis clavier', async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(envoyees).toContainEqual({ action: 'scene.set', role: 'LIVE' })
  })

  it('n\'affiche le relais que s\'il est configuré', () => {
    const sansRelais = [...$('scenes').querySelectorAll('button')].map((b) => b.textContent)
    expect(sansRelais.some((t) => t?.includes('Relais'))).toBe(false)

    monterRegie({
      ...ETAT,
      diagnostics: { ...ETAT.diagnostics!, relaySourceRoomId: 'track-2' },
    } as unknown as DisplayPayload)

    const avecRelais = [...$('scenes').querySelectorAll('button')].map((b) => b.textContent)
    expect(avecRelais.some((t) => t?.includes('Relais → track-2'))).toBe(true)
  })
})

/**
 * Ce que la régie doit montrer sans qu'on aille le chercher.
 *
 * L'écran de régie n'est pas toujours un grand moniteur : la version
 * précédente demandait de faire défiler la colonne de droite pour atteindre
 * l'enregistrement et la diffusion. Les programmes sont donc passés en modale,
 * et ce qui déclenche une décision — temps restant, conférence suivante, état
 * des autres salles — reste à l'écran.
 */
describe('consultation en modale', () => {
  it('démarre fermée : les commandes occupent tout l\'écran', () => {
    expect(document.body.dataset.modale).toBe('fermee')
  })

  it('s\'ouvre sur le programme, et se referme', () => {
    $('btn-programme').click()
    expect(document.body.dataset.modale).toBe('ouverte')
    expect($('encart-programme').classList.contains('actif')).toBe(true)
    expect($('encart-contenu').querySelector('.timeline')).toBeTruthy()

    $('btn-fermer-modale').click()
    expect(document.body.dataset.modale).toBe('fermee')
  })

  it('se referme à Échap, la main sur le clavier', () => {
    $('btn-salles').click()
    expect(document.body.dataset.modale).toBe('ouverte')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.body.dataset.modale).toBe('fermee')
  })

  it('laisse les commandes répondre modale ouverte', async () => {
    // Une conférence ne s'arrête pas parce qu'on consulte le programme.
    $('btn-programme').click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    await attendre()

    expect(envoyees).toContainEqual({ action: 'scene.set', role: 'LIVE' })
  })
})

describe('compte à rebours du créneau', () => {
  it('compte à la seconde pendant le talk', () => {
    // Instant décalé d'une demi-seconde : sur une frontière exacte, le
    // millième de seconde qui sépare la charge utile du rendu ferait basculer
    // l'arrondi, et le test échouerait une fois sur deux.
    monterRegie(a('2026-10-30T10:20:29.500Z', { sessionStates: { 'ses-1': 'running' } }))
    // 10:20:29,5 → 10:50 : vingt-neuf minutes et trente secondes.
    expect($('restant').textContent).toBe('29:30')
  })

  it('vire à l\'alerte en dépassement, signe compris', () => {
    monterRegie(a('2026-10-30T10:52:10.500Z', { sessionStates: { 'ses-1': 'running' } }))

    expect($('restant').textContent).toBe('−2:10')
    expect($('restant').className).toContain('text-alerte')
  })

  it('reste muet sans conférence à piloter', () => {
    monterRegie({
      ...ETAT,
      state: { ...ETAT.state, currentSession: null, targetSession: null },
    } as unknown as DisplayPayload)

    expect($('restant').textContent).toBe('--:--')
  })
})

describe('conférence suivante', () => {
  it('annonce celle qui vient après le créneau piloté', () => {
    // Elle ne se pilote pas encore, mais elle dit si on peut laisser filer.
    monterRegie({
      ...ETAT,
      sessions: [
        ...ETAT.sessions,
        {
          id: 'ses-2',
          title: 'Blind ops',
          startsAt: '2026-10-30T10:55:00.000Z',
          endsAt: '2026-10-30T11:15:00.000Z',
          startsAtMs: Date.parse('2026-10-30T10:55:00Z'),
          endsAtMs: Date.parse('2026-10-30T11:15:00Z'),
          kind: 'talk',
          speakers: [],
        },
      ],
    } as unknown as DisplayPayload)

    expect($('suivant').textContent).toContain('Blind ops')
    expect($('suivant').textContent).toContain('11:55')
  })

  it('le dit quand la journée est finie, plutôt que de rester vide', () => {
    expect($('suivant').textContent).toContain('Plus rien après')
  })
})

/**
 * Les noms, sur l'écran qui sert à parler au public.
 *
 * L'opérateur annonce au micro et cherche un prénom. Le titre du talk ne le
 * donne pas, et le programme complet est derrière une modale : deux clics au
 * moment précis où l'on s'adresse à la salle.
 */
describe('intervenants', () => {
  /** Le créneau piloté du fixture, à retoucher champ par champ. */
  const CIBLE = ETAT.state.targetSession as unknown as Record<string, unknown>

  it('affiche ceux de la conférence pilotée, sous son titre', () => {
    expect($('qui-conf').textContent).toContain('Steven')
    expect(($('qui-conf') as HTMLElement).hidden).toBe(false)
  })

  it('les sépare quand ils sont plusieurs', () => {
    monterRegie({
      ...ETAT,
      state: {
        ...ETAT.state,
        targetSession: {
          ...CIBLE,
          speakers: [{ name: 'Steven', company: null }, { name: 'Nuno', company: null }],
        },
      },
    } as unknown as DisplayPayload)

    expect($('qui-conf').textContent).toBe('Steven · Nuno')
  })

  it('se retire sur un créneau sans speaker, plutôt que de laisser un vide', () => {
    // Une ligne vide sous « Pause déjeuner » ferait chercher un nom absent.
    monterRegie({
      ...ETAT,
      state: {
        ...ETAT.state,
        targetSession: { ...CIBLE, kind: 'break', speakers: [] },
      },
    } as unknown as DisplayPayload)

    expect(($('qui-conf') as HTMLElement).hidden).toBe(true)
    expect($('qui-conf').textContent).toBe('')
  })

  it('donne aussi celui de la conférence suivante', () => {
    monterRegie({
      ...ETAT,
      sessions: [
        ...ETAT.sessions,
        {
          id: 'ses-2',
          title: 'Blind ops',
          startsAt: '2026-10-30T10:55:00.000Z',
          endsAt: '2026-10-30T11:15:00.000Z',
          startsAtMs: Date.parse('2026-10-30T10:55:00Z'),
          endsAtMs: Date.parse('2026-10-30T11:15:00Z'),
          kind: 'talk',
          speakers: [{ name: 'Nuno', company: null }],
        },
      ],
    } as unknown as DisplayPayload)

    expect($('suivant').textContent).toContain('Blind ops')
    expect($('suivant').textContent).toContain('Nuno')
  })
})

describe('flux des autres salles', () => {
  it('annonce le talk en cours à côté et son heure de fin', async () => {
    monterRegie(a('2026-10-30T10:20:00Z'))
    await attendre()

    const texte = $('flux-salles').textContent ?? ''
    expect(texte).toContain('Track #2')
    expect(texte).toContain('Blind ops')
    expect(texte).toContain('fin 11:50')
    // Jamais sa propre salle : elle est déjà partout ailleurs à l'écran.
    expect(texte).not.toContain('Track #1')
  })

  it('signale la salle qui touche à sa fin', async () => {
    // Le cas qui décide : on ne lance pas un talk quand la salle d'à côté
    // s'apprête à déverser son public dans le couloir.
    monterRegie(a('2026-10-30T10:47:00Z'))
    await attendre()

    const salle = $('flux-salles').querySelector('[data-salle="track-2"]')!
    expect(salle.textContent).toContain('vers la fin')
    expect(salle.innerHTML).toContain('text-attention')
  })

  it('annonce la reprise quand le voisin est en pause', async () => {
    // 10:53 : le talk d'à côté est fini, sa salle se remplira à 12:10.
    monterRegie(a('2026-10-30T10:53:00Z'))
    await attendre()

    const salle = $('flux-salles').querySelector('[data-salle="track-2"]')!
    expect(salle.textContent).toContain('reprise 12:10')
  })

  it('reste muet sur le programme d\'une salle qu\'il ne connaît pas', async () => {
    // Le hub annonce une salle absente du programme local : mieux vaut le dire
    // que d\'inventer un créneau.
    monterRegie(a('2026-10-30T10:20:00Z', { roomId: 'track-2' }))
    await attendre()

    const salle = $('flux-salles').querySelector('[data-salle="track-1"]')!
    expect(salle.textContent).toContain('programme inconnu')
  })

  it('ouvre le programme de la salle cliquée', async () => {
    monterRegie(a('2026-10-30T10:20:00Z'))
    await attendre()

    ;($('flux-salles').querySelector('[data-salle="track-2"]') as HTMLElement).click()
    await attendre()

    expect(document.body.dataset.modale).toBe('ouverte')
    expect($('encart-autre').classList.contains('actif')).toBe(true)
    expect($('encart-contenu').textContent).toContain('Blind ops')
  })
})

describe('horloge du hub', () => {
  it('signale une heure simulée, que rien ne trahirait autrement', () => {
    monterRegie({
      ...ETAT,
      state: { ...ETAT.state, simulatedClock: true },
    } as unknown as DisplayPayload)

    expect(document.body.dataset.horloge).toBe('simulee')
  })

  it('ne signale rien quand l\'heure est réelle', () => {
    expect(document.body.dataset.horloge).toBe('reelle')
  })
})

/**
 * Configuration de la salle.
 *
 * Le formulaire écrit sur le hub, qui reste la source de vérité : ce qui se
 * règle ici est ce qui se constate devant les machines — adresses des deux OBS
 * et noms de scènes réels.
 */
const OBS_CONNECTE = {
  A: {
    instance: 'A',
    connected: true,
    currentSceneName: 'Habillage',
    currentRole: 'HOLD',
    unresolvedRoles: ['RELAY'],
    scenes: ['Direct', 'Habillage'],
    recording: false,
    streaming: false,
  },
  B: {
    instance: 'B',
    connected: false,
    currentSceneName: null,
    currentRole: null,
    unresolvedRoles: [],
    scenes: [],
    recording: false,
    streaming: false,
  },
}

/** Régie montée avec deux instances OBS observables, panneau de config ouvert. */
function ouvrirConfig(
  etat: Record<string, unknown> = {},
  diagnostics: Record<string, unknown> = {},
): void {
  monterRegie({
    ...ETAT,
    state: { ...ETAT.state, ...etat },
    diagnostics: { ...ETAT.diagnostics!, obs: OBS_CONNECTE, ...diagnostics },
  } as unknown as DisplayPayload)
  $('btn-config').click()
}

const envoye = (action: string) =>
  envoyees.find((e) => (e as { action: string }).action === action) as Record<string, unknown> | undefined

describe('configuration de la salle', () => {
  it('part fermée : les commandes d\'abord', () => {
    expect(document.body.dataset.config).toBe('fermee')
  })

  it('s\'ouvre pré-remplie de la configuration en vigueur', () => {
    ouvrirConfig()

    expect(document.body.dataset.config).toBe('ouverte')
    expect(($('cfg-url-A') as HTMLInputElement).value).toBe('ws://127.0.0.1:4455')
    expect(($('cfg-role-A-LIVE') as HTMLSelectElement).value).toBe('Direct')
    expect(($('cfg-slug') as HTMLInputElement).value).toBe('track1')
  })

  it('propose les scènes lues sur OBS', () => {
    ouvrirConfig()

    const options = [...($('cfg-role-A-HOLD') as HTMLSelectElement).options].map((o) => o.value)
    expect(options).toContain('Direct')
    expect(options).toContain('Habillage')
    // « Non configuré » est un choix légitime : un rôle peut ne pas exister ici.
    expect(options).toContain('')
  })

  it('garde la scène configurée qui n\'existe plus dans OBS', () => {
    // C'est précisément le défaut qu'on vient réparer : la faire disparaître de
    // la liste changerait la configuration à l'insu de l'opérateur.
    ouvrirConfig()

    const select = $('cfg-role-A-RELAY') as HTMLSelectElement
    expect(select.value).toBe('Relais NDI')
    expect(select.textContent).toContain("absente d'OBS")
  })

  it('affiche l\'état de chaque instance, rôles absents compris', () => {
    ouvrirConfig()

    expect($('config-etat-A').textContent).toContain('rôles absents : RELAY')
    expect($('config-etat-B').textContent).toBe('déconnecté')
  })

  it('envoie le réglage sans toucher au mot de passe laissé vide', async () => {
    // La page n'a jamais reçu le mot de passe : ne pas l'envoyer est la seule
    // façon de le conserver.
    ouvrirConfig()
    ;($('cfg-url-A') as HTMLInputElement).value = 'ws://192.168.1.20:4455'
    $('btn-config-enregistrer').click()
    await attendre()

    const envoi = envoye('room.configure') as { patch: { obs: { A: Record<string, unknown> } } }
    expect(envoi.patch.obs.A.url).toBe('ws://192.168.1.20:4455')
    expect('password' in envoi.patch.obs.A).toBe(false)
  })

  it('efface le mot de passe quand on le demande explicitement', async () => {
    ouvrirConfig()
    ;($('cfg-pass-vide-A') as HTMLInputElement).checked = true
    $('btn-config-enregistrer').click()
    await attendre()

    const envoi = envoye('room.configure') as { patch: { obs: { A: { password: string | null } } } }
    expect(envoi.patch.obs.A.password).toBeNull()
  })

  it('retire un rôle remis à « non configuré »', async () => {
    ouvrirConfig()
    ;($('cfg-role-A-RELAY') as HTMLSelectElement).value = ''
    $('btn-config-enregistrer').click()
    await attendre()

    const envoi = envoye('room.configure') as { patch: { sceneRoles: { A: Record<string, string> } } }
    expect('RELAY' in envoi.patch.sceneRoles.A).toBe(false)
    expect(envoi.patch.sceneRoles.A.LIVE).toBe('Direct')
  })

  it('n\'enregistre pas hors ligne, et dit pourquoi', () => {
    // Écrire en local irait plus vite mais mentirait : le prochain sync
    // repousse la configuration du hub et la saisie disparaîtrait sans un mot.
    ouvrirConfig({ connectivity: 'OFFLINE' })

    expect(($('btn-config-enregistrer') as HTMLButtonElement).disabled).toBe(true)
    expect($('config-avis').textContent).toContain('Hub injoignable')
  })

  it('connecte une instance, et elle seule', async () => {
    // Couper la captation pour appliquer un réglage de projection coûterait
    // une prise : chaque instance a son bouton.
    ouvrirConfig()
    $('cfg-connect-A').click()
    await attendre()

    expect(envoye('obs.connect')).toEqual({ action: 'obs.connect', instance: 'A' })
  })

  it('enregistre ce qui est à l\'écran avant de connecter', async () => {
    // Brancher sur les réglages d'avant la saisie donnerait un résultat que
    // personne ne pourrait s'expliquer.
    ouvrirConfig()
    ;($('cfg-url-A') as HTMLInputElement).value = 'ws://192.168.1.20:4455'
    $('cfg-connect-A').click()
    await attendre()

    const envoi = envoye('room.configure') as { patch: { obs: { A: { url: string } } } }
    expect(envoi.patch.obs.A.url).toBe('ws://192.168.1.20:4455')
    expect(envoye('obs.connect')).toBeTruthy()
  })

  it('connecte sans passer par le hub quand il ne répond pas', async () => {
    // Rouvrir OBS après un redémarrage n'a besoin de personne d'autre.
    ouvrirConfig({ connectivity: 'OFFLINE' })
    $('cfg-connect-A').click()
    await attendre()

    expect(envoye('room.configure')).toBeUndefined()
    expect(envoye('obs.connect')).toEqual({ action: 'obs.connect', instance: 'A' })
  })

  it('distingue connecter et reconnecter', () => {
    ouvrirConfig()

    expect($('cfg-connect-A').textContent).toBe('Reconnecter')
    expect($('cfg-connect-B').textContent).toBe('Connecter')
  })

  it('refuse de couper une instance qui enregistre', () => {
    ouvrirConfig({}, {
      obs: {
        ...OBS_CONNECTE,
        B: { ...OBS_CONNECTE.B, connected: true, recording: true },
      },
    })

    expect(($('cfg-connect-B') as HTMLButtonElement).disabled).toBe(true)
    expect($('cfg-connect-B').title).toContain('Enregistrement en cours')
  })

  it('reste reconnectable quand l\'instance est tombée en enregistrant', () => {
    // Le dernier état connu dit « enregistre », mais il date d'avant la
    // coupure : c'est justement le moment où il faut pouvoir reconnecter.
    ouvrirConfig({}, {
      obs: {
        ...OBS_CONNECTE,
        B: { ...OBS_CONNECTE.B, connected: false, recording: true },
      },
    })

    expect(($('cfg-connect-B') as HTMLButtonElement).disabled).toBe(false)
  })

  it('signale un réglage enregistré mais pas encore appliqué', () => {
    // Sans cela, un réglage juste resterait sans effet sans qu'on voie pourquoi.
    ouvrirConfig({}, {
      config: {
        ...(ETAT.diagnostics!.config as unknown as Record<string, unknown>),
        obs: {
          A: { url: 'ws://127.0.0.1:4455', hasPassword: true, pending: true },
          B: { url: 'ws://127.0.0.1:4456', hasPassword: false, pending: false },
        },
      },
    })

    expect($('config-etat-A').textContent).toContain('réglages non appliqués')
    expect($('config-etat-B').textContent).not.toContain('réglages non appliqués')
  })

  it('signale une instance simulée', () => {
    // Un enregistrement simulé ressemble en tout point à un vrai, sauf qu'il ne
    // capte rien : la méprise se paierait en VOD manquante.
    ouvrirConfig({}, {
      obs: { ...OBS_CONNECTE, A: { ...OBS_CONNECTE.A, simulated: true } },
    })

    expect($('config-simule-A').textContent).toBe('simulé')
    expect($('config-simule-B').textContent).toBe('')
    // Et pas seulement dans le panneau de configuration : aussi là où l'on
    // croit piloter OBS, sans rien avoir ouvert.
    expect($('simule-A').textContent).toBe('simulé')
    expect($('diag').textContent).toContain('simulé')
  })

  it('ne signale rien quand les instances sont réelles', () => {
    ouvrirConfig()

    expect($('simule-A').textContent).toBe('')
    expect($('simule-B').textContent).toBe('')
    expect($('diag').textContent).not.toContain('simulé')
  })

  it('se referme à Échap', () => {
    ouvrirConfig()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.body.dataset.config).toBe('fermee')
  })

  it('ne bascule pas la projection quand on tape dans une liste déroulante', async () => {
    // « l » est le raccourci du direct : dans un choix de scène, c'est une
    // frappe de navigation, pas une commande.
    ouvrirConfig()
    $('cfg-role-A-LIVE').dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    await attendre()

    expect(envoyees).not.toContainEqual({ action: 'scene.set', role: 'LIVE' })
  })
})

/**
 * Mode d'exécution, en en-tête de la régie.
 *
 * Rien en production des deux côtés : un badge permanent qui ne dit jamais
 * rien cesse d'être lu.
 */
describe('mode d\'exécution', () => {
  const avecMode = (salle: string, hub: string | null) =>
    monterRegie({
      ...ETAT,
      diagnostics: { ...ETAT.diagnostics!, mode: { salle, hub } },
    } as unknown as DisplayPayload)

  it('ne dit rien quand tout est en production', () => {
    avecMode('production', 'production')
    expect($('badge-mode').textContent).toBe('')
  })

  it('signale une salle de développement', () => {
    avecMode('dev', 'dev')
    expect($('badge-mode').textContent).toBe('mode dev')
  })

  it('alerte quand la salle et le hub ne sont pas du même côté', () => {
    // Le cas qui coûte cher : un poste qui simule tout, branché sur le hub de
    // l'événement, d'où il envoie de vraies commandes.
    avecMode('dev', 'production')

    expect($('badge-mode').textContent).toBe('dev · hub en production')
    expect($('badge-mode').innerHTML).toContain('text-alerte')
  })

  it('alerte aussi dans l\'autre sens', () => {
    avecMode('production', 'dev')

    expect($('badge-mode').textContent).toBe('hub en dev')
    expect($('badge-mode').innerHTML).toContain('text-alerte')
  })

  it('attend le premier sync avant de conclure', () => {
    // Hub pas encore joint : rien à comparer, et une alerte prématurée
    // apprendrait à ignorer le badge.
    avecMode('production', null)
    expect($('badge-mode').textContent).toBe('')
  })
})

/**
 * Questions du public, en régie.
 *
 * Le bandeau live sert de support : il se superpose à la vidéo sans
 * interrompre le talk — le speaker répond, la salle lit.
 */
describe('questions du public', () => {
  const ouvrirQuestions = () => {
    monterRegie(a('2026-10-30T10:20:00Z'))
    $('encart-questions').click()
  }

  it('liste les questions avec leurs votes', () => {
    ouvrirQuestions()

    const texte = $('encart-contenu').textContent ?? ''
    expect(texte).toContain('faux positifs')
    expect(texte).toContain('Camille')
    expect(texte).toContain('7')
  })

  it('met une question à l\'antenne, sur son propre canal', async () => {
    // Et non plus par `overlay.set` : ce canal-là porte les consignes de la
    // console, qui n'ont rien à faire dans la VOD. Les confondre interdisait
    // de montrer l'un sans risquer l'autre.
    ouvrirQuestions()
    ;($('encart-contenu').querySelector('.afficher') as HTMLButtonElement).click()
    await attendre()

    expect(envoyees).toContainEqual({
      action: 'question.set',
      text: 'Comment gérez-vous les faux positifs ?',
      author: 'Camille',
    })
  })

  it('retire la question de l\'antenne', async () => {
    ouvrirQuestions()
    $('btn-cacher-question').click()
    await attendre()

    expect(envoyees).toContainEqual({ action: 'question.set', text: null })
  })

  it('dit sur quelle conférence portent les questions', async () => {
    // Une liste bornée au talk piloté : sans le rappel, une liste vide se lit
    // « personne n'a rien demandé » alors qu'elle veut parfois dire « aucun
    // talk piloté ».
    ouvrirQuestions()

    expect($('encart-contenu').textContent).toContain('HoneySwamp')
  })

  it('relit la liste à l\'ouverture de l\'onglet', async () => {
    // La regarder sans la rafraîchir donnerait les questions d'il y a une heure.
    ouvrirQuestions()
    await attendre()

    expect(envoyees).toContainEqual({ action: 'questions.refresh' })
  })

  it('dit quand la liste a été relue', () => {
    ouvrirQuestions()

    expect($('encart-contenu').textContent).toContain('Relues 11:19')
  })
})
