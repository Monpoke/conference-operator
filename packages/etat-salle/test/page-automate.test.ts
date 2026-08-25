/// <reference lib="dom" />
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { renderAutomatePage, type SalleApercu } from '../src/page-automate.js'

/**
 * Le banc d'essai, exécuté dans un vrai DOM.
 *
 * La page n'a pas d'étape de build : sans ce niveau de test, seule sa syntaxe
 * est vérifiée, et un bouton qui ne réagit pas passe inaperçu jusqu'au moment
 * où l'on comptait dessus pour comprendre un défaut.
 *
 * Le programme est ici volontairement minuscule et écrit à la main : ce qu'on
 * vérifie, c'est que la page appelle bien l'automate et lui obéit, pas que
 * l'automate a raison — ça, c'est le rôle de `conference.test.ts`.
 */
const DEBUT = Date.parse('2026-10-30T09:00:00Z')
const MIN = 60_000

const SALLE: SalleApercu = {
  id: 'salle-1',
  name: 'Track #1',
  creneaux: [
    {
      id: 'accueil',
      title: 'Accueil',
      kind: 'break',
      startsAt: new Date(DEBUT).toISOString(),
      startsAtMs: DEBUT,
      endsAt: new Date(DEBUT + 30 * MIN).toISOString(),
      endsAtMs: DEBUT + 30 * MIN,
      durationMinutes: 30,
    },
    {
      id: 'talk',
      title: 'Un talk',
      kind: 'talk',
      startsAt: new Date(DEBUT + 30 * MIN).toISOString(),
      startsAtMs: DEBUT + 30 * MIN,
      endsAt: new Date(DEBUT + 80 * MIN).toISOString(),
      endsAtMs: DEBUT + 80 * MIN,
      durationMinutes: 50,
    },
  ],
}

const $ = (id: string) => document.getElementById(id)!
const mot = () => $('mot').textContent
const bouton = (id: string) => $(id) as HTMLButtonElement

/** Pose l'heure simulée, en minutes après le début du programme. */
function a(minutes: number): void {
  const curseur = $('curseur') as HTMLInputElement
  // Le curseur couvre la journée entière, bornes comprises : on vise par
  // l'entrée date, qui est la seule façon exacte de désigner un instant.
  const champ = $('horloge') as HTMLInputElement
  const cible = new Date(DEBUT + minutes * MIN)
  const local = new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Europe/Paris', hour12: false,
  }).format(cible)
  champ.value = local.replace(' ', 'T')
  champ.dispatchEvent(new Event('change'))
  void curseur
}

function monter(salle: SalleApercu = SALLE): void {
  document.documentElement.innerHTML = renderAutomatePage({
    salles: [salle],
    timezone: 'Europe/Paris',
    depart: DEBUT,
  })
  for (const script of document.querySelectorAll('script:not([type])')) {
    // `innerHTML` n'exécute pas les <script> : on les rejoue à la main.
    new Function(script.textContent ?? '')()
  }
}

beforeEach(() => monter())

describe('banc d\'essai de l\'automate', () => {
  it('ouvre sur l\'état que dit l\'automate, pas sur une valeur écrite en dur', () => {
    // 09:00 UTC : l'accueil court, et un accueil est un break.
    expect(mot()).toBe('rien dans la salle')
    expect($('pastille').className).toContain('hors')
  })

  it('suit l\'heure simulée', () => {
    a(31)
    expect(mot()).toBe('pas commencée')
    a(36)
    expect(mot()).toBe('retard au démarrage')
  })

  it('lance et termine par les mêmes gestes que la régie', () => {
    a(31)
    bouton('commencer').click()
    expect(mot()).toBe('en cours')

    a(76)
    expect(mot()).toBe('vers la fin')

    bouton('terminer').click()
    expect(mot()).toBe('terminée en avance')
  })

  it('refuse ce que la table refuse, et dit pourquoi', () => {
    a(31)
    expect(bouton('terminer').disabled).toBe(true)
    expect(bouton('terminer').title).toContain("n'a pas été lancée")

    bouton('commencer').click()
    expect(bouton('commencer').disabled).toBe(true)
    expect(bouton('commencer').title).toContain('déjà lancée')
  })

  it('montre le dépassement, puis la clôture automatique qui le lève', () => {
    a(31)
    bouton('commencer').click()

    // Le créneau finit à +80 ; passé l'heure, la salle déborde.
    a(82)
    expect(mot()).toBe('dépassement')

    // La grâce est de cinq minutes : à +86, la règle horaire a fermé.
    a(86)
    expect(mot()).not.toBe('dépassement')
    expect($('journal').textContent).toContain('clôture automatique')
  })

  it('garde le dépassement quand la règle est coupée — c\'est ce qu\'on vient voir', () => {
    a(31)
    bouton('commencer').click()
    const actif = $('auto-actif') as HTMLInputElement
    actif.checked = false
    actif.dispatchEvent(new Event('change'))

    a(200)
    // Le dépassement gagne sur tout créneau ultérieur : la salle ne revient pas
    // d'elle-même à un état neutre tant que personne ne clôt.
    expect(mot()).toBe('dépassement')
  })

  it('ferme aussi sur une fin déduite, sans heure de fin explicite', () => {
    /**
     * Le cas qui laissait une salle en rouge toute la journée.
     *
     * La règle horaire exigeait `endsAt` là où le dépassement se contentait
     * d'une fin déduite : un créneau dont l'export ne donne que l'heure de
     * début débordait sans que le balayage ne le voie jamais passer. Les deux
     * lisent désormais la même fin.
     */
    const sansFin = $('sans-fin') as HTMLInputElement
    sansFin.checked = true
    sansFin.dispatchEvent(new Event('change'))

    a(31)
    bouton('commencer').click()
    a(82)
    expect(mot()).toBe('dépassement')

    a(86)
    expect(mot()).not.toBe('dépassement')
    expect($('journal').textContent).toContain('clôture automatique')
  })

  it('laisse ouvert ce qu’aucune règle ne ferme — et c’est à raison', () => {
    // Dernier créneau de la journée, sans heure de fin ni durée : personne ne
    // sait quand il finit. Le clore reviendrait à inventer une heure.
    monter({
      id: 'salle-ouverte',
      name: 'Salle ouverte',
      creneaux: [
        {
          id: 'sans-fin-du-tout',
          title: 'Atelier libre',
          kind: 'talk',
          startsAt: new Date(DEBUT).toISOString(),
          startsAtMs: DEBUT,
          endsAt: null,
          endsAtMs: null,
          durationMinutes: null,
        },
      ],
    })

    a(1)
    bouton('commencer').click()
    a(600)

    expect(mot()).toBe('en cours')
    expect($('journal').textContent).not.toContain('clôture automatique')
  })

  it('remet la journée à zéro', () => {
    a(31)
    bouton('commencer').click()
    a(82)
    expect(mot()).toBe('dépassement')

    bouton('rejouer').click()
    expect(mot()).toBe('hors créneau')
    expect($('journal').textContent).toContain('journée remise à zéro')
  })

  /**
   * Le cas de la keynote sans intervenant annoncé.
   *
   * Le normaliseur n'a qu'un signal pour trancher — un créneau sans intervenant
   * est une pause — et il se trompe dans les deux sens. Une keynote dont le
   * speaker n'est pas encore annoncé passe pour un déjeuner, et la salle se lit
   * « rien dans la salle » à l'heure précise où le public s'installe. L'automate
   * n'y est pour rien : il reçoit un break et le dit. La correction est la
   * surcharge de créneau, et c'est elle qu'on vérifie ici.
   */
  describe('surcharge du type de créneau', () => {
    const typeAffiche = () =>
      ($('creneaux').querySelector('[data-kind="accueil"]') as HTMLButtonElement).textContent

    it('lit un créneau sans intervenant comme une pause', () => {
      a(1)
      expect(mot()).toBe('rien dans la salle')
      expect(typeAffiche()).toBe('break')
    })

    it('le déclare conférence, et la salle change d\'état', () => {
      a(1)
      ;($('creneaux').querySelector('[data-kind="accueil"]') as HTMLButtonElement).click()

      expect(typeAffiche()).toContain('talk')
      expect(mot()).toBe('pas commencée')
      expect($('journal').textContent).toContain('surcharge')
    })

    it('devient un retard cinq minutes plus tard, comme une vraie conférence', () => {
      ;($('creneaux').querySelector('[data-kind="accueil"]') as HTMLButtonElement).click()
      a(6)
      expect(mot()).toBe('retard au démarrage')
    })

    it('revient au type d\'origine au second clic', () => {
      const bascule = () =>
        ($('creneaux').querySelector('[data-kind="accueil"]') as HTMLButtonElement).click()
      a(1)
      bascule()
      bascule()
      expect(typeAffiche()).toBe('break')
      expect(mot()).toBe('rien dans la salle')
    })

    it('survit à « Rejouer la journée » — c\'est le programme, pas une décision', () => {
      a(1)
      ;($('creneaux').querySelector('[data-kind="accueil"]') as HTMLButtonElement).click()
      bouton('rejouer').click()
      a(1)
      expect(typeAffiche()).toContain('talk')
    })
  })

  /**
   * Reculer l'horloge défait ce qui n'avait pas encore eu lieu.
   *
   * Le banc gardait ses décisions sans date : terminer une conférence à 09:05
   * puis revenir à 08:59 laissait la salle « terminée » sur un créneau que
   * personne n'avait encore touché à cette heure-là. Le hub filtre ces
   * décisions à la lecture depuis toujours — c'est la page qui ne le faisait
   * pas, et elle mentait donc précisément là où on venait la consulter.
   */
  describe('horloge reculée', () => {
    it('ignore une décision datée d\'après l\'instant regardé', () => {
      a(31)
      bouton('commencer').click()
      expect(mot()).toBe('en cours')

      // La règle horaire ferme à +85 (fin +80, grâce 5).
      a(86)
      expect($('journal').textContent).toContain('clôture automatique')

      // On revient avant : ni le départ ni la clôture n'ont encore eu lieu.
      a(40)
      expect(mot()).toBe('retard au démarrage')
    })

    it('retrouve la journée là où on l\'avait laissée en ré-avançant', () => {
      // On filtre à la lecture, on n'efface pas : c'est ce qui permet de
      // faire des allers-retours sans reconstruire la journée à chaque fois.
      a(31)
      bouton('commencer').click()
      a(86)
      a(40)
      a(86)

      expect(mot()).toBe('hors créneau')
      expect($('journal').textContent).toContain('clôture automatique')
    })

    it('ne défait rien sous une horloge qui avance', () => {
      // Sous une horloge réelle, aucune décision n'est datée du futur : la
      // règle ne doit jamais se voir.
      a(31)
      bouton('commencer').click()
      a(35)
      expect(mot()).toBe('en cours')
    })
  })

  it('dessine les huit états, celui du moment allumé', () => {
    const noeuds = $('schema').querySelectorAll('.noeud')
    expect(noeuds).toHaveLength(8)
    expect($('schema').querySelectorAll('.noeud.allume')).toHaveLength(1)
  })
})
