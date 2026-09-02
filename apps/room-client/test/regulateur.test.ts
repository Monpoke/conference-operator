import { describe, expect, it } from 'vitest'
import { POLITIQUE_VOD_PAR_DEFAUT, type PolitiqueVod } from '@cloudnord/contract'
import {
  attenteApres,
  verdictTeleversement,
  DEBIT_PLANCHER_OCTETS_S,
  type EntreesRegulateur,
} from '../src/core/regulateur.js'

/**
 * Ce que le régulateur protège, et pourquoi l'ordre des règles compte.
 *
 * Un rush qu'on ne rapatrie pas ce soir se rapatrie demain. Une captation
 * abîmée parce qu'on lisait le disque pendant qu'OBS y écrivait ne se refait
 * jamais : la salle est démontée, le speaker est reparti, et la seule réponse
 * possible est « on ne l'a pas ». Toute la hiérarchie des règles vient de là.
 *
 * L'ordre n'est pas cosmétique non plus : la première règle qui refuse est
 * celle dont l'opérateur lit le motif en régie. Une salle qui enregistre *et*
 * dont le poste est chargé doit dire « enregistrement en cours » — c'est le
 * fait qui s'explique le moins bien tout seul.
 */

const CHARGE_CALME = { cpu: 0.2, coeurs: 8, fenetreMs: 2000, memoire: null }

function entrees(patch: Partial<EntreesRegulateur> = {}): EntreesRegulateur {
  return {
    stockagePret: true,
    politique: { ...POLITIQUE_VOD_PAR_DEFAUT, actif: true },
    manuel: false,
    enregistre: false,
    conferenceEnCours: false,
    msAvantProchaine: 60 * 60_000,
    charge: CHARGE_CALME,
    debitConstateOctetsS: null,
    ...patch,
  }
}

describe('ce qui interdit de téléverser', () => {
  it('autorise quand rien ne s\'y oppose', () => {
    const verdict = verdictTeleversement(entrees())
    expect(verdict.autorise).toBe(true)
    expect(verdict.raison).toBeNull()
  })

  it('ne part jamais tout seul tant que l\'automatique est éteint', () => {
    // Le défaut du hub, et le bon : aucun octet ne quitte une salle sans que
    // quelqu'un l'ait décidé.
    expect(verdictTeleversement(entrees({ politique: POLITIQUE_VOD_PAR_DEFAUT }))).toMatchObject({
      autorise: false,
      raison: 'auto-desactive',
    })
  })

  it('laisse passer une demande manuelle quand l\'automatique est éteint', () => {
    // Le motif est distinct de l'absence de stockage, et c'est ce qui permet à
    // la régie de garder ses boutons sur le réglage par défaut du hub.
    expect(
      verdictTeleversement(entrees({ politique: POLITIQUE_VOD_PAR_DEFAUT, manuel: true })),
    ).toMatchObject({ autorise: true, raison: null })
  })

  it('ne part nulle part quand le hub n\'a pas de stockage', () => {
    expect(
      verdictTeleversement(entrees({ stockagePret: false, manuel: true })),
    ).toMatchObject({ autorise: false, raison: 'sans-stockage' })
  })

  it('refuse pendant un enregistrement, avant toute autre raison', () => {
    // Le cas qui coûte une VOD : lire le disque sur lequel OBS écrit le master.
    const verdict = verdictTeleversement(
      entrees({ enregistre: true, charge: { ...CHARGE_CALME, cpu: 0.95 }, msAvantProchaine: 0 }),
    )
    expect(verdict.raison).toBe('enregistrement')
    expect(verdict.texte).toContain('enregistrement')
  })

  it('refuse pendant une conférence pilotée', () => {
    // L'uplink sert peut-être au direct, et le poste encode.
    expect(verdictTeleversement(entrees({ conferenceEnCours: true }))).toMatchObject({
      raison: 'conference',
    })
  })

  it('s\'arrête un quart d\'heure avant la conférence suivante si on le lui demande', () => {
    const politique: PolitiqueVod = {
      ...POLITIQUE_VOD_PAR_DEFAUT,
      actif: true,
      margeConferenceMinutes: 15,
    }
    expect(
      verdictTeleversement(entrees({ politique, msAvantProchaine: 14 * 60_000 })),
    ).toMatchObject({ autorise: false, raison: 'fenetre' })
    expect(verdictTeleversement(entrees({ politique, msAvantProchaine: 16 * 60_000 })).autorise).toBe(
      true,
    )
  })

  it('dit combien de minutes il reste, pas seulement qu\'il attend', () => {
    // « en attente » sans chiffre se lit comme une panne ; « conférence dans
    // 6 min » se lit comme une décision.
    const verdict = verdictTeleversement(entrees({ msAvantProchaine: 6 * 60_000 }))
    expect(verdict.texte).toBe('conférence dans 6 min')
  })

  it('téléverse jusqu\'au bout d\'une journée finie', () => {
    // Plus de conférence au programme : c'est le moment idéal, pas un cas
    // limite. Une salle qu'on démonte à 19 h a toute la soirée devant elle.
    expect(verdictTeleversement(entrees({ msAvantProchaine: null })).autorise).toBe(true)
  })

  it('laisse le processeur à l\'encodeur', () => {
    expect(
      verdictTeleversement(entrees({ charge: { ...CHARGE_CALME, cpu: 0.85 } })),
    ).toMatchObject({ raison: 'charge' })
  })

  it('traite une charge illisible comme une charge forte, pas comme zéro', () => {
    // `cpu: null` est un aveu — on n'a pas su lire les compteurs. S'autoriser à
    // charger la machine sur cette ignorance est le mauvais pari : c'est
    // l'encodeur qui paierait, et en silence.
    const verdict = verdictTeleversement(entrees({ charge: { ...CHARGE_CALME, cpu: null } }))
    expect(verdict).toMatchObject({ autorise: false, raison: 'charge' })
    expect(verdict.texte).toContain('illisible')
  })

  it('surveille aussi la mémoire, l\'autre façon dont un poste lâche', () => {
    // La machine ne ralentit pas franchement : elle commence à échanger sur le
    // disque, celui-là même qui écrit le rush.
    const memoire = { occupeeOctets: 95, totalOctets: 100 }
    expect(verdictTeleversement(entrees({ charge: { ...CHARGE_CALME, memoire } }))).toMatchObject({
      raison: 'charge',
    })
  })

  it('lève le pied quand le réseau s\'effondre', () => {
    expect(
      verdictTeleversement(entrees({ debitConstateOctetsS: DEBIT_PLANCHER_OCTETS_S - 1 })),
    ).toMatchObject({ raison: 'debit' })
    expect(
      verdictTeleversement(entrees({ debitConstateOctetsS: DEBIT_PLANCHER_OCTETS_S + 1 })).autorise,
    ).toBe(true)
  })

  it('descend le plafond de débit du hub jusqu\'au téléverseur', () => {
    const politique = { ...POLITIQUE_VOD_PAR_DEFAUT, actif: true, debitMaxOctetsS: 1_500_000 }
    expect(verdictTeleversement(entrees({ politique })).debitMaxOctetsS).toBe(1_500_000)
  })
})

describe('la demande manuelle', () => {
  it('passe outre la fenêtre, la charge et le débit', () => {
    // Celui qui appuie sur le bouton a la salle sous les yeux. Ces trois règles
    // protègent un automatisme ; il n'en est pas un.
    const verdict = verdictTeleversement(
      entrees({
        manuel: true,
        politique: POLITIQUE_VOD_PAR_DEFAUT,
        msAvantProchaine: 60_000,
        charge: { ...CHARGE_CALME, cpu: 0.99 },
        debitConstateOctetsS: 1,
      }),
    )
    expect(verdict.autorise).toBe(true)
  })

  it('ne passe outre ni l\'enregistrement ni la conférence en cours', () => {
    // Les deux seuls cas où continuer coûterait la captation elle-même. La
    // régie prévient avant d'envoyer la demande : le refus ne surprend personne.
    expect(verdictTeleversement(entrees({ manuel: true, enregistre: true })).autorise).toBe(false)
    expect(verdictTeleversement(entrees({ manuel: true, conferenceEnCours: true })).autorise).toBe(
      false,
    )
  })

  it('respecte quand même le plafond de débit', () => {
    // Passer outre l'attente n'est pas passer outre le réseau de l'événement :
    // le plafond protège les autres salles, pas celle-ci.
    const politique = { ...POLITIQUE_VOD_PAR_DEFAUT, debitMaxOctetsS: 800_000 }
    expect(verdictTeleversement(entrees({ manuel: true, politique })).debitMaxOctetsS).toBe(800_000)
  })
})

describe('quand réessayer', () => {
  it('repasse vite sur ce qui se lève tout seul', () => {
    // Une conférence finit, un poste se calme : redemander coûte une lecture de
    // compteurs, et attendre dix minutes ferait rater la fenêtre.
    expect(attenteApres('conference', 9)).toBe(15_000)
    expect(attenteApres('charge', 9)).toBe(15_000)
    expect(attenteApres('fenetre', 0)).toBe(15_000)
  })

  it('recule en exponentiel sur le débit, et pas au-delà d\'un quart d\'heure', () => {
    // Un réseau saturé ne guérit pas parce qu'on redemande — insister est même
    // ce qui le garde saturé. Mais la salle ne doit pas s'endormir pour la nuit.
    expect(attenteApres('debit', 0)).toBe(30_000)
    expect(attenteApres('debit', 1)).toBe(60_000)
    expect(attenteApres('debit', 20)).toBe(15 * 60_000)
  })
})
