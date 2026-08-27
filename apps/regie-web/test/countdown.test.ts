import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Countdown from '../src/components/Countdown.vue'
import RecordingTimer from '../src/components/RecordingTimer.vue'
import { countdownFor } from '../src/lib/countdown.js'
import { DEBUT_MS, FIN_MS, payload, talk } from './fixtures.js'

/**
 * Le grand nombre, et ce qu'il vise.
 *
 * C'est le seul chiffre que l'opérateur lit en continu dans les deux dernières
 * minutes d'un talk. Se tromper de cible — compter vers une fin quand ce qu'on
 * attend est un début — le rend faux sans le rendre visible : il descend, donc
 * il a l'air juste.
 */

describe('ce que compte le chronomètre', () => {
  it('compte vers le début tant que le créneau n’a pas commencé', () => {
    const compte = countdownFor(payload(), DEBUT_MS - 10 * 60_000)

    // Compter d'emblée vers la fin donnait « 2:01:59 » en gros caractères à
    // 8h38 sur la conférence de 9h50 : un chiffre qui se lit comme un talk en
    // cours, et qui a été lu ainsi.
    expect(compte).toEqual({ ms: 10 * 60_000, beforeStart: true })
  })

  it('compte vers la fin dès qu’un talk est lancé, même en avance', () => {
    const etat = payload()
    etat.state.sessionStates = { 'talk-1': 'running' }

    // Dès qu'on a appuyé sur « Commencer », c'est l'écart au programme qui
    // décide de la suite de la journée.
    const compte = countdownFor(etat, DEBUT_MS - 10 * 60_000)
    expect(compte?.beforeStart).toBe(false)
    expect(compte?.ms).toBe(FIN_MS - (DEBUT_MS - 10 * 60_000))
  })

  it('passe en négatif sur un dépassement, plutôt que de s’arrêter à zéro', () => {
    const etat = payload()
    etat.state.sessionStates = { 'talk-1': 'running' }
    expect(countdownFor(etat, FIN_MS + 90_000)?.ms).toBe(-90_000)
  })

  it('vise la conférence suivante dès que celle-ci est terminée', () => {
    const suivante = talk({ id: 'talk-2', startsAtMs: FIN_MS + 15 * 60_000, endsAtMs: null })
    const etat = payload({ sessions: [talk(), suivante] })
    etat.state.sessionStates = { 'talk-1': 'ended' }

    /*
     * Le chronomètre continuait sur son créneau : « Terminer » appuyé à 10:35,
     * il restait quinze minutes à l'écran sur un talk que la salle venait de
     * quitter.
     */
    const compte = countdownFor(etat, FIN_MS)
    expect(compte).toEqual({ ms: 15 * 60_000, beforeStart: true })
  })

  it('ne décompte plus rien quand plus rien ne suit', () => {
    const etat = payload()
    etat.state.sessionStates = { 'talk-1': 'ended' }
    expect(countdownFor(etat, FIN_MS)).toBe(null)
  })

  it('saute une pause : un déjeuner n’est pas ce qu’on attend', () => {
    const pause = talk({ id: 'pause-1', kind: 'break', startsAtMs: FIN_MS + 60_000 })
    const suivante = talk({ id: 'talk-2', startsAtMs: FIN_MS + 45 * 60_000, endsAtMs: null })
    const etat = payload({ sessions: [talk(), pause, suivante] })
    etat.state.sessionStates = { 'talk-1': 'ended' }

    expect(countdownFor(etat, FIN_MS)?.ms).toBe(45 * 60_000)
  })
})

describe('rendu du chronomètre', () => {
  it('atténue un décompte qui ne réclame rien, alerte sur un dépassement', () => {
    const avant = mount(Countdown, { props: { payload: payload(), atMs: DEBUT_MS - 600_000 } })
    expect(avant.get('[data-role="countdown"]').classes()).toContain('text-attenue')
    // Le badge dit ce que le nombre décompte : les deux se lisent pareil sans lui.
    expect(avant.text()).toContain('à venir')

    const etat = payload()
    etat.state.sessionStates = { 'talk-1': 'running' }
    const apres = mount(Countdown, { props: { payload: etat, atMs: FIN_MS + 60_000 } })
    expect(apres.get('[data-role="countdown"]').classes()).toContain('text-alerte')
    expect(apres.text()).not.toContain('à venir')
  })

  it('prévient dans les cinq dernières minutes, où l’on ne le quitte plus des yeux', () => {
    const etat = payload()
    etat.state.sessionStates = { 'talk-1': 'running' }
    const wrapper = mount(Countdown, { props: { payload: etat, atMs: FIN_MS - 120_000 } })

    expect(wrapper.get('[data-role="countdown"]').classes()).toContain('text-attention')
    expect(wrapper.text()).toContain('2:00')
  })

  it('dit « --:-- » plutôt que zéro quand il n’y a rien à piloter', () => {
    const etat = payload()
    etat.state.targetSession = null
    const wrapper = mount(Countdown, { props: { payload: etat, atMs: DEBUT_MS } })
    expect(wrapper.get('[data-role="countdown"]').text()).toBe('--:--')
  })
})

describe('chronomètre de prise', () => {
  const REC = { active: true, markers: 0, startedAtMs: 1_000_000, startedAtCorrigeMs: null }

  it('reste éteint hors enregistrement', () => {
    const wrapper = mount(RecordingTimer, {
      props: { recording: null, realMs: 1_000_000, roomMs: 1_000_000 },
    })
    expect(wrapper.text()).toBe('00:00')
    expect(wrapper.classes()).toContain('text-attenue')
  })

  it('compte en temps réel quand la charge utile ne dit rien d’autre', () => {
    const wrapper = mount(RecordingTimer, {
      props: { recording: REC, realMs: 1_000_000 + 95_000, roomMs: 9_999_999 },
    })
    expect(wrapper.text()).toBe('01:35')
  })

  it('suit l’horloge du hub quand le départ y est daté', () => {
    // Le cas du développement, où l'on déroule une journée en la poussant : le
    // chronomètre doit dire la même chose que la durée finalement enregistrée.
    const wrapper = mount(RecordingTimer, {
      props: {
        recording: { ...REC, startedAtCorrigeMs: 5_000_000 },
        realMs: 1_000_000,
        roomMs: 5_000_000 + 62_000,
      },
    })
    expect(wrapper.text()).toBe('01:02')
  })

  it('ne compte jamais à l’envers', () => {
    // Une horloge poussée en arrière rendait un négatif, affiché « -1:-5 ».
    const wrapper = mount(RecordingTimer, {
      props: { recording: REC, realMs: 900_000, roomMs: 900_000 },
    })
    expect(wrapper.text()).toBe('00:00')
  })
})
