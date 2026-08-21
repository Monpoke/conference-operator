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
    monterRegie({
      ...ETAT,
      state: {
        ...ETAT.state,
        notifications: [
          {
            id: 'n1',
            level: 'info',
            text: 'HoneySwamp vient de se terminer dans une autre salle',
            at: '2026-10-30T10:50:00.000Z',
          },
        ],
      },
    } as unknown as DisplayPayload)

    expect($('signalements').textContent).toContain('vient de se terminer')
  })

  it('permet d\'écarter un signalement lu', async () => {
    monterRegie({
      ...ETAT,
      state: {
        ...ETAT.state,
        notifications: [{ id: 'n1', level: 'info', text: 'coucou', at: '2026-10-30T10:50:00.000Z' }],
      },
    } as unknown as DisplayPayload)

    ;($('signalements').querySelector('.fermer') as HTMLButtonElement).click()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(envoyees).toContainEqual({ action: 'notification.dismiss', id: 'n1' })
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
