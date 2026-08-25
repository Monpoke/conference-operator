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
      { roomId: 'track-1', name: 'Track #1', connectivity: 'ONLINE', sceneRole: 'HOLD', recording: false, outboxDepth: 0, lastSeenAt: new Date().toISOString(), currentSessionId: 'ses-1', conference: 'en-cours' },
      { roomId: 'track-2', name: 'Track #2', connectivity: 'OFFLINE', sceneRole: null, recording: false, outboxDepth: 7, lastSeenAt: null, currentSessionId: null, conference: 'en-cours' },
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
function a(
  instant: string,
  etat: Record<string, unknown> = {},
  /** Programme de la salle, quand le test a besoin d'autre chose que celui par défaut. */
  sessions?: unknown[],
): DisplayPayload {
  return {
    ...ETAT,
    ...(sessions == null ? {} : { sessions }),
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

  /**
   * Ce qui se joue à côté, à l'heure du hub.
   *
   * La modale déroulait une liste de créneaux sans dire où on en était : il
   * fallait lire les horaires et faire le calcul de tête, en pleine régie.
   */
  it("surligne le créneau en cours de l'autre salle", async () => {
    // Houston court de 11:10 à 11:50 chez la voisine.
    monterRegie(a('2026-10-30T11:20:00Z'))
    $('encart-autre').click()
    const choix = $('choix-autre-salle') as HTMLSelectElement
    choix.value = 'track-2'
    choix.dispatchEvent(new Event('change'))
    await attendreQue(() => $('encart-contenu').querySelector('.actuel') != null)

    expect($('encart-contenu').querySelector('.actuel')?.textContent).toContain('Houston')
  })

  it("suit l'heure du hub, simulée comprise", async () => {
    /**
     * Le surlignage se calcule sur `serverTimeOffsetMs`, pas sur l'horloge de
     * la machine : c'est ce qui permet de dérouler la journée du 30 octobre des
     * mois à l'avance, et c'est là que le décalage se voit le plus vite.
     */
    monterRegie(a('2026-10-30T10:30:00Z'))
    $('encart-autre').click()
    const choix = $('choix-autre-salle') as HTMLSelectElement
    choix.value = 'track-2'
    choix.dispatchEvent(new Event('change'))
    await attendreQue(() => $('encart-contenu').querySelector('.actuel') != null)

    // À 10:30, c'est Blind ops — pas Houston, deux créneaux plus loin.
    expect($('encart-contenu').querySelector('.actuel')?.textContent).toContain('Blind ops')
  })

  it("ne surligne rien avant le début de la journée d'à côté", async () => {
    monterRegie(a('2026-10-30T08:00:00Z'))
    $('encart-autre').click()
    const choix = $('choix-autre-salle') as HTMLSelectElement
    choix.value = 'track-2'
    choix.dispatchEvent(new Event('change'))
    await attendreQue(() => ($('encart-contenu').textContent ?? '').includes('Blind ops'))

    // Surligner le premier créneau par défaut ferait croire qu'il a commencé.
    expect($('encart-contenu').querySelector('.actuel')).toBeNull()
  })

  /**
   * La pastille des salles portait la seule connectivité : une salle verte
   * pouvait déborder de dix minutes sans que rien ne le dise.
   */
  it('peint la conférence sur la pastille des salles', async () => {
    monterRegie(a('2026-10-30T11:20:00Z'))
    $('encart-salles').click()
    await attendreQue(() => $('encart-contenu').querySelectorAll('.pastille').length > 0)

    // Track #2 ne répond plus : pastille creuse, et on le dit.
    const texte = $('encart-contenu').textContent ?? ''
    expect(texte).toContain('salle muette')
    expect($('encart-contenu').innerHTML).toContain('muette')
  })

  /** Vue du hub avec un état de conférence choisi pour Track #2. */
  function avecEtatHub(conference: string, refreshedAt = new Date().toISOString()): DisplayPayload {
    return {
      ...ETAT,
      state: { ...ETAT.state, serverTimeOffsetMs: Date.parse('2026-10-30T10:20:00Z') - Date.now() },
      diagnostics: {
        ...ETAT.diagnostics,
        rooms: (ETAT.diagnostics?.rooms ?? []).map((salle: Record<string, unknown>) =>
          salle.roomId === 'track-2'
            ? { ...salle, connectivity: 'ONLINE', conference }
            : salle),
        roomsRefreshedAt: refreshedAt,
      },
    } as unknown as DisplayPayload
  }

  it('reprend du hub ce que la régie ne peut pas savoir', async () => {
    /**
     * Le cycle de vie des conférences d'à côté n'arrive pas jusqu'ici : seul le
     * hub sait qu'un créneau a commencé sans que personne ne l'ait lancé. Tant
     * que sa vue est fraîche, c'est elle qui fait foi.
     */
    monterRegie(avecEtatHub('retard'))
    $('encart-salles').click()
    await attendreQue(() => $('encart-contenu').querySelectorAll('.pastille').length > 1)

    // Le programme dirait « en cours » : personne n'a lancé le talk, et seul le
    // hub le sait.
    expect($('encart-contenu').textContent).toContain('retard au démarrage')
    expect($('encart-contenu').innerHTML).toContain('pastille retard')
  })

  it('retombe sur son cache quand la vue du hub date', async () => {
    // Pendant une coupure, la salle d'à côté finit quand même à l'heure prévue :
    // une vue périmée décrit un passé, le programme local décrit maintenant.
    monterRegie(avecEtatHub('retard', new Date(Date.now() - 5 * 60_000).toISOString()))
    $('encart-salles').click()
    await attendreQue(() => $('encart-contenu').querySelectorAll('.pastille').length > 1)

    // Le hub avait constaté ce retard cinq minutes plus tôt : le répéter
    // décrirait un passé. Le programme local, lui, décrit maintenant.
    expect($('encart-contenu').textContent).not.toContain('retard au démarrage')
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

  it('compte sur l\'horloge du hub quand elle fait foi', () => {
    /*
     * En développement, on déroule une journée en poussant l'horloge du hub.
     * Le chronomètre comptait les minutes passées devant l'écran pendant que la
     * durée finalement enregistrée, elle, suivait la journée simulée : deux
     * chiffres pour le même enregistrement.
     *
     * `startedAtCorrigeMs` porte la valeur et la règle — renseigné, on compte
     * sur l'horloge du hub, décalage compris.
     */
    const decalage = 3 * 3600_000
    monterRegie({
      ...ETAT,
      state: {
        ...(ETAT as unknown as { state: Record<string, unknown> }).state,
        serverTimeOffsetMs: decalage,
      },
      diagnostics: {
        ...(ETAT as unknown as { diagnostics: Record<string, unknown> }).diagnostics,
        recording: {
          active: true,
          markers: 0,
          startedAtMs: Date.now() - 5_000,
          // Départ posé vingt minutes plus tôt sur l'horloge du hub.
          startedAtCorrigeMs: Date.now() + decalage - 20 * 60_000,
        },
      },
    } as unknown as DisplayPayload)

    // Vingt minutes, pas les cinq secondes de temps réel.
    expect($('duree').textContent).toMatch(/^20:0\d$/)
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

  /**
   * Ce que « Commencer » entraîne.
   *
   * Deux gestes que la régie faisait de mémoire et oubliait aux moments les
   * plus coûteux : lancer l'enregistrement, et passer à l'antenne.
   */
  describe('démarrage', () => {
    /**
     * Le montage par défaut ouvre la page sur l'heure du poste, à des mois du
     * créneau : le garde-fou du démarrage anticipé répondrait avant celui de
     * l'enregistrement, qui est ce que ces tests-là visent. On se pose donc
     * juste avant le créneau, là où commencer est le geste normal du matin.
     */
    beforeEach(() => monterRegie(a('2026-10-30T09:58:00Z')))

    /** Salle qui enregistre déjà : l'avertissement n'a pas lieu d'être. */
    function enregistrementLance(): DisplayPayload {
      return {
        ...a('2026-10-30T09:58:00Z'),
        diagnostics: {
          ...ETAT.diagnostics,
          recording: { active: true, markers: 0, startedAtMs: Date.now() },
        },
      } as unknown as DisplayPayload
    }

    it('avertit quand rien n\'enregistre, au lieu de commencer', async () => {
      $('btn-conf-demarrer').click()
      await new Promise((resolve) => setTimeout(resolve, 10))

      // La question n'a de sens qu'avant : après, l'enregistrement manquera
      // toujours les premières minutes.
      expect(document.body.dataset.rec).toBe('ouverte')
      expect(envoyees).toEqual([])
    })

    it('enregistre puis commence, dans cet ordre', async () => {
      $('btn-conf-demarrer').click()
      await new Promise((resolve) => setTimeout(resolve, 10))
      $('rec-avec').click()
      await new Promise((resolve) => setTimeout(resolve, 20))

      const actions = envoyees.map((envoi) => (envoi as { action: string }).action)
      expect(actions.indexOf('recording.start')).toBeLessThan(actions.indexOf('session.start'))
      expect(document.body.dataset.rec).toBe('fermee')
    })

    it('sait commencer sans enregistrer', async () => {
      $('btn-conf-demarrer').click()
      await new Promise((resolve) => setTimeout(resolve, 10))
      $('rec-sans').click()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(envoyees).toContainEqual({ action: 'session.start' })
      expect(envoyees).not.toContainEqual({ action: 'recording.start' })
    })

    it('renonce sans rien envoyer', async () => {
      $('btn-conf-demarrer').click()
      await new Promise((resolve) => setTimeout(resolve, 10))
      $('rec-annuler').click()

      // La question peut tomber au mauvais moment : on visait Terminer, ou
      // l'intervenant n'est pas prêt.
      expect(document.body.dataset.rec).toBe('fermee')
      expect(envoyees).toEqual([])
    })

    it('passe à l\'antenne dans la foulée', async () => {
      monterRegie(enregistrementLance())
      $('btn-conf-demarrer').click()
      await new Promise((resolve) => setTimeout(resolve, 20))

      // Sans cette bascule, l'habillage restait à l'écran pendant les
      // premières phrases de l'intervenant.
      expect(envoyees).toContainEqual({ action: 'session.start' })
      expect(envoyees).toContainEqual({ action: 'scene.set', role: 'LIVE' })
    })

    it('ne demande rien quand la salle enregistre déjà', async () => {
      monterRegie(enregistrementLance())
      $('btn-conf-demarrer').click()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(document.body.dataset.rec).toBe('fermee')
      expect(envoyees).toContainEqual({ action: 'session.start' })
    })

    it('respecte une salle qui a décoché les deux réglages', async () => {
      monterRegie({
        ...a('2026-10-30T09:58:00Z'),
        diagnostics: {
          ...ETAT.diagnostics,
          config: { ...ETAT.diagnostics?.config, promptRecordingOnStart: false, sceneOnStart: null },
        },
      } as unknown as DisplayPayload)
      $('btn-conf-demarrer').click()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(envoyees).toEqual([{ action: 'session.start' }])
    })
  })

  /**
   * Le cas signalé : en salle 2, à 08:45, « Industrialiser l'IA » de 09:50
   * était marquée tenue de 08:45 à 08:45. Entre deux créneaux la régie pilote
   * la conférence qui arrive — ce qu'on veut à 09:48, et un piège à 08:45.
   * Rien à l'écran ne distinguait les deux.
   */
  describe('démarrage très en avance', () => {
    const ouverte = () => document.body.dataset.tot === 'ouverte'
    const touche = (key: string) =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

    it('demande confirmation, et ne lance rien avant la réponse', async () => {
      // 08:45, le créneau est à 10:00 UTC : une heure et quart d'avance.
      monterRegie(a('2026-10-30T08:45:00Z'))
      $('btn-conf-demarrer').click()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(ouverte()).toBe(true)
      expect(envoyees).toEqual([])
      // Les deux chiffres qui permettent de répondre : l'écart, et l'heure du
      // créneau qu'on est en train de viser.
      expect($('modale-tot-detail').textContent).toContain('1 h 15')
      expect($('modale-tot-detail').textContent).toContain('11:00')
      expect($('modale-tot-detail').textContent).toContain('HoneySwamp')
    })

    it('passe la main au garde-fou de l\'enregistrement une fois confirmé', async () => {
      monterRegie(a('2026-10-30T08:45:00Z'))
      $('btn-conf-demarrer').click()
      await new Promise((resolve) => setTimeout(resolve, 20))
      $('tot-oui').click()
      await new Promise((resolve) => setTimeout(resolve, 20))

      // La question de la captation vient après celle de la cible : l'inverse
      // ferait tourner un enregistrement pour un talk qu'on renonce à lancer.
      expect(ouverte()).toBe(false)
      expect(document.body.dataset.rec).toBe('ouverte')
      expect(envoyees).toEqual([])
    })

    it('renonce sans rien envoyer', async () => {
      monterRegie(a('2026-10-30T08:45:00Z'))
      $('btn-conf-demarrer').click()
      await new Promise((resolve) => setTimeout(resolve, 20))
      $('tot-non').click()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(ouverte()).toBe(false)
      expect(document.body.dataset.rec).toBe('fermee')
      expect(envoyees).toEqual([])
    })

    it('répond au clavier, comme la confirmation de fin', async () => {
      monterRegie(a('2026-10-30T08:45:00Z'))
      $('btn-conf-demarrer').click()
      await new Promise((resolve) => setTimeout(resolve, 20))

      touche('n')
      expect(ouverte()).toBe(false)

      $('btn-conf-demarrer').click()
      await new Promise((resolve) => setTimeout(resolve, 20))
      touche('Escape')
      expect(ouverte()).toBe(false)
    })

    it('ne prend pas le raccourci de captation pendant la question', async () => {
      monterRegie(a('2026-10-30T08:45:00Z'))
      $('btn-conf-demarrer').click()
      await new Promise((resolve) => setTimeout(resolve, 20))

      // Un « r » réflexe basculerait la captation sous la question elle-même.
      touche('r')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(envoyees).toEqual([])
    })

    it('ne demande rien quinze minutes avant, geste normal du matin', async () => {
      // 09:48 pour un créneau à 10:00 : on a fini plus tôt, le speaker est prêt.
      monterRegie(a('2026-10-30T09:48:00Z'))
      $('btn-conf-demarrer').click()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(ouverte()).toBe(false)
      expect(document.body.dataset.rec).toBe('ouverte')
    })

    it('ne demande rien sur une conférence dont le créneau court', async () => {
      monterRegie(a('2026-10-30T10:20:00Z'))
      $('btn-conf-demarrer').click()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(ouverte()).toBe(false)
    })
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

  /**
   * Terminer n'est pas un geste anodin : la salle passe à « rien dans la
   * salle », les autres régies le voient, le compte à rebours saute à la
   * conférence suivante. Et le bouton est à côté de « Commencer ».
   */
  describe('fin anticipée', () => {
    const EN_COURS = { sessionStates: { 'ses-1': 'running' } }
    const ouverte = () => document.body.dataset.fin === 'ouverte'
    const touche = (key: string) =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

    it('demande confirmation, et ne termine rien avant la réponse', () => {
      // 10:20, le créneau court jusqu'à 10:50 : trente minutes d'avance.
      monterRegie(a('2026-10-30T10:20:00Z', EN_COURS))

      $('btn-conf-terminer').click()

      expect(ouverte()).toBe(true)
      expect(envoyees).toEqual([])
      // Le chiffre qui permet de répondre sans réfléchir.
      expect($('modale-fin-detail').textContent).toContain('30 min')
      expect($('modale-fin-detail').textContent).toContain('HoneySwamp')
    })

    it('compte en secondes quand la fin est toute proche', () => {
      // Arrondies, huit secondes deviennent « 0 min » — et la question perd le
      // seul chiffre qui permettait d'y répondre.
      monterRegie(a('2026-10-30T10:49:52Z', EN_COURS))

      $('btn-conf-terminer').click()

      expect($('modale-fin-detail').textContent).toContain('8 s')
    })

    it('termine sur « y »', () => {
      monterRegie(a('2026-10-30T10:20:00Z', EN_COURS))
      $('btn-conf-terminer').click()

      touche('y')

      expect(ouverte()).toBe(false)
      expect(envoyees).toEqual([{ action: 'session.end' }])
    })

    it('renonce sur « n », sans rien envoyer', () => {
      monterRegie(a('2026-10-30T10:20:00Z', EN_COURS))
      $('btn-conf-terminer').click()

      touche('n')

      expect(ouverte()).toBe(false)
      expect(envoyees).toEqual([])
    })

    it('renonce aussi sur Échap', () => {
      monterRegie(a('2026-10-30T10:20:00Z', EN_COURS))
      $('btn-conf-terminer').click()

      touche('Escape')

      expect(ouverte()).toBe(false)
      expect(envoyees).toEqual([])
    })

    it('garde le clavier tant que la question est posée', () => {
      // Un « r » réflexe pendant qu'on demande s'il faut terminer basculerait
      // la captation sous la question elle-même.
      monterRegie(a('2026-10-30T10:20:00Z', EN_COURS))
      $('btn-conf-terminer').click()

      touche('r')
      touche('l')
      touche('p')

      expect(envoyees).toEqual([])
      expect(ouverte()).toBe(true)
    })

    it('ne demande rien à l\'heure ou en dépassement', () => {
      // Le geste normal de la journée : le confirmer à chaque fois en ferait un
      // réflexe, ce qui reviendrait à ne plus le lire.
      monterRegie(a('2026-10-30T10:52:00Z', EN_COURS))

      $('btn-conf-terminer').click()

      expect(ouverte()).toBe(false)
      expect(envoyees).toEqual([{ action: 'session.end' }])
    })
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

  /**
   * Le défaut signalé : Ctrl+R rechargeait la page **et** lançait la captation.
   * Seule la lettre était lue, jamais les modificateurs — une régie retrouvée
   * en train d'enregistrer, un fichier de plus sur le disque, et rien à l'écran
   * pour dire d'où ça venait.
   */
  it('laisse les raccourcis du navigateur au navigateur', async () => {
    for (const modificateur of ['ctrlKey', 'metaKey', 'altKey']) {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'r', bubbles: true, [modificateur]: true }),
      )
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', bubbles: true, [modificateur]: true }),
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(envoyees).toEqual([])
  })

  it('garde la touche seule, et Maj avec elle', async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', bubbles: true, shiftKey: true }))
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

  it('compte vers le début tant que la conférence n\'a pas commencé', () => {
    /**
     * Le cas signalé : à 8h38, la régie déroulait deux heures de compte à
     * rebours sur la conférence de 9h50. Le chiffre était juste — c'est bien ce
     * qu'il resterait du créneau — mais en gros caractères il se lit comme un
     * talk en cours, et il a été lu ainsi.
     */
    monterRegie(a('2026-10-30T08:38:29.500Z', { targetIsUpcoming: true }))

    // 08:38:29,5 → 10:00 : une heure, vingt-et-une minutes et trente secondes.
    expect($('restant').textContent).toBe('1:21:30')
    // Atténué : rien à décider avant que ça ne commence.
    expect($('restant').className).toContain('text-attenue')
  })

  it('bascule vers la fin dès qu\'on lance le talk en avance', () => {
    monterRegie(a('2026-10-30T09:58:29.500Z', {
      targetIsUpcoming: true,
      sessionStates: { 'ses-1': 'running' },
    }))

    // Lancé deux minutes avant l'heure : ce qui compte redevient la fin prévue.
    expect($('restant').textContent).toBe('51:30')
    expect($('restant').className).not.toContain('text-attenue')
  })

  /**
   * Après « Terminer ».
   *
   * Le chronomètre continuait sur le créneau quitté : quinze minutes affichées
   * en grand sur un talk que la salle venait de quitter. Ce qu'on vient y
   * chercher à ce moment-là est la seule chose qui décide de la suite — dans
   * combien de temps la prochaine commence.
   */
  describe('conférence terminée', () => {
    const talk = (id: string, titre: string, debut: string, fin: string) => ({
      id, title: titre,
      startsAt: debut, endsAt: fin,
      startsAtMs: Date.parse(debut), endsAtMs: Date.parse(fin),
      kind: 'talk', speakers: [],
    })
    const pause = (id: string, titre: string, debut: string, fin: string) => ({
      ...talk(id, titre, debut, fin), kind: 'break',
    })

    /** Le programme par défaut s'arrête après « HoneySwamp » : on lui donne une suite. */
    const AVEC_SUITE = [
      ...ETAT.sessions,
      talk('ses-2', 'Blind ops', '2026-10-30T11:00:00.000Z', '2026-10-30T11:50:00.000Z'),
    ]

    /** Instant décalé d'une demi-seconde : sur une frontière exacte, l'arrondi bascule. */
    const TERMINEE = { sessionStates: { 'ses-1': 'ended' } }

    it('repart vers la prochaine conférence', () => {
      monterRegie(a('2026-10-30T10:35:29.500Z', TERMINEE, AVEC_SUITE))

      // 10:35:29,5 → 11:00, début de « Blind ops ». Pas 10:50, fin du créneau quitté.
      expect($('restant').textContent).toBe('24:30')
      expect(($('badge-restant') as HTMLElement).hidden).toBe(false)
      // Atténué : rien à décider avant que ça ne reparte.
      expect($('restant').className).toContain('text-attenue')
    })

    it("nomme la conférence visée, sans perdre l'annulation", () => {
      monterRegie(a('2026-10-30T10:35:00Z', TERMINEE, AVEC_SUITE))

      const detail = $('conf-detail').textContent ?? ''
      // Heure de l'événement : 11:00 UTC se lit 12:00 à Paris.
      expect(detail).toContain('Prochaine conférence à 12:00')
      // Le geste d'annulation reste à portée : « Terminer » se presse par erreur.
      expect(detail).toContain('Remettre à venir')
    })

    it("saute les pauses : on n'attend pas un déjeuner", () => {
      // Compter jusqu'à la pause donnerait un chiffre juste et sans usage — et
      // « Commencer » viserait de toute façon le talk d'après.
      monterRegie(a('2026-10-30T10:35:29.500Z', TERMINEE, [
        ...ETAT.sessions,
        pause('pause-1', 'Pause croissants', '2026-10-30T10:50:00.000Z', '2026-10-30T11:10:00.000Z'),
        talk('ses-3', 'Houston', '2026-10-30T11:10:00.000Z', '2026-10-30T11:50:00.000Z'),
      ]))

      expect($('restant').textContent).toBe('34:30')
      expect($('conf-detail').textContent).toContain('Prochaine conférence à 12:10')
    })

    it('reste muet quand plus rien ne suit', () => {
      monterRegie(a('2026-10-30T10:35:00Z', TERMINEE))

      expect($('restant').textContent).toBe('--:--')
      expect(($('badge-restant') as HTMLElement).hidden).toBe(true)
      expect($('conf-detail').textContent).toContain('Terminée')
    })

    it('ne porte pas le badge sur une conférence qui court', () => {
      monterRegie(a('2026-10-30T10:20:29.500Z', { sessionStates: { 'ses-1': 'running' } }))

      expect(($('badge-restant') as HTMLElement).hidden).toBe(true)
      expect($('restant').textContent).toBe('29:30')
    })
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

/**
 * Une page figée ne doit pas passer pour une page vivante.
 *
 * L'horloge, le compte à rebours et le flux des salles se redessinent chaque
 * seconde depuis la dernière charge utile reçue : ils continuent d'avancer même
 * quand plus rien n'arrive. Seul l'état de la conférence reste bloqué sur ce
 * qu'il disait à la coupure — et c'est exactement ce qu'on ne peut pas
 * diagnostiquer depuis une salle.
 */
describe('vivacité du flux de la page', () => {
  /** Flux d'état factice : la page en ouvre un au montage, on garde la main dessus. */
  class FluxFactice {
    static dernier: FluxFactice | null = null
    onopen: (() => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((evenement: MessageEvent) => void) | null = null
    constructor(public readonly url: string) {
      if (url.includes('vue=regie')) FluxFactice.dernier = this
    }
    addEventListener(): void {}
    close(): void {}
  }

  /** Laisse passer un tic de la page — c'est lui qui évalue la vivacité. */
  const unTic = () => new Promise((resolve) => setTimeout(resolve, 1_100))

  function monterAvecFlux(): FluxFactice {
    FluxFactice.dernier = null
    vi.stubGlobal('EventSource', FluxFactice)
    monterRegie()
    return FluxFactice.dernier!
  }

  it('ne dit rien tant que le flux tient', async () => {
    monterAvecFlux()
    await unTic()

    expect(($('flux-mort') as HTMLElement).hidden).toBe(true)
  })

  it('ne crie pas sur une reconnexion passagère', async () => {
    // `onerror` part aussi pour une coupure d'une seconde, que personne n'a
    // besoin de voir : une page qui clignote à chaque reconnexion cesse d'être lue.
    const flux = monterAvecFlux()
    flux.onerror!()
    await unTic()

    expect(($('flux-mort') as HTMLElement).hidden).toBe(true)
  })

  it('signale un écran figé quand la coupure dure', async () => {
    const flux = monterAvecFlux()
    flux.onerror!()

    // Cinq secondes plus tard, sans que le flux soit revenu.
    const vraiNow = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => vraiNow() + 5_000)
    await unTic()

    expect(($('flux-mort') as HTMLElement).hidden).toBe(false)
    expect($('flux-mort').textContent).toContain('figé')
    vi.mocked(Date.now).mockRestore()
  })

  it('se tait dès que le flux revient', async () => {
    const flux = monterAvecFlux()
    flux.onerror!()
    const vraiNow = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => vraiNow() + 5_000)
    await unTic()
    expect(($('flux-mort') as HTMLElement).hidden).toBe(false)

    flux.onopen!()
    await unTic()

    expect(($('flux-mort') as HTMLElement).hidden).toBe(true)
    vi.mocked(Date.now).mockRestore()
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

  it("marque d'une étiquette la salle en break, sans nommer le créneau", async () => {
    // 10:53 : Track #2 est sur sa pause café. « Pause café » à la place d'un
    // titre de conférence se lisait comme une salle occupée.
    monterRegie(a('2026-10-30T10:53:00Z'))
    await attendre()

    const salle = $('flux-salles').querySelector('[data-salle="track-2"]')!
    expect(salle.textContent).toContain('BREAK')
    expect(salle.textContent).not.toContain('Pause café')
    // La reprise reste : c'est elle qui décide si on laisse filer cinq minutes.
    expect(salle.textContent).toContain('reprise 12:10')
  })

  it("annonce le break à venir pendant que le talk d'à côté court encore", async () => {
    // 10:47 : « Blind ops » finit à 10:50, la pause suit. C'est le cas qui
    // compte — celui où l'on décide de ne pas enchaîner.
    monterRegie(a('2026-10-30T10:47:00Z'))
    await attendre()

    const salle = $('flux-salles').querySelector('[data-salle="track-2"]')!
    expect(salle.textContent).toContain('BREAK à venir')
    // Le talk reste annoncé : la salle n'est pas encore vide.
    expect(salle.textContent).toContain('Blind ops')
  })

  it("ne parle pas d'un break encore lointain", async () => {
    monterRegie(a('2026-10-30T10:20:00Z'))
    await attendre()

    expect($('flux-salles').textContent).not.toContain('BREAK')
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

/**
 * Les deux boutons lisent la même table que le hub.
 *
 * Ils encodaient leur propre condition — `statut === 'running'` d'un côté,
 * `statut !== 'running'` de l'autre. Elle disait juste, mais rien ne
 * garantissait qu'elle continue de dire la même chose que la procédure qui
 * écrit. Depuis `@cloudnord/etat-salle`, c'est la même table des deux côtés, et
 * le refus sert d'infobulle plutôt que de se découvrir au clic.
 */
describe('boutons pilotés par le cycle de vie', () => {
  const bouton = (id: string) => $(id) as HTMLButtonElement

  it('dit pourquoi « Terminer » est fermé sur une conférence non lancée', () => {
    monterRegie()

    expect(bouton('btn-conf-terminer').disabled).toBe(true)
    expect(bouton('btn-conf-terminer').title).toContain("n'a pas été lancée")
    // Le geste possible, lui, n'a rien à expliquer.
    expect(bouton('btn-conf-demarrer').disabled).toBe(false)
    expect(bouton('btn-conf-demarrer').hasAttribute('title')).toBe(false)
  })

  it('dit pourquoi « Commencer » est fermé sur un talk en cours', () => {
    monterRegie({
      ...ETAT,
      state: { ...ETAT.state, sessionStates: { 'ses-1': 'running' } },
    } as unknown as DisplayPayload)

    expect(bouton('btn-conf-demarrer').title).toContain('déjà lancée')
    expect(bouton('btn-conf-terminer').hasAttribute('title')).toBe(false)
  })

  it('rouvre « Commencer » après une clôture, sans passer par « Remettre à venir »', () => {
    // Une conférence close par la règle horaire alors qu'elle n'était pas finie
    // se rattrape d'un geste.
    monterRegie({
      ...ETAT,
      state: { ...ETAT.state, sessionStates: { 'ses-1': 'ended' } },
    } as unknown as DisplayPayload)

    expect(bouton('btn-conf-demarrer').disabled).toBe(false)
    expect(bouton('btn-conf-terminer').title).toContain('déjà terminée')
  })
})

/**
 * Terminer une conférence **avant son créneau**.
 *
 * La régie l'autorise à dessein — « Commencer » reste disponible sur une
 * conférence à venir, et « Terminer » suit. Mais la conférence restait alors
 * « après maintenant » pour le calcul de la suivante, et la salle se désignait
 * elle-même : le grand compte à rebours décomptait jusqu'au début d'un talk
 * qu'on venait de clore, et le détail annonçait « prochaine conférence à
 * 09:50 » sur la conférence de 09:50 qu'on venait de terminer.
 */
describe('conférence terminée avant son créneau', () => {
  /** 09:00 : le talk de 10:00 n'a pas commencé, et un autre suit à 11:00. */
  function avantLeCreneau(statuts: Record<string, string>): DisplayPayload {
    const apres = {
      id: 'ses-2',
      title: 'Le talk suivant',
      startsAt: '2026-10-30T11:00:00.000Z',
      endsAt: '2026-10-30T11:50:00.000Z',
      startsAtMs: Date.parse('2026-10-30T11:00:00Z'),
      endsAtMs: Date.parse('2026-10-30T11:50:00Z'),
      kind: 'talk',
      speakers: [],
    }
    return {
      ...ETAT,
      sessions: [...(ETAT.sessions as unknown[]), apres],
      state: {
        ...ETAT.state,
        targetIsUpcoming: true,
        sessionStates: statuts,
        serverTimeOffsetMs: Date.parse('2026-10-30T09:00:00Z') - Date.now(),
      },
    } as unknown as DisplayPayload
  }

  it('ne se désigne pas elle-même comme prochaine conférence', () => {
    monterRegie(avantLeCreneau({ 'ses-1': 'ended' }))

    expect($('badge-conf').textContent).toBe('terminée')
    // 11:00 heure UTC, soit 12:00 à Paris : le talk d'après, pas celui qu'on
    // vient de terminer.
    expect($('conf-detail').textContent).toContain('12:00')
    expect($('conf-detail').textContent).not.toContain('11:00')
  })

  it('décompte jusqu’à ce qui va réellement se tenir', () => {
    monterRegie(avantLeCreneau({ 'ses-1': 'ended' }))

    // 09:00 → 11:00 : deux heures, et non l'heure qui séparait de la
    // conférence terminée. Le chrono passe en heures au-delà de soixante
    // minutes, et perd la seconde que met le montage.
    expect($('restant').textContent).toMatch(/^1:59:\d\d$/)
  })

  it('ne saute rien tant que la conférence tient toujours', () => {
    // Sans décision, la prochaine conférence reste celle de 10:00 — c'est ce
    // que vise « Commencer », et les deux doivent désigner le même créneau.
    monterRegie(avantLeCreneau({}))

    expect($('badge-conf').textContent).toBe('à venir')
    expect($('conf-detail').textContent).toContain('Commencer')
  })
})

/**
 * Contrôle des rushes.
 *
 * La modale ne commande rien dans la salle : elle relit le disque et renvoie
 * des verdicts. Ce qui doit être tenu ici, c'est qu'elle liste ce que le
 * service dit — sidecar manquant compris —, que ✓ se reprend, et qu'elle prend
 * le clavier tant qu'elle est ouverte.
 */
describe('enregistrements produits', () => {
  const RUSHES = [
    {
      file: '2026-10-30_track1_1000_honeyswamp.mkv',
      sizeBytes: 2_700_000_000,
      modifiedAtMs: Date.parse('2026-10-30T10:45:00Z'),
      enEcriture: false,
      sidecar: {
        title: 'HoneySwamp',
        speakers: [{ name: 'Steven', company: null }],
        startedAt: '2026-10-30T10:00:00.000Z',
        durationMs: 45 * 60_000,
        markers: [{ label: 'démo', offsetMs: 60_000, at: '2026-10-30T10:01:00.000Z' }],
      },
      check: null,
    },
    {
      file: '2026-10-30_track1_1100_blind-ops.mkv',
      sizeBytes: 12_000,
      modifiedAtMs: Date.parse('2026-10-30T11:05:00Z'),
      enEcriture: false,
      sidecar: null,
      check: {
        status: 'illisible',
        at: '2026-10-30T11:10:00.000Z',
        by: 'auto',
        reasons: ['aucune piste vidéo dans le conteneur'],
        probe: null,
      },
    },
  ]

  const OUTILS = { ffmpeg: true, ffprobe: true }

  /**
   * Rapatriement, tel que le service local le rend.
   *
   * Le défaut est un hub sans stockage : c'est le cas normal, et il doit rester
   * celui que les tests existants décrivent — aucune colonne de plus, aucun
   * bouton de plus sur une salle qui n'a nulle part où envoyer.
   */
  const SANS_STOCKAGE = {
    entrees: [] as unknown[],
    verdict: { autorise: false, raison: 'desactive', texte: 'aucun stockage configuré sur le hub' },
  }

  /** Le service local, tel que la modale le voit. */
  function servir(
    entrees: unknown[] = RUSHES,
    root: string | null = 'D:\\captations\\2026',
    outils: { ffmpeg: boolean; ffprobe: boolean } = OUTILS,
    montees: unknown = SANS_STOCKAGE,
  ): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (init?.body != null) envoyees.push(JSON.parse(init.body))
        if (url === '/control/recordings') {
          return new Response(JSON.stringify({ ok: true, root, entries: entrees, outils }), { status: 200 })
        }
        if (url === '/control/uploads') {
          return new Response(JSON.stringify({ ok: true, ...(montees as object) }), { status: 200 })
        }
        return new Response(JSON.stringify({ ok: true, message: 'fait' }), { status: 200 })
      }),
    )
  }

  async function ouvrir(
    entrees: unknown[] = RUSHES,
    root: string | null = 'D:\\captations\\2026',
    outils: { ffmpeg: boolean; ffprobe: boolean } = OUTILS,
    montees: unknown = SANS_STOCKAGE,
  ) {
    servir(entrees, root, outils, montees)
    $('btn-vod').click()
    await attendreQue(() => ($('vod-contenu').textContent ?? '') !== 'Lecture du dossier…')
  }

  it('s’ouvre depuis la captation et liste ce qui a été enregistré', async () => {
    expect(document.body.dataset.vod).toBe('fermee')

    await ouvrir()

    expect(document.body.dataset.vod).toBe('ouverte')
    const texte = $('vod-contenu').textContent ?? ''
    expect(texte).toContain('HoneySwamp')
    expect(texte).toContain('Steven')
    expect(texte).toContain('1 marqueur')
    expect(texte).toContain('2,7 Go')
    expect($('vod-racine').textContent).toContain('captations')
  })

  it('montre le verdict et sa raison, sidecar manquant compris', async () => {
    await ouvrir()

    const texte = $('vod-contenu').textContent ?? ''
    expect(texte).toContain('Illisible')
    expect(texte).toContain('aucune piste vidéo')
    // Le rush sans sidecar est justement celui qu'on cherche : il reste listé,
    // et le dit.
    expect(texte).toContain('sidecar absent')
    expect(texte).toContain('Non vérifié')
  })

  it('dit pourquoi la liste est vide plutôt que de laisser croire à une journée perdue', async () => {
    await ouvrir([], null)

    expect($('vod-contenu').textContent).toContain('Aucun dossier d’enregistrement connu')
  })

  it('lance le contrôle technique d’un fichier', async () => {
    await ouvrir()
    envoyees = []

    const boutons = [...$('vod-contenu').querySelectorAll('[data-vod-action="inspect"]')]
    ;(boutons[0] as HTMLButtonElement).click()
    await attendreQue(() => envoyees.length > 0)

    expect(envoyees[0]).toEqual({
      action: 'vod.inspect',
      file: '2026-10-30_track1_1000_honeyswamp.mkv',
    })
  })

  it('pose un verdict à la main, et le reprend au second clic', async () => {
    await ouvrir()
    envoyees = []
    ;($('vod-contenu').querySelector('[data-vod-action="ok"]') as HTMLButtonElement).click()
    await attendreQue(() => envoyees.length > 0)

    expect(envoyees[0]).toEqual({
      action: 'vod.verdict',
      file: '2026-10-30_track1_1000_honeyswamp.mkv',
      status: 'ok',
    })

    // Le service renvoie maintenant un verdict d'opérateur : le même bouton doit
    // l'effacer, sinon une fausse manœuvre resterait à l'écran sans reprise.
    const relu = [
      {
        ...RUSHES[0],
        check: { status: 'ok', at: '2026-10-30T12:00:00.000Z', by: 'operateur', reasons: ['relu en régie'], probe: null },
      },
    ]
    await ouvrir(relu)
    envoyees = []
    ;($('vod-contenu').querySelector('[data-vod-action="ok"]') as HTMLButtonElement).click()
    await attendreQue(() => envoyees.length > 0)

    expect(envoyees[0]).toEqual({
      action: 'vod.verdict',
      file: '2026-10-30_track1_1000_honeyswamp.mkv',
      status: null,
    })
  })

  it('contrôle tout le dossier en série', async () => {
    await ouvrir()
    envoyees = []

    $('btn-vod-tout').click()
    await attendreQue(() => envoyees.length >= 2)

    expect(envoyees.slice(0, 2)).toEqual([
      { action: 'vod.inspect', file: '2026-10-30_track1_1000_honeyswamp.mkv' },
      { action: 'vod.inspect', file: '2026-10-30_track1_1100_blind-ops.mkv' },
    ])
  })

  it('déplie un aperçu qui ne demande pas le fichier entier', async () => {
    await ouvrir()

    ;($('vod-contenu').querySelector('[data-vod-apercu]') as HTMLButtonElement).click()

    const lecteur = $('vod-contenu').querySelector('video') as HTMLVideoElement
    // Un Matroska de trois gigaoctets ne s'ouvre pas dans un navigateur : le
    // lecteur reçoit un extrait remballé à la volée, pas le fichier.
    expect(lecteur.getAttribute('src')).toContain('/control/recordings/extrait')
    expect(lecteur.getAttribute('src')).toContain(encodeURIComponent(RUSHES[0]!.file))
    expect(lecteur.getAttribute('src')).toContain('at=0')
    // Le fichier brut reste joignable : un vrai lecteur, lui, sait l'ouvrir.
    expect($('vod-contenu').querySelector('a[href*="/control/recordings/fichier"]')).toBeTruthy()
  })

  it('saute aux endroits où une prise se casse', async () => {
    await ouvrir()
    ;($('vod-contenu').querySelector('[data-vod-apercu]') as HTMLButtonElement).click()

    const positions = [...$('vod-contenu').querySelectorAll('[data-vod-position]')]
    expect(positions.map((bouton) => bouton.textContent)).toEqual([
      'Début',
      '25 %',
      'Milieu',
      '75 %',
      'Fin',
    ])

    // « Fin » : les vingt dernières secondes des quarante-cinq minutes.
    ;(positions[4] as HTMLButtonElement).click()
    const lecteur = $('vod-contenu').querySelector('video') as HTMLVideoElement
    expect(lecteur.getAttribute('src')).toContain('at=' + (45 * 60_000 - 20_000))
  })

  it('referme l’aperçu au second clic', async () => {
    await ouvrir()
    const oeil = () => $('vod-contenu').querySelector('[data-vod-apercu]') as HTMLButtonElement

    oeil().click()
    expect($('vod-contenu').querySelector('video')).toBeTruthy()

    oeil().click()
    expect($('vod-contenu').querySelector('video')).toBeNull()
  })

  it('dit ce qui manque sur la machine plutôt que d’afficher un lecteur noir', async () => {
    await ouvrir(RUSHES, 'D:\\captations\\2026', { ffmpeg: false, ffprobe: false })

    expect($('vod-contenu').textContent).toContain('ffmpeg et ffprobe introuvables')

    ;($('vod-contenu').querySelector('[data-vod-apercu]') as HTMLButtonElement).click()
    const lecteur = $('vod-contenu').querySelector('video') as HTMLVideoElement
    // Sans ffmpeg, plus d'extrait : on sert le fichier tel quel, en le disant.
    expect(lecteur.getAttribute('src')).toContain('/control/recordings/fichier')
    expect($('vod-contenu').querySelector('[data-vod-position]')).toBeNull()
    expect($('vod-contenu').textContent).toContain('Matroska ne s’ouvrira pas')
  })

  it('prend le clavier tant qu’elle est ouverte', async () => {
    await ouvrir()
    envoyees = []

    // Un « r » réflexe par-dessus la liste lancerait une captation dans le dos
    // de l'opérateur.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))
    await attendre()
    expect(envoyees).toEqual([])

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.body.dataset.vod).toBe('fermee')
  })

  /**
   * Rapatriement des rushes, vu de la régie.
   *
   * Ce que ces tests protègent tient en deux choses. La première : sur une
   * salle dont le hub n'a pas de stockage, rien ne doit apparaître — un bouton
   * qui échoue à chaque clic est pire qu'un bouton absent, et la journée se
   * passe devant cette modale. La seconde : quand rien ne monte, l'écran doit
   * dire pourquoi. Une attente muette se lit comme un bouton mort ; l'opérateur
   * reclique, puis va chercher la panne ailleurs.
   */
  const AVEC_STOCKAGE = {
    entrees: [],
    verdict: { autorise: true, raison: null, texte: 'en cours' },
  }

  it('ne propose rien tant que le hub n’a pas de stockage', async () => {
    await ouvrir()

    expect($('vod-contenu').querySelector('[data-vod-monter]')).toBeNull()
    // Le bandeau non plus : « aucun stockage configuré » n'est pas une attente,
    // c'est une absence de fonctionnalité, et l'annoncer en ambre trois fois
    // par jour la ferait passer pour une panne.
    expect($('vod-regulateur').className).toContain('hidden')
  })

  it('propose de téléverser dès que le hub a une destination', async () => {
    await ouvrir(RUSHES, 'D:\\captations', OUTILS, AVEC_STOCKAGE)
    envoyees = []

    const bouton = $('vod-contenu').querySelector('[data-vod-monter]') as HTMLButtonElement
    expect(bouton).not.toBeNull()
    bouton.click()
    await attendreQue(() => envoyees.length > 0)

    expect(envoyees[0]).toEqual({
      action: 'vod.upload',
      file: '2026-10-30_track1_1000_honeyswamp.mkv',
    })
  })

  it('dit pourquoi rien ne monte, en nommant ce qu’on attend', async () => {
    await ouvrir(RUSHES, 'D:\\captations', OUTILS, {
      entrees: [],
      verdict: { autorise: false, raison: 'fenetre', texte: 'conférence dans 6 min' },
    })

    // Le chiffre compte autant que le motif : « en attente » ne dit pas si
    // c'est l'affaire de six minutes ou de la journée.
    expect($('vod-regulateur').textContent).toContain('conférence dans 6 min')
    expect($('vod-regulateur').className).not.toContain('hidden')
  })

  it('montre l’avancement, et l’erreur du stockage telle qu’elle est venue', async () => {
    await ouvrir(RUSHES, 'D:\\captations', OUTILS, {
      entrees: [
        {
          file: '2026-10-30_track1_1000_honeyswamp.mkv',
          state: 'en-cours',
          pourcent: 42,
          debitOctetsS: 1_000_000,
          erreur: null,
          manuel: true,
        },
        {
          file: '2026-10-30_track1_1100_blind-ops.mkv',
          state: 'echoue',
          pourcent: 12,
          debitOctetsS: null,
          erreur: 'Le stockage a refusé (AccessDenied) : nope',
          manuel: false,
        },
      ],
      verdict: { autorise: true, raison: null, texte: 'en cours' },
    })

    const texte = $('vod-contenu').textContent ?? ''
    expect(texte).toContain('téléversement en cours — 42 %')
    // « AccessDenied » est le seul mot qu'on puisse porter à qui tient le
    // bucket : le traduire le ferait perdre.
    expect(texte).toContain('AccessDenied')
  })

  it('propose d’annuler ce qui monte, et rien sur ce qui est déjà arrivé', async () => {
    await ouvrir(RUSHES, 'D:\\captations', OUTILS, {
      entrees: [
        { file: '2026-10-30_track1_1000_honeyswamp.mkv', state: 'en-cours', pourcent: 42, debitOctetsS: null, erreur: null, manuel: true },
        { file: '2026-10-30_track1_1100_blind-ops.mkv', state: 'termine', pourcent: 100, debitOctetsS: null, erreur: null, manuel: false },
      ],
      verdict: { autorise: true, raison: null, texte: 'en cours' },
    })
    envoyees = []

    const annuler = $('vod-contenu').querySelector('[data-vod-annuler]') as HTMLButtonElement
    annuler.click()
    await attendreQue(() => envoyees.length > 0)
    expect(envoyees[0]).toEqual({
      action: 'vod.upload.cancel',
      file: '2026-10-30_track1_1000_honeyswamp.mkv',
    })

    // Un rush déjà chez le stockage n'offre aucun bouton : repayer trois
    // gigaoctets sur le réseau de l'événement au premier clic distrait est
    // exactement ce qu'on évite.
    const lignes = [...$('vod-contenu').querySelectorAll('[data-vod-monter]')]
    expect(lignes.map((b) => (b as HTMLElement).dataset.vodMonter)).not.toContain(
      '2026-10-30_track1_1100_blind-ops.mkv',
    )
  })

  it('téléverse tout d’un geste', async () => {
    await ouvrir(RUSHES, 'D:\\captations', OUTILS, AVEC_STOCKAGE)
    envoyees = []

    ;($('btn-vod-monter-tout') as HTMLButtonElement).click()
    await attendreQue(() => envoyees.length > 0)
    expect(envoyees[0]).toEqual({ action: 'vod.upload', file: null })
  })

})

/**
 * Lien avec le hub, en pastille.
 *
 * Ce que ces tests protègent n'est pas la couleur — elle existait déjà — mais
 * la phrase qui l'accompagne. Quand la pastille passe au rouge en pleine
 * journée, la question de l'opérateur est « qu'est-ce qui ne marche plus ? »,
 * et la réponse est contre-intuitive : la salle projette et capte sans le hub.
 * Un opérateur qui l'ignore arrête le talk pour rien.
 */
describe('bulle du lien avec le hub', () => {
  /** Un état de salle, sans toucher à l'horloge du test. */
  function lien(etat: Record<string, unknown>, outboxDepth = 0): DisplayPayload {
    const base = ETAT as unknown as { diagnostics: Record<string, unknown> }
    return {
      ...ETAT,
      diagnostics: { ...base.diagnostics, outboxDepth },
      state: { ...ETAT.state, serverTimeOffsetMs: 0, ...etat },
    } as unknown as DisplayPayload
  }

  const bulle = () => $('bulle-hub').textContent ?? ''

  it('dit le lien tenu, et ce qui circule', () => {
    monterRegie(lien({ connectivity: 'ONLINE' }))

    expect($('hub').dataset.niveau).toBe('ok')
    expect($('pastille-hub').className).toBe('pastille')
    expect($('etat-libelle').textContent).toBe('hub connecté')
    expect(bulle()).toContain('Connecté')
    expect(bulle()).toContain('file vide')
    expect(bulle()).toContain('horloge alignée')
  })

  it('dit ce qui continue quand le temps réel tombe', () => {
    monterRegie(lien({ connectivity: 'DEGRADED' }, 3))

    expect($('hub').dataset.niveau).toBe('attention')
    expect($('pastille-hub').className).toContain('degraded')
    expect(bulle()).toContain('Différé')
    // Le chiffre qui compte pendant une coupure : ce qui attend de repartir.
    expect(bulle()).toContain('3 en attente de remontée')
    expect(bulle()).toContain('continue seule')
    expect(bulle()).toContain('Rien n’est perdu')
  })

  it('hors ligne, rappelle que la salle n’a pas besoin du hub pour tourner', () => {
    monterRegie(lien({ connectivity: 'OFFLINE' }, 12))

    expect($('hub').dataset.niveau).toBe('alerte')
    expect($('pastille-hub').className).toContain('offline')
    expect(bulle()).toContain('Hors ligne')
    // La consigne, pas seulement le constat : continuer, et prévenir autrement.
    expect(bulle()).toContain('captation')
    expect(bulle()).toContain('continuez le talk')
  })

  it('affiche l’écart d’horloge, qui explique un compte à rebours de travers', () => {
    monterRegie(lien({ connectivity: 'ONLINE', serverTimeOffsetMs: 2_400 }))

    expect(bulle()).toContain('décalée de +2,4 s')
  })

  it('dit un gros écart dans une unité qu’on se représente', () => {
    // « décalée de +5 693 432,6 s » est exact et illisible : au-delà de la
    // minute, c'est l'ordre de grandeur qui compte.
    monterRegie(lien({ connectivity: 'ONLINE', serverTimeOffsetMs: 3 * 3_600_000 }))

    expect(bulle()).toContain('décalée de +3 h')
  })

  it('nomme une horloge simulée plutôt que d’annoncer un décalage énorme', () => {
    // Un hub en temps simulé peut être à des semaines : « décalée de 604 800 s »
    // ne dit rien à personne.
    monterRegie(lien({ connectivity: 'ONLINE', simulatedClock: true, serverTimeOffsetMs: 604_800_000 }))

    expect(bulle()).toContain('simulée')
    expect(bulle()).not.toContain('décalée')
  })

  it('n’affiche pas de jauge là où il n’y a rien à mesurer', () => {
    monterRegie(lien({ connectivity: 'ONLINE' }))

    // Une barre vide se lirait comme une mesure à zéro ; le lien avec le hub
    // n'est pas une part de quelque chose.
    expect($('bulle-hub').querySelector('.jauge')).toBeNull()
  })

  it('se signale au survol comme un élément qui a quelque chose à dire', () => {
    monterRegie()

    // Le curseur d'aide est la seule invitation qu'un bandeau puisse donner :
    // rien d'autre ne distingue une pastille bavarde d'une pastille décorative.
    for (const cle of ['hub', 'cpu']) expect($(cle).classList.contains('indicateur')).toBe(true)
    expect(document.documentElement.innerHTML).toContain('.indicateur { cursor: help; }')
  })
})

/**
 * Charge du poste, en pastille.
 *
 * La machine qui encode sature en silence : OBS perd des images sans rien dire,
 * et le rush est mauvais sans que personne s'en aperçoive avant le montage.
 * Ce que ces tests protègent, c'est la seule chose qui rende ça visible en
 * salle — une couleur juste, et une info-bulle qui dit pourquoi.
 */
describe('pastille du processeur', () => {
  /** Monte la régie devant un poste dont le service local dit telle charge. */
  async function poste(charge: unknown): Promise<void> {
    let releves = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/control/host') {
          releves += 1
          if (charge == null) return new Response('', { status: 503 })
          return new Response(JSON.stringify(charge), { status: 200 })
        }
        return new Response(JSON.stringify({ ok: true, message: 'fait' }), { status: 200 })
      }),
    )
    monterRegie()
    // On attend le relevé lui-même, et non un libellé : l'absence de mesure se
    // dit avec les mots du montage, et un test qui les guette passerait sans
    // que la page ait interrogé quoi que ce soit.
    await attendreQue(() => releves > 0)
    await attendre()
  }

  /** Ce que la bulle donne à lire, mise à plat. */
  const bulle = () => $('bulle-cpu').textContent ?? ''

  /** Un poste dont la mémoire respire : 4 Go sur 16. */
  const MEMOIRE_SAINE = { occupeeOctets: 4_000_000_000, totalOctets: 16_000_000_000 }

  it('reste verte tant que le poste a de la marge', async () => {
    await poste({ cpu: 0.31, coeurs: 8, fenetreMs: 5_000, memoire: MEMOIRE_SAINE })

    expect($('pastille-cpu').className).toBe('pastille')
    expect($('cpu').dataset.niveau).toBe('ok')
    expect(bulle()).toContain('31 %')
    expect(bulle()).toContain('8 cœurs')
    expect(bulle()).toContain('sans forcer')
  })

  it('passe à l’orange sur une charge soutenue', async () => {
    await poste({ cpu: 0.78, coeurs: 8, fenetreMs: 5_000 })

    expect($('pastille-cpu').className).toContain('degraded')
    expect($('cpu').dataset.niveau).toBe('attention')
    expect(bulle()).toContain('78 %')
    expect(bulle()).toContain('charge soutenue')
  })

  it('passe au rouge, et dit ce que ça coûte, quand le poste sature', async () => {
    await poste({ cpu: 0.96, coeurs: 4, fenetreMs: 5_000 })

    expect($('pastille-cpu').className).toContain('offline')
    expect($('cpu').dataset.niveau).toBe('alerte')
    // Une couleur seule ne dit pas quoi faire : la bulle nomme le risque.
    expect(bulle()).toContain('images')
  })

  it('colore la pastille et la bulle depuis la même décision', async () => {
    // Deux chemins finiraient par se contredire — pastille verte, bulle rouge —
    // et c'est dans ce désaccord qu'on cesserait de croire l'indicateur.
    await poste({ cpu: 0.96, coeurs: 4, fenetreMs: 5_000 })

    expect($('cpu').dataset.niveau).toBe('alerte')
    expect($('pastille-cpu').className).toContain('offline')

    // La jauge dit la même chose que la pastille, en longueur.
    expect($('bulle-cpu').querySelector('.jauge > span')?.getAttribute('style')).toContain('96%')
  })

  it('grise la pastille plutôt que d’annoncer un poste au repos', async () => {
    // Service local muet : afficher « 0 % » ferait exactement le contraire de
    // ce que la pastille sert à voir.
    await poste(null)

    expect($('pastille-cpu').className).toContain('hors')
    expect($('cpu').dataset.niveau).toBe('inconnu')
    expect(bulle()).toContain('n’a pas répondu')
    expect(bulle()).not.toContain('0 %')
  })

  it('avoue une mesure encore absente', async () => {
    await poste({ cpu: null, coeurs: 8, fenetreMs: 0 })

    expect($('pastille-cpu').className).toContain('hors')
    expect(bulle()).toContain('première mesure')
  })

  it('montre la mémoire à côté du processeur', async () => {
    await poste({ cpu: 0.31, coeurs: 8, fenetreMs: 5_000, memoire: MEMOIRE_SAINE })

    expect(bulle()).toContain('Mémoire')
    expect(bulle()).toContain('25 %')
    expect(bulle()).toContain('4,0 Go occupés sur 16,0')
  })

  it('allume la pastille sur la mémoire, même processeur au repos', async () => {
    // La façon sournoise dont un poste lâche : le processeur ne bouge pas, la
    // machine se met à échanger sur le disque qui écrit le rush.
    await poste({
      cpu: 0.12,
      coeurs: 8,
      fenetreMs: 5_000,
      memoire: { occupeeOctets: 15_500_000_000, totalOctets: 16_000_000_000 },
    })

    expect($('pastille-cpu').className).toContain('offline')
    expect($('cpu').dataset.niveau).toBe('alerte')
    // Le grand chiffre reste celui du processeur, et garde sa propre couleur :
    // c'est la mémoire qui va mal, pas lui.
    expect($('bulle-cpu').querySelector('.chiffre')?.className).toContain('niveau-ok')
    expect(bulle()).toContain('12 %')
    // Et le verdict revient à la mesure la plus grave, sans quoi il dirait
    // « le poste encaisse » d'une machine en train de saturer.
    expect(bulle()).toContain('échanger sur le disque')
  })

  it('ne prend pas une mémoire illisible pour une mémoire pleine', async () => {
    await poste({ cpu: 0.31, coeurs: 8, fenetreMs: 5_000, memoire: null })

    expect($('cpu').dataset.niveau).toBe('ok')
    expect($('pastille-cpu').className).toBe('pastille')
    expect(bulle()).toContain('mémoire illisible')
  })

  it('n’ajoute pas de bulle native par-dessus la sienne', async () => {
    await poste({ cpu: 0.31, coeurs: 8, fenetreMs: 5_000, memoire: MEMOIRE_SAINE })

    // Un `title` restant afficherait les deux, l'une sur l'autre, à une seconde
    // d'intervalle. L'annonce vocale, elle, passe par `aria-label`.
    expect($('cpu').getAttribute('title')).toBeNull()
    expect($('cpu').getAttribute('aria-label')).toContain('31 %')
    expect($('bulle-cpu').getAttribute('aria-hidden')).toBe('true')
  })

  it('se laisse ouvrir au clavier, sans souris', async () => {
    await poste({ cpu: 0.31, coeurs: 8, fenetreMs: 5_000 })

    // La régie se tient aussi au clavier pendant un talk : une bulle qui ne
    // s'ouvre qu'au survol serait invisible à qui n'a pas lâché les raccourcis.
    expect($('cpu').getAttribute('tabindex')).toBe('0')
  })
})
