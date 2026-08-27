import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import LevelMeters from '../src/components/LevelMeters.vue'
import { PEAK_HOLD_MS, useAudioStore } from '../src/stores/audio.js'

/**
 * Le vumètre, qui dit ce qu'aucune image ne dira.
 *
 * Une salle dont le micro coupe garde la même projection, le même chronomètre
 * et le même bouton rouge. Le seul endroit où ça se voit est ici.
 */

const ENTREE = { nom: 'Micro HF', canaux: [{ magnitude: -30, crete: -28 }] }

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('maintien de crête', () => {
  it('garde une saturation assez longtemps pour qu’on la voie', () => {
    const audio = useAudioStore()

    audio.apply([{ nom: 'Micro HF', canaux: [{ magnitude: -30, crete: -3 }] }], 0)
    audio.apply([ENTREE], 500)

    // Une saturation d'un dixième de seconde passe entre deux rendus : sans
    // maintien, personne ne la voit jamais.
    expect(audio.peaks['Micro HF']?.db).toBe(-3)
  })

  it('relâche la crête une fois le maintien écoulé', () => {
    const audio = useAudioStore()

    audio.apply([{ nom: 'Micro HF', canaux: [{ magnitude: -30, crete: -3 }] }], 0)
    audio.apply([ENTREE], PEAK_HOLD_MS + 1)

    expect(audio.peaks['Micro HF']?.db).toBe(-28)
  })

  it('remonte tout de suite sur une crête plus haute', () => {
    const audio = useAudioStore()

    audio.apply([ENTREE], 0)
    audio.apply([{ nom: 'Micro HF', canaux: [{ magnitude: -10, crete: -6 }] }], 100)

    expect(audio.peaks['Micro HF']?.db).toBe(-6)
  })

  it('oublie une entrée qui disparaît d’OBS', () => {
    const audio = useAudioStore()

    audio.apply([ENTREE], 0)
    audio.apply([], 100)

    // Une crête gardée pour une entrée débranchée s'afficherait sur la suivante
    // qui reprendrait son nom.
    expect(audio.peaks['Micro HF']).toBeUndefined()
  })
})

describe('panneau des niveaux', () => {
  it('distingue « en attente » de « aucune entrée »', async () => {
    const audio = useAudioStore()
    const wrapper = mount(LevelMeters)

    // Le premier est un OBS qu'on n'a pas encore entendu, le second un OBS qui
    // répond et n'a rien à faire écouter. Les confondre enverrait chercher la
    // panne au mauvais endroit.
    expect(wrapper.text()).toContain("En attente d'OBS")

    audio.apply([], 0)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Aucune entrée audio')
  })

  it('dessine une jauge par canal, parce que mono et stéréo coexistent', async () => {
    const audio = useAudioStore()
    audio.apply(
      [{ nom: 'Salle', canaux: [{ magnitude: -30, crete: -30 }, { magnitude: -12, crete: -12 }] }],
      0,
    )
    const wrapper = mount(LevelMeters)
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('[data-role="levels"] .rounded-full')).toHaveLength(4)
  })

  it('alerte sur la crête, sans attendre que la barre y soit encore', async () => {
    const audio = useAudioStore()
    audio.apply([{ nom: 'Salle', canaux: [{ magnitude: -40, crete: -3 }] }], 0)
    const wrapper = mount(LevelMeters)
    await wrapper.vm.$nextTick()

    expect(wrapper.html()).toContain('text-alerte')
    expect(wrapper.text()).toContain('-3 dB')
  })

  it('dit « — » plutôt que « −60 dB » sur une entrée muette', async () => {
    const audio = useAudioStore()
    audio.apply([{ nom: 'Salle', canaux: [{ magnitude: -60, crete: -60 }] }], 0)
    const wrapper = mount(LevelMeters)
    await wrapper.vm.$nextTick()

    // Le plancher n'est pas une mesure : c'est l'aveu qu'il n'y a rien à
    // mesurer, et un chiffre s'y lirait comme un signal faible.
    expect(wrapper.text()).toContain('—')
  })
})
