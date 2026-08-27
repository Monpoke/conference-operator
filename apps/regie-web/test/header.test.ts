import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import CpuIndicator from '../src/components/CpuIndicator.vue'
import HubIndicator from '../src/components/HubIndicator.vue'
import ModeBadge from '../src/components/ModeBadge.vue'
import RegieHeader from '../src/components/RegieHeader.vue'
import RoomClock from '../src/components/RoomClock.vue'
import { clockDrift } from '../src/lib/clock-drift.js'
import { payload } from './fixtures.js'

/**
 * Le bandeau : ce qu'on lit sans le chercher.
 *
 * Il ne pilote rien, et c'est justement pour cela qu'il compte — il porte les
 * trois pannes qu'une salle ne peut pas voir autrement : le hub perdu, le poste
 * saturé, la page figée.
 */

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('lien avec le hub', () => {
  it('dit ce qui marche encore, plutôt que ce qui est cassé', () => {
    const wrapper = mount(HubIndicator, {
      props: { connectivity: 'OFFLINE', queueDepth: 0, offsetMs: 0, simulatedClock: false },
    })

    // La seule question de l'opérateur quand la pastille change en pleine
    // journée, et la réponse est contre-intuitive : la salle continue seule.
    expect(wrapper.text()).toContain('Projection et captation, elles, n’en dépendent pas')
  })

  it('traite une connectivité inconnue comme une coupure', () => {
    const wrapper = mount(HubIndicator, {
      props: { connectivity: null, queueDepth: 0, offsetMs: 0, simulatedClock: false },
    })

    // Se taire sur un état qu'on ne sait pas nommer laisserait la pastille
    // verte, qui est le seul contresens à ne pas commettre ici.
    expect(wrapper.attributes('data-niveau')).toBe('alerte')
    expect(wrapper.text()).toContain('hors ligne')
  })

  it('annonce la file plutôt que de la taire quand elle est vide', () => {
    const wrapper = mount(HubIndicator, {
      props: { connectivity: 'DEGRADED', queueDepth: 12, offsetMs: 0, simulatedClock: false },
    })
    expect(wrapper.text()).toContain('12 en attente de remontée')
  })

  it('dit l’horloge simulée à la place de l’écart, qui n’aurait aucun sens', () => {
    const wrapper = mount(HubIndicator, {
      props: { connectivity: 'ONLINE', queueDepth: 0, offsetMs: 5_400_000, simulatedClock: true },
    })

    expect(wrapper.text()).toContain('horloge simulée par le hub')
    expect(wrapper.text()).not.toContain('décalée')
  })
})

describe('écart d’horloge', () => {
  it('ne rend jamais un nombre qu’on ne puisse pas se représenter', () => {
    // « décalée de +5 693 432,6 s » est exact et illisible.
    expect(clockDrift(300)).toBe('horloge alignée')
    expect(clockDrift(2400)).toBe('horloge décalée de +2,4 s')
    expect(clockDrift(-600_000)).toBe('horloge décalée de −10 min')
    expect(clockDrift(5_693_432_600)).toBe('horloge décalée de +66 jours')
  })
})

describe('charge du poste', () => {
  it('avoue une mesure absente plutôt que d’afficher zéro', () => {
    const wrapper = mount(CpuIndicator, { props: { load: null } })

    expect(wrapper.attributes('data-niveau')).toBe('inconnu')
    expect(wrapper.text()).toContain('Pastille sans valeur, pas poste au repos')
  })

  it('ne dit pas « le poste encaisse » sous une mémoire pleine', () => {
    const wrapper = mount(CpuIndicator, {
      props: {
        load: {
          cpu: 0.1,
          coeurs: 8,
          fenetreMs: 5000,
          memoire: { occupeeOctets: 31_000_000_000, totalOctets: 32_000_000_000 },
        },
      },
    })

    // Le verdict revient à la mesure la plus grave : c'est l'autre façon dont
    // un poste lâche, et la plus sournoise — il commence à échanger sur le
    // disque qui écrit le rush.
    expect(wrapper.attributes('data-niveau')).toBe('alerte')
    expect(wrapper.text()).toContain('celui-là même qui écrit le rush')
  })

  it('garde au grand chiffre la couleur de sa propre mesure', () => {
    const wrapper = mount(CpuIndicator, {
      props: {
        load: {
          cpu: 0.1,
          coeurs: 8,
          fenetreMs: 5000,
          memoire: { occupeeOctets: 31_000_000_000, totalOctets: 32_000_000_000 },
        },
      },
    })

    // Un processeur au repos reste vert sous une pastille rouge de mémoire.
    expect(wrapper.html()).toContain('niveau-ok')
  })

  it('ne dit rien de la mémoire quand la première fenêtre n’est pas écoulée', () => {
    const wrapper = mount(CpuIndicator, {
      props: { load: { cpu: null, coeurs: 8, fenetreMs: 0, memoire: null } },
    })

    // Une mémoire non mesurée devenait « la plus grave » et la table des
    // verdicts mémoire n'a rien à dire d'une mémoire qui va bien : la page
    // d'origine affichait « undefined » pendant la première fenêtre.
    expect(wrapper.text()).not.toContain('undefined')
    expect(wrapper.text()).toContain('première mesure en cours')
  })
})

describe('mode d’exécution', () => {
  it('se tait quand tout est en production', () => {
    const wrapper = mount(ModeBadge, { props: { mode: { salle: 'production', hub: 'production' } } })
    expect(wrapper.text()).toBe('')
  })

  it('crie quand la salle et le hub ne sont pas du même côté', () => {
    const wrapper = mount(ModeBadge, { props: { mode: { salle: 'dev', hub: 'production' } } })

    // Une salle de développement branchée sur le hub de l'événement enverrait
    // de vraies commandes depuis un poste qui simule tout.
    expect(wrapper.text()).toBe('dev · hub en production')
    expect(wrapper.html()).toContain('text-alerte')
  })
})

describe('horloge', () => {
  it('signale une heure simulée, sinon l’écart déroute', () => {
    const wrapper = mount(RoomClock, {
      props: { atMs: Date.parse('2026-10-30T09:00:00Z'), timeZone: 'Europe/Paris', simulated: true },
    })

    // Voir 11:00 un matin d'août sans explication ferait douter de tout le
    // reste de l'écran.
    expect(wrapper.text()).toContain('10:00:00')
    expect(wrapper.text()).toContain('simulée')
  })
})

describe('bandeau complet', () => {
  it('nomme la salle, et le dit quand elle n’est appairée à rien', () => {
    const sans = payload()
    sans.roomName = null
    sans.state.roomId = null
    const wrapper = mount(RegieHeader, {
      props: { payload: sans, nowMs: Date.now(), streamDead: false },
    })
    expect(wrapper.get('[data-role="room"]').text()).toBe('Salle non appairée')
  })

  it('dit l’écran figé, parce qu’une page morte ressemble à une page vivante', () => {
    const wrapper = mount(RegieHeader, {
      props: { payload: payload(), nowMs: Date.now(), streamDead: true },
    })

    // L'horloge et le compte à rebours se redessinent chaque seconde depuis la
    // dernière charge utile reçue : seul l'état de la conférence reste bloqué.
    expect(wrapper.get('[data-role="stream-dead"]').text()).toContain('écran figé')
  })

  it('ne montre la file que lorsqu’il y a quelque chose dedans', () => {
    const vide = mount(RegieHeader, {
      props: { payload: payload(), nowMs: Date.now(), streamDead: false },
    })
    expect(vide.find('[data-role="queue"]').exists()).toBe(false)

    const pleine = payload()
    pleine.diagnostics!.outboxDepth = 4
    const wrapper = mount(RegieHeader, {
      props: { payload: pleine, nowMs: Date.now(), streamDead: false },
    })
    expect(wrapper.get('[data-role="queue"]').text()).toBe('4 en attente')
  })
})
