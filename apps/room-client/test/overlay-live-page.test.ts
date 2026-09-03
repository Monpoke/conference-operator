/// <reference lib="dom" />
// La lib DOM est déclarée ici seulement : l'ajouter au tsconfig laisserait le
// code serveur appeler `document` sans que rien ne proteste.
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flattenLayersInHtml } from '@cloudnord/ui'
import { renderOverlayLivePage } from '../src/core/overlay-live-page.js'
import type { DisplayPayload } from '../src/core/display-server.js'

/**
 * Bandeau des scènes live.
 *
 * Surface transparente posée où l'on veut qu'un message apparaisse : elle ne
 * dit rien de la conférence, elle porte ce que la console met à l'antenne.
 */
const etat = (liveMessage: unknown): DisplayPayload =>
  ({ state: { liveMessage, question: null } }) as unknown as DisplayPayload

/** Une question du public à l'antenne — l'autre canal, celui qui va en VOD. */
const etatQuestion = (question: unknown): DisplayPayload =>
  ({ state: { liveMessage: null, question } }) as unknown as DisplayPayload

/** Le style se choisit dans l'adresse de la source OBS, pas à l'exécution. */
function poserStyle(style: string | null): void {
  globalThis.history.replaceState(null, '', style == null ? '/display/overlay-live' : `/display/overlay-live?style=${style}`)
}

function monterBandeau(payload: DisplayPayload): void {
  document.documentElement.innerHTML = flattenLayersInHtml(
    renderOverlayLivePage({ initialPayload: payload }),
  )
  for (const script of document.querySelectorAll('script:not([type])')) {
    // eslint-disable-next-line no-new-func
    new Function(script.textContent ?? '')()
  }
}

describe('bandeau live', () => {
  it('ne montre rien quand il n\'y a rien à dire', () => {
    // Un cadre vide incrusté en permanence dans le direct serait pire que rien.
    monterBandeau(etat(null))

    expect(document.body.dataset.bandeau).toBe('masque')
  })

  it('affiche le texte mis à l\'antenne', () => {
    monterBandeau(etat({ text: 'Reprise dans 5 minutes', level: 'info', expiresAtMs: null }))

    expect(document.body.dataset.bandeau).toBe('visible')
    expect(document.getElementById('texte')?.textContent).toBe('Reprise dans 5 minutes')
  })

  it('porte le niveau, qui en décide la teinte', () => {
    // Un « micro en panne » et un « posez vos questions » ne se lisent pas de
    // la même façon depuis le fond de la salle.
    monterBandeau(etat({ text: 'Micro en panne', level: 'urgent', expiresAtMs: null }))

    expect(document.body.dataset.niveau).toBe('urgent')
  })

  it('garde un fond réellement transparent', () => {
    // OBS compose cette page par-dessus la vidéo : un fond opaque masquerait
    // le talk entier.
    monterBandeau(etat(null))

    const fond = globalThis.getComputedStyle(document.body).backgroundColor
    expect(fond === '' || fond === 'transparent' || fond === 'rgba(0, 0, 0, 0)').toBe(true)
  })
})

describe('deux présentations', () => {
  afterEach(() => poserStyle(null))

  it('bandeau par défaut, sans libellé', () => {
    // Sur un plan de caméra, une étiquette de plus encombre pour rien.
    poserStyle(null)
    monterBandeau(etat({ text: 'Une question', level: 'info', expiresAtMs: null }))

    expect(document.body.dataset.style).toBe('bandeau')
    expect(globalThis.getComputedStyle(document.getElementById('libelle')!).display).toBe('none')
  })

  it('encart sur demande, avec son libellé', () => {
    // Par-dessus des slides, on ne sait pas d'où sort ce texte : il se nomme.
    // Le libellé annonce une question ; un message d'exploitation se lit tel
    // quel, sans en-tête qui mentirait sur sa nature.
    poserStyle('encart')
    monterBandeau(etatQuestion({ text: 'Une question', author: null, sessionId: 's-3' }))

    expect(document.body.dataset.style).toBe('encart')
    expect(globalThis.getComputedStyle(document.getElementById('libelle')!).display).not.toBe('none')
    expect(document.getElementById('libelle')?.textContent).toContain('Question du public')
  })

  it('ignore un style inconnu plutôt que de ne rien afficher', () => {
    poserStyle('flamboyant')
    monterBandeau(etat({ text: 'Une question', level: 'info', expiresAtMs: null }))

    expect(document.body.dataset.style).toBe('bandeau')
  })
})

/**
 * Passage d'une question à la suivante.
 *
 * Remplacer le texte en place donnerait un saut : deux questions de longueurs
 * différentes se substituent d'un coup, et le spectateur ne sait pas si elle a
 * changé ou si elle a toujours été là.
 */
describe('changement de question', () => {
  /** Faux flux : la page se met à jour par SSE, on lui en fournit un. */
  class FauxFlux {
    static dernier: FauxFlux | null = null
    onmessage: ((evenement: { data: string }) => void) | null = null
    constructor() {
      FauxFlux.dernier = this
    }
    addEventListener(): void {}
    emettre(payload: unknown): void {
      this.onmessage?.({ data: JSON.stringify(payload) })
    }
  }

  beforeEach(() => {
    FauxFlux.dernier = null
    vi.stubGlobal('EventSource', FauxFlux)
  })

  it('entre directement la première fois', () => {
    // Rien à sortir : une sortie à vide retarderait l'affichage pour rien.
    monterBandeau(etat({ text: 'Première', level: 'info', expiresAtMs: null }))

    expect(document.body.dataset.bandeau).toBe('visible')
    expect(document.getElementById('texte')?.textContent).toBe('Première')
  })

  it('sort l\'ancienne, puis pose la nouvelle', async () => {
    monterBandeau(etat({ text: 'Première', level: 'info', expiresAtMs: null }))

    FauxFlux.dernier!.emettre(etat({ text: 'Seconde', level: 'warning', expiresAtMs: null }))

    // Premier temps : elle sort, et c'est encore l'ancienne qui est écrite.
    expect(document.body.dataset.bandeau).toBe('masque')
    expect(document.getElementById('texte')?.textContent).toBe('Première')

    // Second temps : la nouvelle est posée, puis entre.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(document.body.dataset.bandeau).toBe('visible')
    expect(document.getElementById('texte')?.textContent).toBe('Seconde')
    expect(document.body.dataset.niveau).toBe('warning')
  })

  it('ne rejoue rien quand l\'état ne change pas', async () => {
    // La régie reçoit un état toutes les quelques secondes : rejouer
    // l'animation à chaque fois ferait clignoter la question sans raison.
    monterBandeau(etat({ text: 'Première', level: 'info', expiresAtMs: null }))

    FauxFlux.dernier!.emettre(etat({ text: 'Première', level: 'info', expiresAtMs: null }))

    expect(document.body.dataset.bandeau).toBe('visible')
  })

  it('se retire sans attendre quand il n\'y a plus rien', () => {
    monterBandeau(etat({ text: 'Première', level: 'info', expiresAtMs: null }))

    FauxFlux.dernier!.emettre(etat(null))

    expect(document.body.dataset.bandeau).toBe('masque')
  })
})

/**
 * Les deux channels sur une seule place.
 *
 * Cette page est posée dans les scènes d'OBS-A : elle est vue par la salle, pas
 * par la VOD. Elle a donc le droit de montrer les deux — contrairement à
 * l'habillage de captation, qui ne montre que la question.
 */
describe('question et bandeau, deux channels', () => {
  it('affiche la question quand rien ne vient de la console', () => {
    monterBandeau(etatQuestion({ text: 'Et les faux positifs ?', author: 'Camille', sessionId: 's-3' }))

    expect(document.body.dataset.bandeau).toBe('visible')
    expect(document.getElementById('texte')?.textContent).toBe('Et les faux positifs ?')
    expect(document.getElementById('libelle')?.textContent).toContain('Camille')
  })

  it('laisse le bandeau de la console passer devant', () => {
    // Un « on reprend dans 5 minutes » veut dire qu'il se passe quelque chose :
    // ça prime sur la question à laquelle le speaker répondait.
    monterBandeau({
      state: {
        liveMessage: { text: 'Reprise dans 5 minutes', level: 'urgent', expiresAtMs: null },
        question: { text: 'Et les faux positifs ?', author: null, sessionId: 's-3' },
      },
    } as unknown as DisplayPayload)

    expect(document.getElementById('texte')?.textContent).toBe('Reprise dans 5 minutes')
    expect(document.body.dataset.niveau).toBe('urgent')
    // Et sans se faire passer pour une question du public.
    expect(document.getElementById('libelle')?.hidden).toBe(true)
  })
})
