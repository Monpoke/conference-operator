import { cree } from './dom.js'

/**
 * The entry effects of the reference loop, replayed every time a scene comes in.
 *
 * `fill: 'backwards'` keeps each element invisible until its turn; afterwards it
 * goes back to its normal state. Set in the markup: `data-effet` on an element,
 * `data-effet-enfants` on a container (its children one by one, `data-cible`),
 * `data-delai` and `data-pas` in ms.
 */
interface Effet {
  images: Keyframe[] | (() => Keyframe[])
  duree: number
  easing: string
}

export const EFFETS: Record<string, Effet> = {
  // A word arriving from the right, leaning and blurred, as if dragged in by the transition.
  mot: {
    images: [
      { opacity: 0, transform: 'translateX(1.1em) skewX(-16deg)', filter: 'blur(6px)' },
      { opacity: 1, transform: 'translateX(-.06em) skewX(4deg)', filter: 'blur(0)', offset: 0.7 },
      { opacity: 1, transform: 'none', filter: 'none' },
    ],
    duree: 700, easing: 'cubic-bezier(.2, .8, .3, 1)',
  },
  // An agenda row, a card, a block: slides in from the right with a slight bounce.
  entre: {
    images: [{ opacity: 0, transform: 'translateX(120px)' }, { opacity: 1, transform: 'none' }],
    duree: 700, easing: 'cubic-bezier(.2, .9, .25, 1.12)',
  },
  // Letters arriving from everywhere and assembling (drawn at random on every pass).
  eclate: {
    images: () => {
      const x = (Math.random() - 0.5) * 14
      const y = (Math.random() - 0.5) * 8
      const r = (Math.random() - 0.5) * 400
      const e = 0.3 + Math.random() * 2.2
      return [
        { opacity: 0, transform: `translate(${x.toFixed(2)}em, ${y.toFixed(2)}em) rotate(${r.toFixed(0)}deg) scale(${e.toFixed(2)})` },
        { opacity: 1, offset: 0.35 },
        { opacity: 1, transform: 'none' },
      ]
    },
    duree: 1100, easing: 'cubic-bezier(.16, .84, .3, 1)',
  },
  // Typewriter: each letter appears at once, in its turn.
  machine: { images: [{ opacity: 0 }, { opacity: 1 }], duree: 30, easing: 'steps(1, end)' },
  // A word slamming onto the screen.
  claque: {
    images: [
      { opacity: 0, transform: 'scale(3.2)', filter: 'blur(8px)' },
      { opacity: 1, transform: 'scale(.94)', filter: 'blur(0)', offset: 0.6 },
      { opacity: 1, transform: 'none', filter: 'none' },
    ],
    duree: 560, easing: 'cubic-bezier(.4, 0, .5, 1)',
  },
  monte: {
    images: [{ opacity: 0, transform: 'translateY(.6em)' }, { opacity: 1, transform: 'none' }],
    duree: 650, easing: 'cubic-bezier(.2, .9, .25, 1.2)',
  },
  lettre: {
    images: [
      { opacity: 0, transform: 'translateY(-.45em) scale(.2) rotate(-14deg)' },
      { opacity: 1, transform: 'translateY(0) scale(1.18) rotate(4deg)', offset: 0.6 },
      { opacity: 1, transform: 'none' },
    ],
    duree: 560, easing: 'ease-out',
  },
  pop: {
    images: [
      { opacity: 0, transform: 'scale(.3)' },
      { opacity: 1, transform: 'scale(1.08)', offset: 0.7 },
      { opacity: 1, transform: 'scale(1)' },
    ],
    duree: 560, easing: 'ease-out',
  },
  zoom: {
    images: [
      { opacity: 0, transform: 'scale(.72)' },
      { opacity: 1, transform: 'scale(1.03)', offset: 0.75 },
      { opacity: 1, transform: 'scale(1)' },
    ],
    duree: 950, easing: 'ease-out',
  },
  glisse: {
    images: [{ opacity: 0, transform: 'translateX(1.2em)' }, { opacity: 1, transform: 'none' }],
    duree: 650, easing: 'cubic-bezier(.2, .8, .2, 1)',
  },
  tampon: {
    images: [
      { opacity: 0, transform: 'scale(2.4)' },
      { opacity: 1, transform: 'scale(.93)', offset: 0.65 },
      { opacity: 1, transform: 'scale(1)' },
    ],
    duree: 500, easing: 'cubic-bezier(.35, 0, .55, 1)',
  },
  balayage: {
    images: [{ clipPath: 'inset(-15% 100% -15% -5%)' }, { clipPath: 'inset(-15% -5% -15% -5%)' }],
    duree: 950, easing: 'cubic-bezier(.6, 0, .2, 1)',
  },
  ecriture: {
    images: [{ clipPath: 'inset(-40% 100% -40% -10%)' }, { clipPath: 'inset(-40% -10% -40% -10%)' }],
    duree: 850, easing: 'cubic-bezier(.5, 0, .3, 1)',
  },
}

/** Effects that cut the text: into words (compatible with the violet outline) or letters. */
export const DECOUPES: Record<string, { mode: 'mots' | 'lettres'; effet: string; pas: number }> = {
  mots: { mode: 'mots', effet: 'mot', pas: 70 },
  claque: { mode: 'mots', effet: 'claque', pas: 170 },
  lettres: { mode: 'lettres', effet: 'lettre', pas: 40 },
  eclate: { mode: 'lettres', effet: 'eclate', pas: 22 },
  machine: { mode: 'lettres', effet: 'machine', pas: 55 },
}

/** When the effects start, as a fraction of the transition's duration. */
export const DEBUT_EFFETS: Record<string, number> = { cut: 0, fade: 0.2, slide: 0.35, wipe: 0.3, zoom: 0.25 }

/** Cuts a text into animatable words or letters (the outline goes on each word). */
export function decouper(el: HTMLElement, mode: 'mots' | 'lettres'): HTMLElement[] {
  const texte = el.textContent ?? ''
  const signature = `${mode}|${texte}`
  if (el.dataset.decoupe !== signature) {
    const contour = el.classList.contains('contour')
    const morceaux: Node[] = []
    let rang = 0
    for (const partie of texte.split(/(\s+)/)) {
      if (!partie) continue
      if (/^\s+$/.test(partie)) { morceaux.push(document.createTextNode(partie)); continue }
      if (mode === 'lettres') {
        const mot = cree('span', 'mot-lettres')
        for (const lettre of partie) {
          const l = cree('span', 'morceau', lettre)
          l.style.setProperty('--i', String(rang++))
          mot.append(l)
        }
        morceaux.push(mot)
      } else {
        const mot = cree('span', contour ? 'morceau contour' : 'morceau', partie)
        if (contour) mot.dataset.texte = partie
        mot.style.setProperty('--i', String(rang++))
        morceaux.push(mot)
      }
    }
    el.replaceChildren(...morceaux)
    if (contour) el.classList.add('decoupe')
    el.dataset.decoupe = signature
  }
  return [...el.querySelectorAll<HTMLElement>('.morceau')]
}

/** Whether this engine animates at all — a test DOM, an old Browser Source may not. */
export const peutAnimer = (): boolean =>
  typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'

export function jouerEffets(racine: ParentNode, depart: number): void {
  const anime = peutAnimer()
  for (const el of racine.querySelectorAll<HTMLElement>('[data-effet], [data-effet-enfants]')) {
    const delai = depart + (parseFloat(el.dataset.delai ?? '') || 0)
    let cibles: HTMLElement[]
    let nom: string
    let pas = parseFloat(el.dataset.pas ?? '')
    if (el.dataset.effetEnfants) {
      nom = el.dataset.effetEnfants
      cibles = [...(el.dataset.cible ? el.querySelectorAll<HTMLElement>(el.dataset.cible) : el.children)] as HTMLElement[]
      if (el.dataset.ordre === 'position') {
        const pos = new Map(cibles.map((c) => [c, c.getBoundingClientRect()]))
        cibles.sort((a, b) => (pos.get(a)!.top - pos.get(b)!.top) || (pos.get(a)!.left - pos.get(b)!.left))
      }
      if (Number.isNaN(pas)) pas = 80
    } else if (DECOUPES[el.dataset.effet ?? '']) {
      const d = DECOUPES[el.dataset.effet!]!
      nom = d.effet
      // Cut even where nothing animates: the words then carry their own outline,
      // which is what the page looks like everywhere else.
      cibles = decouper(el, d.mode)
      if (Number.isNaN(pas)) pas = d.pas
    } else {
      nom = el.dataset.effet ?? ''
      cibles = [el]
      pas = 0
    }
    const effet = EFFETS[nom]
    if (!anime || !effet || !cibles.length) continue
    pas = Math.min(pas, 2000 / cibles.length) // long lists stay lively
    cibles.forEach((c, i) => {
      c.getAnimations().forEach((a) => { if (a.id === 'effet') a.cancel() })
      const images = typeof effet.images === 'function' ? effet.images() : effet.images
      const a = c.animate(images, { duration: effet.duree, delay: delai + i * pas, easing: effet.easing, fill: 'backwards' })
      a.id = 'effet'
    })
  }
}
