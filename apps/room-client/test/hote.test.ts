import { describe, expect, it } from 'vitest'
import { moniteurHote } from '../src/core/hote.js'

/**
 * Charge du poste.
 *
 * Ce que ces tests protègent : une salle ne doit jamais afficher « 0 % » d'un
 * processeur qu'elle n'a pas su mesurer. Un chiffre rassurant faux vaut moins
 * que pas de chiffre du tout — c'est précisément l'inverse de ce que la
 * pastille est censée faire voir.
 */
function coeur(user: number, idle: number) {
  return { times: { user, nice: 0, sys: 0, idle, irq: 0 } }
}

describe('moniteurHote', () => {
  it('n’annonce rien tant qu’aucune fenêtre n’est écoulée', () => {
    const relever = moniteurHote({ lireCpus: () => [coeur(0, 0)], now: () => 1_000 })

    // Premier appel, au même instant que la pose du repère : aucune durée
    // observée, donc aucun taux à donner.
    expect(relever().cpu).toBeNull()
  })

  it('mesure la part occupée entre deux relevés', () => {
    let temps = 0
    let cpus = [coeur(0, 0), coeur(0, 0)]
    const relever = moniteurHote({ lireCpus: () => cpus, now: () => temps })

    temps = 2_000
    // Deux cœurs, 1 000 ticks écoulés chacun : l'un occupé aux trois quarts,
    // l'autre au quart. La charge de la machine est la moyenne des deux.
    cpus = [coeur(750, 250), coeur(250, 750)]
    const charge = relever()

    expect(charge.cpu).toBeCloseTo(0.5, 5)
    expect(charge.coeurs).toBe(2)
    expect(charge.fenetreMs).toBe(2_000)
  })

  it('rend le relevé précédent quand deux consultations se suivent de trop près', () => {
    let temps = 0
    let cpus = [coeur(0, 0)]
    const relever = moniteurHote({ lireCpus: () => cpus, now: () => temps })

    temps = 2_000
    cpus = [coeur(800, 200)]
    expect(relever().cpu).toBeCloseTo(0.8, 5)

    // Deuxième fenêtre de régie ouverte : sans garde, elle consommerait un
    // intervalle de 100 ms et lirait un taux qui n'a aucun sens.
    temps = 2_100
    cpus = [coeur(800, 300)]
    expect(relever().cpu).toBeCloseTo(0.8, 5)
  })

  it('relit la mémoire à chaque appel, même sans fenêtre processeur', () => {
    let temps = 0
    let occupee = 4_000_000_000
    const relever = moniteurHote({
      lireCpus: () => [coeur(0, 0)],
      now: () => temps,
      lireMemoire: () => ({ occupeeOctets: occupee, totalOctets: 16_000_000_000 }),
    })

    // La mémoire est un instantané, pas une différence : elle vaut dès le
    // premier appel, là où le processeur n'a encore rien à dire.
    expect(relever()).toMatchObject({ cpu: null, memoire: { occupeeOctets: 4_000_000_000 } })

    // Et elle suit, même quand deux relevés se suivent de trop près pour que la
    // fenêtre du processeur compte.
    temps = 100
    occupee = 15_000_000_000
    expect(relever().memoire?.occupeeOctets).toBe(15_000_000_000)
  })

  it('laisse la mémoire à null quand elle n’est pas lisible', () => {
    const relever = moniteurHote({ lireCpus: () => [coeur(0, 0)], now: () => 0, lireMemoire: () => null })

    expect(relever().memoire).toBeNull()
  })

  it('garde le dernier chiffre honnête quand les compteurs n’avancent plus', () => {
    let temps = 0
    let cpus = [coeur(0, 0)]
    const relever = moniteurHote({ lireCpus: () => cpus, now: () => temps })

    temps = 2_000
    cpus = [coeur(600, 400)]
    expect(relever().cpu).toBeCloseTo(0.6, 5)

    // Machine virtuelle migrée, compteurs repartis en arrière : inventer un
    // taux ici afficherait une salle saturée qui ne l'est pas.
    temps = 4_000
    cpus = [coeur(0, 0)]
    expect(relever().cpu).toBeCloseTo(0.6, 5)
  })
})
