import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DiagnosticsPanel from '../src/components/DiagnosticsPanel.vue'
import NotificationStack from '../src/components/NotificationStack.vue'
import QuestionsTab from '../src/components/QuestionsTab.vue'
import RoomsStrip from '../src/components/RoomsStrip.vue'
import RoomsTab from '../src/components/RoomsTab.vue'
import Timeline from '../src/components/Timeline.vue'
import { stripEntry } from '../src/lib/rooms.js'
import { useProgramsStore } from '../src/stores/programs.js'
import { DEBUT_MS, FIN_MS, payload, talk } from './fixtures.js'

/**
 * Ce qu'on va chercher, et ce qui vient à soi.
 *
 * Le bandeau des salles voisines est la seule information de la journée qu'un
 * opérateur ne peut pas déduire de son propre écran, et elle décide d'un
 * décalage : « l'autre salle finit dans 3 minutes, on ne lance pas maintenant ».
 */

interface Envoi {
  body: unknown
}

let envois: Envoi[]

const VOISINE = [
  talk({ id: 'v-1', title: 'Terraform sans peur', startsAtMs: DEBUT_MS, endsAtMs: FIN_MS }),
  talk({
    id: 'v-2',
    title: 'Déjeuner',
    kind: 'break',
    startsAtMs: FIN_MS,
    endsAtMs: FIN_MS + 3_600_000,
    startsAt: '2026-10-30T09:45:00.000Z',
  }),
]

beforeEach(() => {
  setActivePinia(createPinia())
  envois = []
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    envois.push({ body: init?.body == null ? null : JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    })
  })
})

/** Une salle voisine, avec son programme en cache et ce que le hub en dit. */
function voisine(overrides: Record<string, unknown> = {}) {
  const etat = payload()
  etat.diagnostics!.rooms = [
    {
      roomId: 'track-2',
      name: 'Track #2',
      connectivity: 'ONLINE',
      sceneRole: 'LIVE',
      recording: false,
      outboxDepth: 0,
      lastSeenAt: null,
      currentSessionId: null,
      conference: 'en-cours',
      ...overrides,
    },
  ]
  etat.diagnostics!.roomsRefreshedAt = new Date().toISOString()
  const programs = useProgramsStore()
  programs.rooms = [
    { id: 'track-1', name: 'Track #1' },
    { id: 'track-2', name: 'Track #2' },
  ]
  programs.sessions = { 'track-2': VOISINE as never }
  return etat
}

describe('ce que dit une case du bandeau', () => {
  const salle = { id: 'track-2', name: 'Track #2', connectivity: 'ONLINE' }

  it('annonce la fin quand elle approche, avec le nombre qui décide', () => {
    const entry = stripEntry(voisine({ conference: 'fin-proche' }), salle, VOISINE as never, FIN_MS - 180_000)

    // « L'autre salle finit dans 3 minutes » est la phrase qui fait attendre ou
    // lancer, et elle ne se déduit d'aucun autre écran.
    expect(entry.detail).toBe('vers la fin · 3 min')
    expect(entry.tint).toBe('text-attention')
  })

  it('donne l’heure de reprise pendant une pause, pas le nom du repas', () => {
    const entry = stripEntry(voisine({ conference: 'pause' }), salle, VOISINE as never, FIN_MS + 60_000)

    /*
     * « Déjeuner » à la place d'un titre de conférence se lisait comme une
     * salle occupée. Ce qui décide ici, c'est l'heure de reprise.
     */
    expect(entry.label).toBe('')
    expect(entry.detail).toContain('pause')
  })

  it('nomme le talk qui déborde, et le peint en alerte', () => {
    const etat = voisine({ conference: 'depassement', currentSessionId: 'v-1' })
    const entry = stripEntry(etat, salle, VOISINE as never, FIN_MS + 600_000)

    // Le programme est passé au créneau suivant ; la salle, non. C'est elle qui
    // a raison, et c'est ce qui décale toute la journée.
    expect(entry.label).toBe('Terraform sans peur')
    expect(entry.tint).toBe('text-alerte')
  })

  it('avoue un programme inconnu plutôt que d’annoncer un hors-créneau', () => {
    const entry = stripEntry(voisine(), salle, [], DEBUT_MS)

    // « Hors créneau » se lirait comme une salle sans rien de prévu, alors
    // qu'on ignore tout de la sienne.
    expect(entry.detail).toBe('programme inconnu')
  })

  it('creuse la pastille d’une salle muette, sans changer ce qu’elle dit', () => {
    const entry = stripEntry(
      voisine({ connectivity: 'OFFLINE' }),
      { ...salle, connectivity: 'OFFLINE' },
      VOISINE as never,
      DEBUT_MS + 60_000,
    )

    // Le remplissage reste celui du programme : on ne sait plus si elle le
    // suit, et le prétendre en couleur serait pire que de se taire.
    expect(entry.dot).toContain('muette')
  })

  it('annonce un break à venir pendant qu’une conférence court encore', () => {
    const entry = stripEntry(voisine(), salle, VOISINE as never, FIN_MS - 300_000)
    expect(entry.breakTag).toEqual({ text: 'BREAK à venir', tint: 'text-attention' })
  })
})

describe('bandeau des salles', () => {
  it('disparaît complètement sur un événement d’une seule salle', () => {
    const etat = payload()
    const wrapper = mount(RoomsStrip, { props: { payload: etat, nowMs: DEBUT_MS } })

    // Une bande vide occupe une ligne d'un écran de régie qui n'en a pas de
    // trop.
    expect(wrapper.find('[data-role="rooms-strip"]').exists()).toBe(false)
  })

  it('ouvre le programme de la salle qu’on désigne', async () => {
    const wrapper = mount(RoomsStrip, { props: { payload: voisine(), nowMs: DEBUT_MS } })

    await wrapper.get('[data-salle="track-2"]').trigger('click')

    expect(wrapper.emitted('open')).toEqual([['track-2']])
  })
})

describe('timeline', () => {
  it('surligne le créneau en cours, et atténue ce qui est passé', () => {
    const wrapper = mount(Timeline, {
      props: {
        sessions: VOISINE as never,
        timeZone: 'Europe/Paris',
        currentId: 'v-2',
        nowMs: FIN_MS + 60_000,
      },
    })

    // La timeline fait une journée : sans surlignage, on ouvre la modale sur un
    // mur de titres où retrouver l'heure prend plus de temps qu'on n'en a.
    const lignes = wrapper.findAll('[data-role="timeline"] > div')
    expect(lignes[1]?.attributes('data-actuel')).toBe('true')
    expect(lignes[0]?.classes()).toContain('opacity-35')
  })

  it('dit qu’il n’y a aucune session plutôt que de rendre un vide', () => {
    const wrapper = mount(Timeline, {
      props: { sessions: [], timeZone: 'Europe/Paris', currentId: null, nowMs: DEBUT_MS },
    })
    expect(wrapper.text()).toBe('Aucune session.')
  })
})

describe('onglet des salles', () => {
  it('dit « salle muette » plutôt que de reprendre le mot du programme', () => {
    const wrapper = mount(RoomsTab, {
      props: { payload: voisine({ connectivity: 'OFFLINE' }), nowMs: DEBUT_MS },
    })

    // Reprendre le mot du programme laisserait croire qu'on sait encore ce qui
    // s'y joue.
    expect(wrapper.get('[data-salle="track-2"]').text()).toContain('salle muette')
  })

  it('date la vue au lieu de la vider quand le hub ne répond plus', () => {
    const etat = voisine()
    etat.diagnostics!.roomsRefreshedAt = new Date(Date.now() - 300_000).toISOString()
    const wrapper = mount(RoomsTab, { props: { payload: etat, nowMs: DEBUT_MS } })

    // Une liste vide se lirait « aucune salle ». Ce qui est affiché n'est plus
    // l'état des salles mais le souvenir qu'on en a.
    expect(wrapper.text()).toContain('Vue datée de 5 min')
  })

  it('dit qu’aucune salle n’est connue, plutôt que de ne rien montrer', () => {
    const wrapper = mount(RoomsTab, { props: { payload: payload(), nowMs: DEBUT_MS } })
    expect(wrapper.text()).toBe('Aucune salle connue du hub.')
  })
})

describe('onglet des questions', () => {
  const QUESTIONS = [
    { id: 'q-1', text: 'Et le coût ?', author: 'Léa', votes: 7 },
    { id: 'q-2', text: 'Compatible ARM ?', author: null, votes: 3 },
  ]

  function avecQuestions(onAir: string | null = null) {
    const etat = payload()
    etat.diagnostics!.questions = QUESTIONS
    etat.diagnostics!.questionsSession = { id: 'talk-1', title: 'Ce que le flux ne dit pas' }
    etat.state.question = onAir == null ? null : ({ text: onAir, author: null } as never)
    return mount(QuestionsTab, { props: { payload: etat } })
  }

  it('nomme le talk dont il lit les questions', () => {
    // Sans ce rappel, une liste vide se lit « personne n'a rien demandé » alors
    // qu'elle veut parfois dire « aucun talk n'est piloté ».
    expect(avecQuestions().text()).toContain('Ce que le flux ne dit pas')
  })

  it('le dit quand aucune conférence n’est pilotée', () => {
    const wrapper = mount(QuestionsTab, { props: { payload: payload() } })
    expect(wrapper.text()).toContain('Aucune conférence pilotée')
  })

  it('reconnaît la question déjà à l’antenne', () => {
    const wrapper = avecQuestions('Et le coût ?')

    // Sinon on la remet, ou on cherche laquelle est projetée en relisant les
    // trois premières — pendant que le speaker attend.
    expect(wrapper.get('[data-question="q-1"]').text()).toContain('À l’antenne')
    expect(wrapper.get('[data-question="q-2"]').text()).toContain('Afficher')
  })

  it('met une question à l’antenne, avec son auteur', async () => {
    const wrapper = avecQuestions()

    await wrapper.get('[data-question="q-1"] button').trigger('click')
    await flushPromises()

    expect(envois[0]?.body).toEqual({
      action: 'question.set',
      text: 'Et le coût ?',
      author: 'Léa',
    })
  })

  it('relit la liste, parce qu’une liste d’il y a une heure ne vaut rien', async () => {
    const wrapper = avecQuestions()

    await wrapper.findAll('button')[0]!.trigger('click')
    await flushPromises()

    expect(envois[0]?.body).toEqual({ action: 'questions.refresh' })
  })

  it('date la dernière relecture, ou dit qu’il n’y en a jamais eu', () => {
    expect(avecQuestions().text()).toContain('Jamais relues')
  })

  it('retire de l’antenne sans rien afficher d’autre', async () => {
    const wrapper = avecQuestions('Et le coût ?')

    await wrapper.findAll('button')[1]!.trigger('click')
    await flushPromises()

    expect(envois[0]?.body).toEqual({ action: 'question.set', text: null })
  })

  it('dit ce qu’« Afficher » ne fait pas', () => {
    // Sans le dire, on clique et on cherche la question sur le
    // vidéoprojecteur.
    expect(avecQuestions().text()).toContain('Question choisie')
  })
})

describe('signalements', () => {
  function avecSignalement(atMs: number, nowMs: number) {
    const etat = payload()
    etat.state.notifications = [
      { id: 'n-1', level: 'warning', text: 'Track #2 vient de terminer', at: new Date(atMs).toISOString() },
    ] as never
    return mount(NotificationStack, { props: { payload: etat, nowMs } })
  }

  it('tombe de lui-même au bout de trente secondes', () => {
    // Un bandeau qui ne part pas cesse d'être lu : la régie finissait la
    // journée avec cinq signalements empilés au-dessus des commandes.
    expect(avecSignalement(DEBUT_MS, DEBUT_MS + 31_000).find('[data-notification="n-1"]').exists()).toBe(
      false,
    )
    expect(avecSignalement(DEBUT_MS, DEBUT_MS + 5_000).find('[data-notification="n-1"]').exists()).toBe(
      true,
    )
  })

  it('n’affiche rien quand il n’y a rien à signaler', () => {
    const wrapper = mount(NotificationStack, { props: { payload: payload(), nowMs: DEBUT_MS } })
    // Un conteneur vide occuperait sa place dans la pile du bas, en permanence.
    expect(wrapper.find('[data-role="notifications"]').exists()).toBe(false)
  })

  it('peint le fond à la couleur du type, et le texte en sombre', () => {
    const etat = payload()
    etat.state.notifications = [
      { id: 'n-1', level: 'info', text: 'une info', at: new Date(DEBUT_MS).toISOString() },
      { id: 'n-2', level: 'warning', text: 'un avertissement', at: new Date(DEBUT_MS).toISOString() },
    ] as never
    const wrapper = mount(NotificationStack, { props: { payload: etat, nowMs: DEBUT_MS + 1000 } })

    // Un fond plein, pas une teinte sourde : ces encarts doivent se lire du
    // coin de l'œil, par un opérateur qui regarde la salle.
    expect(wrapper.get('[data-notification="n-1"]').classes()).toContain('bg-marque')
    expect(wrapper.get('[data-notification="n-2"]').classes()).toContain('bg-attention')
    // Et un texte sombre, seule paire lisible sur de l'ambre.
    expect(wrapper.get('[data-notification="n-2"]').classes()).toContain('text-[#05070d]')
  })

  it('reste écarté le temps que le retrait fasse le tour', async () => {
    const wrapper = avecSignalement(DEBUT_MS, DEBUT_MS + 5_000)

    await wrapper.get('[data-notification="n-1"] button').trigger('click')

    // L'état continue de le pousser le temps que la demande atteigne le
    // runtime : sans la liste locale, la croix le rendrait pour une seconde.
    expect(wrapper.find('[data-notification="n-1"]').exists()).toBe(false)
    expect(envois[0]?.body).toEqual({ action: 'notification.dismiss', id: 'n-1' })
  })
})

describe('diagnostic', () => {
  it('signale un rôle configuré qu’OBS ne connaît pas', () => {
    const etat = payload()
    etat.diagnostics!.obs = {
      A: { connected: true, currentSceneName: 'Scène 1', unresolvedRoles: ['RELAY'] } as never,
      B: null,
    }
    const wrapper = mount(DiagnosticsPanel, { props: { payload: etat } })

    // Ça ne se voit nulle part ailleurs : la bascule échouera au milieu d'un
    // talk, sans autre signe avant-coureur.
    expect(wrapper.get('[data-obs="A"]').text()).toContain('rôles absents : RELAY')
    expect(wrapper.get('[data-obs="B"]').text()).toContain('déconnecté')
  })

  it('dit la lecture seule plutôt que deux OBS muets', () => {
    const etat = payload({ diagnostics: null })
    const wrapper = mount(DiagnosticsPanel, { props: { payload: etat } })

    // Deux lignes vides se liraient comme deux OBS déconnectés, alors que ce
    // poste ne pilote simplement rien.
    expect(wrapper.text()).toContain('Régie en lecture seule')
  })
})
