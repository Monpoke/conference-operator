import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ConferencesView from '../src/views/ConferencesView.vue'
import {
  overrideChoice,
  placeInDay,
  useConferencesStore,
  type PlannedSession,
} from '../src/stores/conferences.js'
import { useSessionStore } from '../src/stores/session.js'

/**
 * Conférences et planning.
 *
 * La vue la plus dense de la console, et celle où les décisions structurantes
 * sont les moins visibles : l'heure lue dans le fuseau de l'événement et non du
 * poste, le repère « en ce moment » calé sur l'horloge du hub qui peut être
 * simulée, la colonne d'action repliée parce qu'elle écrit là où six colonnes
 * lisent, et le menu qui n'offre que l'action contredisant l'export.
 *
 * Aucune de ces quatre-là ne se voit en relecture. Ce sont elles qu'on tient.
 */

interface Call {
  path: string
  input: unknown
}

const PARIS = 'Europe/Paris'

const TALK: PlannedSession = {
  id: 'talk-1',
  roomId: 'track-1',
  roomName: 'Track #1',
  title: 'Vue et les régies',
  kind: 'talk',
  speakers: ['Camille'],
  startsAt: '2026-10-30T09:00:00Z',
  endsAt: '2026-10-30T09:45:00Z',
  startedAt: null,
  endedAt: null,
  feedbackUrl: 'https://openfeedback.io/cloudnord/2026/talk-1',
  feedbackIdOverride: null,
  overriddenAs: null,
  sharedFrom: null,
}

const PAUSE: PlannedSession = {
  ...TALK,
  id: 'pause-1',
  title: 'Déjeuner',
  kind: 'break',
  speakers: [],
  startsAt: '2026-10-30T11:00:00Z',
  endsAt: '2026-10-30T12:00:00Z',
  feedbackUrl: null,
}

const HERITEE: PlannedSession = { ...PAUSE, id: 'pause-2', sharedFrom: 'track-1' }

function stub(options: {
  states?: unknown[]
  sessions?: PlannedSession[]
  serverTime?: string
  projectId?: string | null
  overrideError?: string
}): { calls: Call[]; client: unknown } {
  const calls: Call[] = []
  const note =
    (path: string, result: unknown, error?: string) =>
    async (input: unknown = undefined) => {
      calls.push({ path, input })
      if (error != null) throw new Error(error)
      return result
    }
  return {
    calls,
    client: {
      token: { read: () => 'jeton', write: () => {}, clear: () => {} },
      rpc: {
        sessions: {
          states: note('sessions/states', options.states ?? []),
          start: note('sessions/start', { ok: true }),
          end: note('sessions/end', { ok: true }),
          reset: note('sessions/reset', { ok: true }),
          override: note('sessions/override', { ok: true }, options.overrideError),
          feedbackId: note('sessions/feedbackId', { ok: true }),
        },
        program: {
          snapshots: note('program/snapshots', [{ active: true }]),
          planning: note('program/planning', {
            sessions: options.sessions ?? [TALK],
            rooms: [{ id: 'track-1', name: 'Track #1' }],
            timezone: PARIS,
            serverTime: options.serverTime ?? '2026-10-30T08:00:00Z',
            openFeedbackProjectId: options.projectId === undefined ? 'cloudnord' : options.projectId,
          }),
          controleOpenFeedback: note('program/controleOpenFeedback', {
            projet: 'cloudnord',
            projetTrouve: true,
            detail: 'Relevé à 09:00.',
            talksConnus: 27,
            manquants: [],
          }),
        },
        vod: { conference: note('vod/conference', {}), request: note('vod/request', { ok: true }) },
      },
    },
  }
}

async function monter(options: Parameters<typeof stub>[0] = {}): Promise<{
  calls: Call[]
  wrapper: ReturnType<typeof mount>
}> {
  const fake = stub(options)
  useSessionStore().client = fake.client as never
  const wrapper = mount(ConferencesView, { attachTo: document.body })
  await useConferencesStore().load()
  await flushPromises()
  return { calls: fake.calls, wrapper }
}

beforeEach(() => {
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})

describe('place dans la journée', () => {
  const midi = Date.parse('2026-10-30T09:20:00Z')

  it('tient un créneau sans fin pour en cours, pas pour passé', () => {
    // Il court jusqu'à preuve du contraire, plutôt que d'être déclaré passé à
    // la seconde où il commence.
    expect(placeInDay({ ...TALK, endsAt: null }, midi)).toBe('en-cours')
  })

  it.each([
    ['a-venir', '2026-10-30T10:00:00Z', '2026-10-30T10:45:00Z'],
    ['en-cours', '2026-10-30T09:00:00Z', '2026-10-30T09:45:00Z'],
    ['passe', '2026-10-30T08:00:00Z', '2026-10-30T08:45:00Z'],
  ])('situe %s', (attendu, startsAt, endsAt) => {
    expect(placeInDay({ ...TALK, startsAt, endsAt }, midi)).toBe(attendu)
  })
})

describe('menu de décision', () => {
  it("n'offre que l'action qui contredit l'export", () => {
    // L'autre ne ferait rien : proposer « considérer comme conférence » sur une
    // conférence est un choix sans effet, au milieu d'un tableau qu'on parcourt.
    expect(overrideChoice(TALK)).toEqual({ scheduled: 'talk', action: 'break' })
    expect(overrideChoice(PAUSE)).toEqual({ scheduled: 'break', action: 'talk' })
  })

  it('propose de revenir sur une décision déjà prise', () => {
    expect(overrideChoice({ ...TALK, overriddenAs: 'break' })).toEqual({
      scheduled: 'talk',
      action: 'break',
    })
  })
})

describe('vue des conférences', () => {
  it("lit les heures dans le fuseau de l'événement, pas celui du poste", async () => {
    const { wrapper } = await monter()

    // 09:00 UTC = 10:00 à Paris. La console s'ouvre depuis n'importe où et le
    // programme, lui, ne se décale pas.
    expect(wrapper.get('[data-creneau="talk-1"]').text()).toContain('10:00')
  })

  it("cale « en ce moment » sur l'horloge du hub, qui peut être simulée", async () => {
    const { wrapper } = await monter({ serverTime: '2026-10-30T09:20:00Z' })

    const ligne = wrapper.get('[data-creneau="talk-1"]')
    expect(ligne.attributes('data-quand')).toBe('en-cours')
    expect(ligne.text()).toContain('en ce moment')
  })

  it('replie la colonne d’action, et dit combien de décisions sont en vigueur', async () => {
    const { wrapper } = await monter({
      sessions: [TALK, { ...PAUSE, overriddenAs: 'talk' }],
    })

    // Elle est la seule colonne qui écrit, au milieu de six qui lisent, et sa
    // décision se propage jusqu'aux QR projetés.
    expect(wrapper.find('[data-session-action]').exists()).toBe(false)
    expect(wrapper.get('#btn-planning-actions').text()).toContain('1 décision')

    await wrapper.get('#btn-planning-actions').trigger('click')
    expect(wrapper.find('[data-session-action]').exists()).toBe(true)
  })

  it('ne propose pas de décider une pause héritée d’une autre salle', async () => {
    const { wrapper } = await monter({ sessions: [HERITEE] })
    await wrapper.get('#btn-planning-actions').trigger('click')

    // C'est le créneau d'origine qu'on corrige, et la projection suit : un menu
    // sur la copie laisserait croire à deux décisions indépendantes.
    expect(wrapper.get('[data-creneau="pause-2"]').text()).toContain('héritée')
    expect(wrapper.find('[data-session-action="pause-2"]').exists()).toBe(false)
  })

  it('enregistre une décision et relit le programme depuis le hub', async () => {
    const { calls, wrapper } = await monter()
    await wrapper.get('#btn-planning-actions').trigger('click')

    await wrapper.get('[data-session-action="talk-1"]').setValue('break')
    await flushPromises()

    expect(calls).toContainEqual({
      path: 'sessions/override',
      input: { sessionId: 'talk-1', action: 'break' },
    })
    // Relu plutôt que reconstruit : le hub sert le programme corrigé, et une
    // reconstruction locale divergerait de ce que voient les salles.
    expect(calls.filter((appel) => appel.path === 'program/planning')).toHaveLength(2)
  })

  it('ne laisse pas le menu sur une décision que le hub a refusée', async () => {
    const { calls, wrapper } = await monter({ overrideError: 'Programme verrouillé' })
    await wrapper.get('#btn-planning-actions').trigger('click')

    await wrapper.get('[data-session-action="talk-1"]').setValue('break')
    await flushPromises()

    // Rien n'a changé côté hub : le rechargement serait un aller-retour pour
    // rien, et la donnée reviendrait identique — donc sans repatcher le menu,
    // que Vue laisserait sur l'option cliquée. On le remet à la main.
    expect(calls.filter((appel) => appel.path === 'program/planning')).toHaveLength(1)
    const menu = wrapper.get('[data-session-action="talk-1"]').element as HTMLSelectElement
    expect(menu.value).toBe('')
  })

  it('laisse la case Feedback vide plutôt que d’offrir un lien mort', async () => {
    const { wrapper } = await monter({ sessions: [PAUSE] })

    // Sans projet réglé, ou sur une pause, il n'y a rien à noter.
    expect(wrapper.find('[data-creneau="pause-1"] a').exists()).toBe(false)
  })

  it('ne propose pas de captation sur une pause', async () => {
    const { wrapper } = await monter({ sessions: [TALK, PAUSE] })

    // Personne ne cherche le rush du déjeuner, et un bouton ouvrant une modale
    // vide sur vingt-sept lignes ferait douter des vingt-sept.
    expect(wrapper.find('[data-vod-session="talk-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-vod-session="pause-1"]').exists()).toBe(false)
  })

  it('signale un identifiant de feedback corrigé', async () => {
    const { wrapper } = await monter({
      sessions: [{ ...TALK, feedbackIdOverride: 'vue-et-les-regies' }],
    })

    expect(wrapper.get('[data-feedback-session="talk-1"]').text()).toContain('✱')
  })

  it('avertit quand aucun projet OpenFeedback n’est réglé', async () => {
    const { wrapper } = await monter({ projectId: null })

    // Sans projet, les salles ne projettent aucun QR « notez ce talk » — et
    // rien d'autre ne le dirait.
    expect(wrapper.get('#planning-feedback-aide').text()).toContain('Aucun projet OpenFeedback')
  })

  it('n’interroge OpenFeedback que sur demande', async () => {
    const { calls, wrapper } = await monter()

    expect(calls.filter((a) => a.path === 'program/controleOpenFeedback')).toHaveLength(0)

    await wrapper.get('#btn-controle-feedback').trigger('click')
    await flushPromises()

    expect(calls.filter((a) => a.path === 'program/controleOpenFeedback')).toHaveLength(1)
    expect(wrapper.get('#controle-feedback').text()).toContain('27 talks')
  })

  it('offre les actions que la table du cycle de vie allowed, et pas d’autres', async () => {
    const { wrapper } = await monter({
      states: [
        {
          sessionId: 'talk-1',
          roomName: 'Track #1',
          title: 'Vue et les régies',
          status: 'running',
          remainingMs: 120_000,
        },
      ],
    })

    const ligne = wrapper.get('[data-session="talk-1"]')
    // `running` : on peut terminer, pas commencer.
    expect(ligne.text()).toContain('Terminer')
    expect(ligne.text()).not.toContain('Commencer')
  })

  it('met le dépassement en évidence : c’est lui qui déclenche une décision', async () => {
    const { wrapper } = await monter({
      states: [{ sessionId: 'talk-1', status: 'running', remainingMs: -180_000 }],
    })

    const ligne = wrapper.get('[data-session="talk-1"]')
    expect(ligne.text()).toContain('+3 min')
    expect(ligne.html()).toContain('text-alerte')
  })

  it('nomme qui a décidé, pas seulement que c’est automatique', async () => {
    const { wrapper } = await monter({
      states: [{ sessionId: 'talk-1', status: 'ended', decidedBy: 'regie@cloudnord.fr' }],
    })

    // « Je n'ai pas fait ça » est la première question posée devant cette ligne.
    expect(wrapper.get('[data-session="talk-1"]').text()).toContain('regie@cloudnord.fr')
  })
})
