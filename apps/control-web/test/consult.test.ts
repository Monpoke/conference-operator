import { useToast } from '@cloudnord/components'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DiagnosticsPanel from '../src/components/DiagnosticsPanel.vue'
import NotificationStack from '../src/components/NotificationStack.vue'
import QuestionsTab from '../src/components/QuestionsTab.vue'
import RoomsStrip from '../src/components/RoomsStrip.vue'
import RoomsTab from '../src/components/RoomsTab.vue'
import Timeline from '../src/components/Timeline.vue'
import type { Session } from '@cloudnord/program'
import { stripEntry } from '../src/lib/rooms.js'
import { useProgramsStore } from '../src/stores/programs.js'
import { START_MS, END_MS, obsState, payload, talk } from './fixtures.js'

/**
 * What one goes looking for, and what comes to one.
 *
 * The neighbouring rooms strip is the day's only piece of information an operator
 * cannot deduce from their own screen, and it decides a schedule shift: "the other
 * room finishes in 3 minutes, we do not start now".
 */

interface Call {
  body: unknown
}

let calls: Call[]
let refused: boolean

const NEIGHBOUR: Session[] = [
  talk({ id: 'v-1', title: 'Terraform sans peur', startsAtMs: START_MS, endsAtMs: END_MS }),
  talk({
    id: 'v-2',
    title: 'Déjeuner',
    kind: 'break',
    startsAtMs: END_MS,
    endsAtMs: END_MS + 3_600_000,
    startsAt: '2026-10-30T09:45:00.000Z',
  }),
]

beforeEach(() => {
  setActivePinia(createPinia())
  calls = []
  refused = false
  useToast().clear()
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    calls.push({ body: init?.body == null ? null : JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ ok: !refused, message: refused ? 'Refusé' : undefined }), {
      headers: { 'content-type': 'application/json' },
    })
  })
})

/** Une room neighbour, avec son programme en cache et ce que le hub en dit. */
function neighbour(overrides: Record<string, unknown> = {}) {
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
  programs.sessions = { 'track-2': NEIGHBOUR }
  return etat
}

describe('what one strip cell says', () => {
  const room = { id: 'track-2', name: 'Track #2', connectivity: 'ONLINE' }

  it('announces the end as it approaches, with the number that decides', () => {
    const entry = stripEntry(neighbour({ conference: 'fin-proche' }), room, NEIGHBOUR, END_MS - 180_000)

    // "The other room finishes in 3 minutes" is the sentence that makes one wait
    // or start, and it can be deduced from no other screen.
    expect(entry.detail).toBe('vers la fin · 3 min')
    expect(entry.tint).toBe('text-warn')
  })

  it('gives the resumption time during a break, not the meal\'s name', () => {
    const entry = stripEntry(neighbour({ conference: 'pause' }), room, NEIGHBOUR, END_MS + 60_000)

    /*
     * "Déjeuner" in place of a talk title read as a busy room. What decides here is
     * the resumption time.
     */
    expect(entry.label).toBe('')
    expect(entry.detail).toContain('pause')
  })

  it('names the talk that is overrunning, and paints it in alert', () => {
    const etat = neighbour({ conference: 'depassement', currentSessionId: 'v-1' })
    const entry = stripEntry(etat, room, NEIGHBOUR, END_MS + 600_000)

    // The program has moved on to the next slot; the room has not. The room is
    // right, and that is what shifts the whole day.
    expect(entry.label).toBe('Terraform sans peur')
    expect(entry.tint).toBe('text-alert')
  })

  it('admits an unknown program rather than announce an out-of-slot', () => {
    const entry = stripEntry(neighbour(), room, [], START_MS)

    // "Hors créneau" would read as a room with nothing scheduled, when
    // qu'on ignore tout de la sienne.
    expect(entry.detail).toBe('programme inconnu')
  })

  it('hollows out a silent room\'s dot, without changing what it says', () => {
    const entry = stripEntry(
      neighbour({ connectivity: 'OFFLINE' }),
      { ...room, connectivity: 'OFFLINE' },
      NEIGHBOUR,
      START_MS + 60_000,
    )

    // Le remplissage reste celui du programme : on ne sait plus si elle le
    // follows, and claiming it in colour would be worse than staying silent.
    expect(entry.dot).toContain('silent')
  })

  it('announces an upcoming break while a talk is still running', () => {
    const entry = stripEntry(neighbour(), room, NEIGHBOUR, END_MS - 300_000)
    expect(entry.breakTag).toEqual({ text: 'BREAK à venir', tint: 'text-warn' })
  })
})

describe('rooms strip', () => {
  it('disappears entirely at a single-room event', () => {
    const etat = payload()
    const wrapper = mount(RoomsStrip, { props: { payload: etat, nowMs: START_MS } })

    // An empty strip takes up a line on a control screen that has none to
    // trop.
    expect(wrapper.find('[data-role="rooms-strip"]').exists()).toBe(false)
  })

  it('opens the program of the room one points at', async () => {
    const wrapper = mount(RoomsStrip, { props: { payload: neighbour(), nowMs: START_MS } })

    await wrapper.get('[data-room="track-2"]').trigger('click')

    expect(wrapper.emitted('open')).toEqual([['track-2']])
  })
})

describe('timeline', () => {
  it('highlights the current slot, and dims what has passed', () => {
    const wrapper = mount(Timeline, {
      props: {
        sessions: NEIGHBOUR,
        timeZone: 'Europe/Paris',
        currentId: 'v-2',
        nowMs: END_MS + 60_000,
      },
    })

    // The timeline spans a day: with no highlight, one opens the modal onto a wall
    // of titles where finding the hour takes longer than one has.
    const rows = wrapper.findAll('[data-role="timeline"] > div')
    expect(rows[1]?.attributes('data-current')).toBe('true')
    expect(rows[0]?.classes()).toContain('opacity-35')
  })

  it('says there is no session rather than render a blank', () => {
    const wrapper = mount(Timeline, {
      props: { sessions: [], timeZone: 'Europe/Paris', currentId: null, nowMs: START_MS },
    })
    expect(wrapper.text()).toBe('Aucune session.')
  })
})

describe('rooms tab', () => {
  it('says "salle muette" rather than reuse the program\'s word', () => {
    const wrapper = mount(RoomsTab, {
      props: { payload: neighbour({ connectivity: 'OFFLINE' }), nowMs: START_MS },
    })

    // Reprendre le mot du programme laisserait croire qu'on sait encore ce qui
    // s'y joue.
    expect(wrapper.get('[data-room="track-2"]').text()).toContain('salle muette')
  })

  it('dates the view instead of emptying it when the hub stops answering', () => {
    const etat = neighbour()
    etat.diagnostics!.roomsRefreshedAt = new Date(Date.now() - 300_000).toISOString()
    const wrapper = mount(RoomsTab, { props: { payload: etat, nowMs: START_MS } })

    // An empty list would read as "no rooms". What is displayed is no longer the
    // rooms' state but our memory of it.
    expect(wrapper.text()).toContain('Vue datée de 5 min')
  })

  it('says no room is known, rather than show nothing', () => {
    const wrapper = mount(RoomsTab, { props: { payload: payload(), nowMs: START_MS } })
    expect(wrapper.text()).toBe('Aucune salle connue du hub.')
  })
})

describe('questions tab', () => {
  const QUESTIONS = [
    { id: 'q-1', text: 'Et le coût ?', author: 'Léa', votes: 7 },
    { id: 'q-2', text: 'Compatible ARM ?', author: null, votes: 3 },
  ]

  function avecQuestions(onAir: string | null = null) {
    const etat = payload()
    etat.diagnostics!.questions = QUESTIONS
    etat.diagnostics!.questionsSession = { id: 'talk-1', title: 'Ce que le flux ne dit pas' }
    etat.state.question = onAir == null ? null : { text: onAir, author: null, sessionId: null }
    return mount(QuestionsTab, { props: { payload: etat } })
  }

  it('nomme le talk dont il lit les questions', () => {
    // Without that reminder, an empty list reads as "nobody has asked anything"
    // when it sometimes means "no talk is being driven".
    expect(avecQuestions().text()).toContain('Ce que le flux ne dit pas')
  })

  it('says so when no talk is being driven', () => {
    const wrapper = mount(QuestionsTab, { props: { payload: payload() } })
    expect(wrapper.text()).toContain('Aucune conférence pilotée')
  })

  it('recognises the question already on air', () => {
    const wrapper = avecQuestions('Et le coût ?')

    // Otherwise one puts it up again, or hunts for which is projected by re-reading
    // the first three — while the speaker waits.
    expect(wrapper.get('[data-question="q-1"]').text()).toContain('À l’antenne')
    expect(wrapper.get('[data-question="q-2"]').text()).toContain('Afficher')
  })

  it('puts a question on air, with its author', async () => {
    const wrapper = avecQuestions()

    await wrapper.get('[data-question="q-1"] button').trigger('click')
    await flushPromises()

    expect(calls[0]?.body).toEqual({
      action: 'question.set',
      text: 'Et le coût ?',
      author: 'Léa',
    })
  })

  it('relit la liste, parce qu’une liste d’il y a une heure ne vaut rien', async () => {
    const wrapper = avecQuestions()

    await wrapper.findAll('button')[0]!.trigger('click')
    await flushPromises()

    expect(calls[0]?.body).toEqual({ action: 'questions.refresh' })
  })

  it('dates the last refresh, or says there has never been one', () => {
    expect(avecQuestions().text()).toContain('Jamais relues')
  })

  it('retire de l’antenne sans rien afficher d’autre', async () => {
    const wrapper = avecQuestions('Et le coût ?')

    await wrapper.findAll('button')[1]!.trigger('click')
    await flushPromises()

    expect(calls[0]?.body).toEqual({ action: 'question.set', text: null })
  })

  it('says what "Afficher" does not do', () => {
    // Sans le dire, on clique et on cherche la question sur le
    // projector.
    expect(avecQuestions().text()).toContain('Question choisie')
  })
})

describe('notices', () => {
  function withNotice(atMs: number, nowMs: number) {
    const etat = payload()
    etat.state.notifications = [
      { id: 'n-1', level: 'warning', text: 'Track #2 vient de terminer', at: new Date(atMs).toISOString() },
    ]
    return mount(NotificationStack, { props: { payload: etat, nowMs } })
  }

  it('falls away by itself after thirty seconds', () => {
    // A banner that does not go away stops being read: the control app used to end
    // the day with five notices stacked above the commands.
    expect(withNotice(START_MS, START_MS + 31_000).find('[data-notification="n-1"]').exists()).toBe(
      false,
    )
    expect(withNotice(START_MS, START_MS + 5_000).find('[data-notification="n-1"]').exists()).toBe(
      true,
    )
  })

  it('displays nothing when there is nothing to report', () => {
    const wrapper = mount(NotificationStack, { props: { payload: payload(), nowMs: START_MS } })
    // Un conteneur vide occuperait sa place dans la pile du bas, en permanence.
    expect(wrapper.find('[data-role="notifications"]').exists()).toBe(false)
  })

  it('paints the background in the level\'s colour, and the text dark', () => {
    const etat = payload()
    etat.state.notifications = [
      { id: 'n-1', level: 'info', text: 'une info', at: new Date(START_MS).toISOString() },
      { id: 'n-2', level: 'warning', text: 'un avertissement', at: new Date(START_MS).toISOString() },
    ]
    const wrapper = mount(NotificationStack, { props: { payload: etat, nowMs: START_MS + 1000 } })

    // Un fond plein, pas une teinte sourde : ces encarts doivent se lire du
    // corner of the eye, by an operator watching the room.
    expect(wrapper.get('[data-notification="n-1"]').classes()).toContain('bg-brand')
    expect(wrapper.get('[data-notification="n-2"]').classes()).toContain('bg-warn')
    // Et un texte sombre, seule paire lisible sur de l'ambre.
    expect(wrapper.get('[data-notification="n-2"]').classes()).toContain('text-[#05070d]')
  })

  it('is dismissed by a click anywhere, not only on the cross', async () => {
    const wrapper = withNotice(START_MS, START_MS + 5_000)

    /*
     * Aiming at a twelve-pixel cross in a dark room means stopping and looking —
     * that is, taking one's eyes off what is happening on stage, for a gesture that
     * does not deserve it.
     */
    await wrapper.get('[data-notification="n-1"]').trigger('click')

    // And the state goes on pushing it until the request reaches the runtime:
    // without the local list it would reappear for a second.
    expect(wrapper.find('[data-notification="n-1"]').exists()).toBe(false)
    expect(calls[0]?.body).toEqual({ action: 'notification.dismiss', id: 'n-1' })
  })

  it('se met au clavier, comme tout ce qui agit', async () => {
    const wrapper = withNotice(START_MS, START_MS + 5_000)
    // A `<div>` listening for the click cannot be reached by tabbing and does not
    // answer Enter.
    expect(wrapper.get('[data-notification="n-1"]').element.tagName).toBe('BUTTON')
  })

  it('does not announce the removal: the card disappearing already says it', async () => {
    const wrapper = withNotice(START_MS, START_MS + 5_000)

    await wrapper.get('[data-notification="n-1"]').trigger('click')
    await flushPromises()

    /*
     * The notice stack and the toasts share the bottom of the screen: a "Fait"
     * reappeared in the exact place of what one had just closed, and read as a new
     * notice.
     */
    expect(useToast().notices.value).toEqual([])
  })

  it('puts the notice back when the machine refuses to forget it', async () => {
    refused = true
    const wrapper = withNotice(START_MS, START_MS + 5_000)

    await wrapper.get('[data-notification="n-1"]').trigger('click')
    await flushPromises()

    /*
     * The local dismissal covers the round trip, it does not erase what the runtime
     * kept: without this reversal, a refused notice would stay invisible until the
     * reload — hidden from whoever dismissed it, and still there for everybody else.
     */
    expect(wrapper.find('[data-notification="n-1"]').exists()).toBe(true)
    expect(useToast().notices.value.at(-1)?.failed).toBe(true)
  })
})

describe('diagnostics', () => {
  it('reports a configured role OBS does not know', () => {
    const etat = payload()
    etat.diagnostics!.obs = { A: obsState({ unresolvedRoles: ['RELAY'] }), B: null }
    const wrapper = mount(DiagnosticsPanel, { props: { payload: etat } })

    // It is visible nowhere else: the switch will fail in the middle of a
    // talk, sans autre signe avant-coureur.
    expect(wrapper.get('[data-obs="A"]').text()).toContain('rôles absents : RELAY')
    expect(wrapper.get('[data-obs="B"]').text()).toContain('déconnecté')
  })

  it('says read-only rather than two silent OBS instances', () => {
    const etat = payload({ diagnostics: null })
    const wrapper = mount(DiagnosticsPanel, { props: { payload: etat } })

    // Two empty lines would read as two disconnected OBS instances, when what
    // poste ne pilote simplement rien.
    expect(wrapper.text()).toContain('Régie en lecture seule')
  })
})
