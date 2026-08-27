import { useToast } from '@cloudnord/components'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ConferencePanel from '../src/components/ConferencePanel.vue'
import { TOO_EARLY_MS, useConferenceStore } from '../src/stores/conference.js'
import { useRoomStore } from '../src/stores/room.js'
import { DEBUT_MS, FIN_MS, payload, talk } from './fixtures.js'

/**
 * Commencer et terminer, et les trois questions qui se mettent en travers.
 *
 * Ce sont les deux gestes de la journée qu'on ne peut pas défaire d'un clic :
 * l'un inscrit un talk comme tenu à une heure, l'autre le clôt devant les
 * autres régies. Leur ordre — l'avance avant l'enregistrement — est le fond du
 * sujet, pas un détail d'implémentation.
 */

interface Envoi {
  body: unknown
}

let envois: Envoi[]
let refuse: string | null

function stubFetch(): void {
  envois = []
  refuse = null
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { action: string }
    envois.push({ body })
    const ok = body.action !== refuse
    return new Response(JSON.stringify({ ok, message: ok ? 'Fait' : 'Refusé' }), {
      headers: { 'content-type': 'application/json' },
    })
  })
}

/** Une salle placée à un instant donné, avec l'horloge arrêtée là. */
function salleA(atMs: number, overrides: Record<string, unknown> = {}): void {
  const etat = payload()
  Object.assign(etat.state, overrides)
  // Le décalage porte l'heure de la salle : le store lit `clock.real + offset`,
  // et l'horloge n'avance pas d'elle-même dans un test.
  etat.state.serverTimeOffsetMs = atMs - Date.now()
  useRoomStore().seed(etat)
}

const actions = (): string[] => envois.map((envoi) => (envoi.body as { action: string }).action)

beforeEach(() => {
  setActivePinia(createPinia())
  useToast().clear()
  stubFetch()
})

describe('commencer', () => {
  it('démarre sans rien demander quand l’heure est proche', async () => {
    salleA(DEBUT_MS - 60_000)
    // La captation tourne déjà : l'autre garde-fou n'a rien à dire, et c'est
    // celui de l'avance qu'on regarde ici.
    useRoomStore().payload!.diagnostics!.recording = {
      active: true,
      markers: 0,
      startedAtMs: 0,
      startedAtCorrigeMs: null,
    }
    const conference = useConferenceStore()

    conference.askStart()
    await flushPromises()

    // Lancer une minute avant l'heure est le geste normal du matin : le
    // confirmer à chaque fois en ferait un réflexe.
    expect(conference.tooEarlyOpen).toBe(false)
    expect(actions()).toEqual(['session.start', 'scene.set'])
  })

  it('demande confirmation très en avance, et dit de combien', async () => {
    salleA(DEBUT_MS - TOO_EARLY_MS - 60_000)
    const conference = useConferenceStore()

    conference.askStart()
    await flushPromises()

    /*
     * Un « Commencer » de trop y écrivait un talk tenu de 08:45 à 08:45 — un
     * créneau marqué comme s'étant déroulé alors que la salle était vide.
     */
    expect(conference.tooEarlyOpen).toBe(true)
    expect(actions()).toEqual([])
    expect(conference.tooEarlyDetail).toContain('16 min')
    expect(conference.tooEarlyDetail).toContain('est au programme à')
  })

  it('pose la question de l’avance avant celle de l’enregistrement', async () => {
    salleA(DEBUT_MS - TOO_EARLY_MS - 60_000)
    const conference = useConferenceStore()

    conference.askStart()
    await flushPromises()

    /*
     * L'une porte sur la conférence qu'on lance, l'autre sur la manière de la
     * lancer. Dans l'autre ordre, une captation démarrerait pour un talk qu'on
     * va renoncer à lancer.
     */
    expect(conference.tooEarlyOpen).toBe(true)
    expect(conference.recordingOpen).toBe(false)
  })
})

describe('l’avertissement de captation', () => {
  it('se pose quand rien n’enregistre', async () => {
    salleA(DEBUT_MS)
    const conference = useConferenceStore()

    conference.askStart()
    await flushPromises()

    // La question n'a de sens qu'avant : une fois la conférence lancée,
    // l'enregistrement démarré manquera toujours les premières minutes.
    expect(conference.recordingOpen).toBe(true)
    expect(actions()).toEqual([])
  })

  it('se tait quand la captation tourne déjà', async () => {
    salleA(DEBUT_MS)
    const room = useRoomStore()
    room.payload!.diagnostics!.recording = {
      active: true,
      markers: 0,
      startedAtMs: 0,
      startedAtCorrigeMs: null,
    }
    const conference = useConferenceStore()

    conference.askStart()
    await flushPromises()

    expect(conference.recordingOpen).toBe(false)
    expect(actions()).toEqual(['session.start', 'scene.set'])
  })

  it('se tait quand la salle a décoché le garde-fou', async () => {
    salleA(DEBUT_MS)
    const room = useRoomStore()
    room.payload!.diagnostics!.config = { promptRecordingOnStart: false } as never
    const conference = useConferenceStore()

    conference.askStart()
    await flushPromises()

    expect(conference.recordingOpen).toBe(false)
  })

  it('garde le garde-fou quand le réglage n’est pas encore arrivé', async () => {
    salleA(DEBUT_MS)
    const conference = useConferenceStore()

    conference.askStart()
    await flushPromises()

    // Lire un champ absent comme « ne rien faire » désactiverait un garde-fou
    // en silence, ce qui est exactement ce qu'il est censé empêcher.
    expect(conference.recordingOpen).toBe(true)
  })

  it('enregistre d’abord, et seulement s’il part', async () => {
    salleA(DEBUT_MS)
    const conference = useConferenceStore()
    refuse = 'recording.start'

    await conference.launch(true)

    // Commencer quand même rendrait l'avertissement mensonger la prochaine
    // fois : il aurait dit « enregistre » sur un talk qui ne l'était pas.
    expect(actions()).toEqual(['recording.start'])
  })

  it('enchaîne captation, conférence, puis scène', async () => {
    salleA(DEBUT_MS)
    const conference = useConferenceStore()

    await conference.launch(true)

    // La scène après le démarrage : une bascule sans conférence lancée
    // laisserait la salle à l'antenne sur rien.
    expect(actions()).toEqual(['recording.start', 'session.start', 'scene.set'])
  })

  it('ne bascule aucune scène quand la salle a choisi de ne pas basculer', async () => {
    salleA(DEBUT_MS)
    useRoomStore().payload!.diagnostics!.config = { sceneOnStart: null } as never
    const conference = useConferenceStore()

    await conference.launch(false)

    // `null` est un choix explicite, distinct d'un réglage absent.
    expect(actions()).toEqual(['session.start'])
  })
})

describe('terminer', () => {
  it('termine sans rien demander à l’heure ou en dépassement', async () => {
    salleA(FIN_MS + 60_000)
    const conference = useConferenceStore()

    conference.askEnd()
    await flushPromises()

    // Terminer à l'heure est le geste normal de la journée : le confirmer à
    // chaque fois reviendrait à ne plus le lire du tout.
    expect(conference.endEarlyOpen).toBe(false)
    expect(actions()).toEqual(['session.end'])
  })

  it('demande confirmation en avance, et dit ce que ça change', async () => {
    salleA(FIN_MS - 8 * 60_000)
    const conference = useConferenceStore()

    conference.askEnd()
    await flushPromises()

    expect(conference.endEarlyOpen).toBe(true)
    expect(actions()).toEqual([])
    expect(conference.endEarlyDetail).toContain('8 min')
    expect(conference.endEarlyDetail).toContain('les autres régies le verront')
  })

  it('ne demande rien sur un créneau sans heure de fin', async () => {
    const etat = payload({ sessions: [talk({ endsAtMs: null })] as never })
    etat.state.targetSession = talk({ endsAtMs: null }) as never
    etat.state.serverTimeOffsetMs = DEBUT_MS - Date.now()
    useRoomStore().seed(etat)
    const conference = useConferenceStore()

    conference.askEnd()
    await flushPromises()

    // Pas d'avance possible : rien à demander.
    expect(conference.endEarlyOpen).toBe(false)
    expect(actions()).toEqual(['session.end'])
  })
})

describe('panneau de la conférence', () => {
  function monter(atMs: number, states: Record<string, string> = {}) {
    const etat = payload()
    etat.state.sessionStates = states as never
    return mount(ConferencePanel, { props: { payload: etat, nowMs: atMs } })
  }

  it('refuse un geste que le hub refuserait, et dit pourquoi', () => {
    const wrapper = monter(DEBUT_MS)

    // La table du cycle de vie est celle que le hub applique en écriture : un
    // bouton actif dont la procédure refuserait le geste n'est plus possible.
    const terminer = wrapper.get('#btn-conf-terminer')
    expect(terminer.attributes('disabled')).toBeDefined()
    expect(terminer.attributes('title')).toBeTruthy()
  })

  it('nomme ce que le décompte vise une fois la conférence terminée', () => {
    const suivante = talk({ id: 'talk-2', startsAtMs: FIN_MS + 900_000, endsAtMs: null })
    const etat = payload({ sessions: [talk(), suivante] as never })
    etat.state.sessionStates = { 'talk-1': 'ended' } as never
    const wrapper = mount(ConferencePanel, { props: { payload: etat, nowMs: FIN_MS } })

    /*
     * Le grand nombre compte jusqu'à la prochaine conférence, la ligne
     * « Suivant » annonce le prochain *créneau* — qui peut être une pause. Les
     * deux différaient sans que rien ne l'explique.
     */
    expect(wrapper.get('[data-role="conference-detail"]').text()).toContain(
      'Prochaine conférence à',
    )
    expect(wrapper.get('[data-role="conference-detail"]').text()).toContain('Remettre à venir')
  })

  it('peint le dépassement en alerte : c’est lui qui déclenche une décision', () => {
    const wrapper = monter(FIN_MS + 600_000, { 'talk-1': 'running' })

    expect(wrapper.get('[data-role="conference-detail"]').text()).toContain('dépassement de')
    expect(wrapper.get('[data-role="conference-detail"]').classes()).toContain('text-alerte')
  })

  it('dit qu’il n’y a rien à piloter plutôt que de laisser un titre vide', () => {
    const etat = payload()
    etat.state.targetSession = null
    const wrapper = mount(ConferencePanel, { props: { payload: etat, nowMs: DEBUT_MS } })

    expect(wrapper.get('[data-role="conference-title"]').text()).toBe(
      'Aucune conférence à piloter',
    )
    expect(wrapper.get('#btn-conf-demarrer').attributes('disabled')).toBeDefined()
  })

  it('annonce l’heure devant le titre tant que le créneau n’a pas commencé', () => {
    const etat = payload()
    etat.state.targetIsUpcoming = true
    const wrapper = mount(ConferencePanel, { props: { payload: etat, nowMs: DEBUT_MS - 600_000 } })

    expect(wrapper.get('[data-role="conference-title"]').text()).toContain('·')
    expect(wrapper.get('[data-role="conference-detail"]').text()).toContain(
      'Pas encore commencée au programme',
    )
  })

  it('dit que plus rien ne suit, plutôt que de ne rien dire', () => {
    expect(monter(DEBUT_MS).get('[data-role="next"]').text()).toBe('Plus rien après au programme.')
  })
})

describe('intervenants', () => {
  it('les sépare quand ils sont plusieurs', () => {
    const etat = payload()
    etat.state.targetSession = talk({
      speakers: [{ name: 'Steven' }, { name: 'Nuno' }],
    }) as never
    const wrapper = mount(ConferencePanel, { props: { payload: etat, nowMs: DEBUT_MS } })

    expect(wrapper.text()).toContain('Steven · Nuno')
  })

  it('se retire sur un créneau sans speaker, plutôt que de laisser un vide', () => {
    // Une ligne vide sous « Pause déjeuner » ferait chercher un nom absent.
    const etat = payload()
    etat.state.targetSession = talk({ kind: 'break', speakers: [] }) as never
    const wrapper = mount(ConferencePanel, { props: { payload: etat, nowMs: DEBUT_MS } })

    expect(wrapper.text()).not.toContain('·')
  })

  it('donne aussi celui de la conférence suivante', () => {
    const suivante = talk({
      id: 'talk-2',
      title: 'Blind ops',
      startsAtMs: FIN_MS + 600_000,
      endsAtMs: null,
      speakers: [{ name: 'Nuno' }],
    })
    const etat = payload({ sessions: [talk(), suivante] as never })
    const wrapper = mount(ConferencePanel, { props: { payload: etat, nowMs: DEBUT_MS } })

    expect(wrapper.get('[data-role="next"]').text()).toContain('Blind ops')
    expect(wrapper.get('[data-role="next"]').text()).toContain('Nuno')
  })
})

describe('les deux boutons suivent la table du cycle de vie', () => {
  function boutons(statut: string | null) {
    const etat = payload()
    etat.state.sessionStates = (statut == null ? {} : { 'talk-1': statut }) as never
    const wrapper = mount(ConferencePanel, { props: { payload: etat, nowMs: DEBUT_MS } })
    return {
      demarrer: wrapper.get('#btn-conf-demarrer'),
      terminer: wrapper.get('#btn-conf-terminer'),
    }
  }

  it('dit pourquoi « Terminer » est fermé sur une conférence non lancée', () => {
    const { demarrer, terminer } = boutons(null)

    expect(terminer.attributes('disabled')).toBeDefined()
    expect(terminer.attributes('title')).toContain("n'a pas été lancée")
    // Le geste possible, lui, n'a rien à expliquer.
    expect(demarrer.attributes('disabled')).toBeUndefined()
    expect(demarrer.attributes('title')).toBeUndefined()
  })

  it('dit pourquoi « Commencer » est fermé sur un talk en cours', () => {
    const { demarrer, terminer } = boutons('running')

    expect(demarrer.attributes('title')).toContain('déjà lancée')
    expect(terminer.attributes('title')).toBeUndefined()
  })

  it('rouvre « Commencer » après une clôture, sans passer par « Remettre à venir »', () => {
    // Une conférence close par la règle horaire alors qu'elle n'était pas finie
    // se rattrape d'un geste.
    const { demarrer, terminer } = boutons('ended')

    expect(demarrer.attributes('disabled')).toBeUndefined()
    expect(terminer.attributes('title')).toContain('déjà terminée')
  })
})

describe('terminée avant son créneau', () => {
  /** Le talk de 09:00 n'a pas commencé, et un autre suit à 11:00. */
  function avantLeCreneau(statuts: Record<string, string>) {
    const apres = talk({
      id: 'talk-2',
      title: 'Le talk suivant',
      startsAt: '2026-10-30T11:00:00.000Z',
      startsAtMs: Date.parse('2026-10-30T11:00:00Z'),
      endsAtMs: Date.parse('2026-10-30T11:50:00Z'),
    })
    const etat = payload({ sessions: [talk(), apres] as never })
    etat.state.targetIsUpcoming = true
    etat.state.sessionStates = statuts as never
    return etat
  }

  it('ne se désigne pas elle-même comme prochaine conférence', () => {
    const etat = avantLeCreneau({ 'talk-1': 'ended' })
    const wrapper = mount(ConferencePanel, {
      props: { payload: etat, nowMs: Date.parse('2026-10-30T08:00:00Z') },
    })

    /*
     * La salle se désignait elle-même : le détail annonçait « prochaine
     * conférence à 09:50 » sur la conférence de 09:50 qu'on venait de terminer.
     * 11:00 UTC, soit 12:00 à Paris.
     */
    expect(wrapper.get('[data-role="conference-badge"]').text()).toBe('terminée')
    expect(wrapper.get('[data-role="conference-detail"]').text()).toContain('12:00')
    expect(wrapper.get('[data-role="conference-detail"]').text()).not.toContain('10:00')
  })

  it('ne saute rien tant que la conférence tient toujours', () => {
    // Sans décision, la prochaine conférence reste celle du créneau — c'est ce
    // que vise « Commencer », et les deux doivent désigner le même.
    const wrapper = mount(ConferencePanel, {
      props: { payload: avantLeCreneau({}), nowMs: Date.parse('2026-10-30T08:00:00Z') },
    })

    expect(wrapper.get('[data-role="conference-badge"]').text()).toBe('à venir')
    expect(wrapper.get('[data-role="conference-detail"]').text()).toContain('Commencer')
  })
})
