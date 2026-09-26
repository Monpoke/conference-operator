import type { AgendaEntry } from '@conference-operator/program'
import type { Data, Scene } from '../scene.js'
import { cree, ecrire } from '../dom.js'
import { heureDans, maintenant } from '../time.js'

const POLICE_MAX = 68 // px, the agenda's largest text

/** Which day a schedule scene shows: the room's own, or another room's. */
export interface Journee {
  nom: string
  entries: AgendaEntry[]
  /** The room this screen stands in: it carries the « Vous êtes ici » badge. */
  ici: boolean
}

/** The room's own day. */
export const journeeIci = (data: Data): Journee => ({ nom: data.roomName ?? '', entries: data.agenda, ici: true })

/** Another room's day, the `index`-th the hub leaves shown. */
export const journeeAutre = (index: number) => (data: Data): Journee | null => {
  const planning = data.plannings[index]
  return planning == null ? null : { nom: planning.nom, entries: planning.agenda, ici: false }
}

/**
 * A room's day in two columns, text size computed to fill the space.
 *
 * The reference's agenda: the room's slots, the shared ones covering it, the
 * pill of another room when a slot happens there. Finished sessions leave, and the
 * rest of the day takes their room. The same scene shows the other rooms' days;
 * only this room's carries « Vous êtes ici ».
 */
export function agenda(el: HTMLElement, lire: (data: Data) => Journee | null = journeeIci): Scene {
  el.innerHTML = `
    <header class="bande">
      <div class="bande-titre">
        <h2 class="f-titre" data-titre data-effet="mots"></h2>
        <span class="pastille pastille-ici" data-ici data-effet="pop" data-delai="500" hidden>Vous êtes ici</span>
      </div>
      <p class="bande-droite" data-horloge>--:--</p>
    </header>
    <div class="contenu agenda" data-effet-enfants="entre" data-cible=".seance" data-pas="60" data-delai="200">
      <ol class="agenda-col"></ol>
      <ol class="agenda-col"></ol>
    </div>
    <p class="vide" hidden>Programme indisponible</p>`
  const titre = el.querySelector<HTMLElement>('[data-titre]')!
  const ici = el.querySelector<HTMLElement>('[data-ici]')!
  const horloge = el.querySelector<HTMLElement>('[data-horloge]')!
  const zone = el.querySelector<HTMLElement>('.agenda')!
  const cols = [...el.querySelectorAll<HTMLElement>('.agenda-col')] as [HTMLElement, HTMLElement]
  const vide = el.querySelector<HTMLElement>('.vide')!

  let toutes: AgendaEntry[] = []
  let sessions: AgendaEntry[] = []
  let lignes: HTMLElement[] = []
  let nbTerminees = 0
  let heureAffichee = ''
  let derniere = -1

  const masquer = (data: Data) => data.boucle?.agenda.masquerTerminees ?? true
  /** The room's forced talk — only on this room's own day, the others follow their clock. */
  const epingle = (data: Data): string | null => (lire(data)?.ici ? (data.state.pinnedSessionId ?? null) : null)

  function ligne(s: AgendaEntry, tz: string): HTMLElement {
    const li = cree('li', s.pause ? 'seance est-pause' : 'seance')
    const heure = cree('div', 'seance-heure')
    heure.append(cree('strong', null, heureDans(s.startsAtMs, tz)))
    heure.append(cree('span', null, heureDans(s.endsAtMs, tz)))
    const corps = cree('div', 'seance-corps')
    corps.append(cree('p', 'seance-titre', s.title))
    const qui = s.speakers.map((p) => (p.company ? `${p.name} (${p.company})` : p.name)).join(', ')
    const pastilles: HTMLElement[] = []
    if (s.elsewhere) pastilles.push(cree('span', 'pastille pastille-lieu', s.elsewhere))
    if (s.language) pastilles.push(cree('span', 'pastille pastille-langue', s.language))
    if (qui || pastilles.length) {
      const meta = cree('p', 'seance-meta')
      meta.append(...pastilles)
      if (qui) meta.append(qui)
      corps.append(meta)
    }
    li.append(heure, corps, cree('i', 'seance-avance'))
    return li
  }

  /**
   * The largest text size that fits, and the best break point between the two
   * columns (keeping the chronological order). Measured: the stage is laid out
   * even while the scene is transparent. Where nothing measures — a test DOM —
   * it keeps the smallest size and splits in half.
   */
  function ajuster(): void {
    const [A, B] = cols
    A.replaceChildren(...lignes)
    B.replaceChildren()
    const n = lignes.length
    if (!n) return
    const dispo = zone.clientHeight - 4
    const essai = (fs: number) => {
      zone.style.setProperty('--fs', `${fs}px`)
      const gap = parseFloat(getComputedStyle(A).rowGap) || 0
      const h = lignes.map((li) => li.offsetHeight)
      const total = h.reduce((a, b) => a + b, 0)
      let meilleur = { k: n, max: Infinity }
      let gauche = 0
      for (let k = 0; k <= n; k++) {
        if (k) gauche += h[k - 1]!
        const hg = gauche + gap * Math.max(0, k - 1)
        const hd = total - gauche + gap * Math.max(0, n - k - 1)
        const max = Math.max(hg, hd)
        if (max < meilleur.max) meilleur = { k, max }
      }
      return meilleur
    }
    let bas = 12
    let haut = POLICE_MAX
    let retenu: { fs: number; k: number } | null = null
    if (dispo > 0) {
      for (let i = 0; i < 12; i++) {
        const fs = (bas + haut) / 2
        const r = essai(fs)
        if (r.max <= dispo) { retenu = { fs, k: r.k }; bas = fs } else haut = fs
      }
    }
    if (!retenu) retenu = { fs: dispo > 0 ? 12 : 32, k: dispo > 0 ? essai(12).k : Math.ceil(n / 2) }
    zone.style.setProperty('--fs', `${retenu.fs.toFixed(2)}px`)
    B.append(...lignes.slice(retenu.k))
  }

  const scene: Scene = {
    el,
    cle: (data: Data) => [lire(data), data.timezone, masquer(data), epingle(data), data.state.nextSession?.id ?? null],
    jouable: (data: Data) => (lire(data)?.entries.length ?? 0) > 0,
    rendre(data: Data) {
      const journee = lire(data)
      ecrire(titre, journee?.nom ?? '')
      ici.hidden = !journee?.ici
      toutes = journee?.entries ?? []
      vide.hidden = toutes.length > 0
      const m = maintenant(data)
      nbTerminees = toutes.filter((s) => m >= s.endsAtMs).length
      // Finished sessions leave to give the rest of the day all the room — except
      // at the end of the day, when the whole program stays.
      // A forced talk and the one it jumped over stay, even past their slot.
      const gardees = [epingle(data), epingle(data) == null ? null : (data.state.nextSession?.id ?? null)]
      const restantes = toutes.filter((s) => m < s.endsAtMs || gardees.includes(s.id))
      sessions = masquer(data) && restantes.length ? restantes : toutes
      lignes = sessions.map((s) => ligne(s, data.timezone))
      derniere = -1
      scene.tick!(data, m)
      ajuster()
    },
    tick(data: Data, m: number) {
      const secondes = Math.floor(m / 1000)
      if (secondes === derniere) return
      derniere = secondes
      const heure = heureDans(m, data.timezone)
      if (heure !== heureAffichee) {
        const [hh, mm] = heure.split(':')
        horloge.replaceChildren(hh ?? '', cree('span', 'deux-points', ':'), mm ?? '')
        if (heureAffichee && typeof horloge.animate === 'function') {
          horloge.animate([{ opacity: 0, transform: 'translateY(-.55em)' }, { opacity: 1, transform: 'none' }],
            { duration: 550, easing: 'cubic-bezier(.2, .9, .25, 1.2)' })
        }
        heureAffichee = heure
      }
      // A session just ended: the agenda is rebuilt as soon as it is off screen.
      if (masquer(data) && toutes.filter((s) => m >= s.endsAtMs).length !== nbTerminees) scene.sale = true
      /*
       * A forced talk is what the room is on, whatever the clock says, and the
       * next one is the room's word, not the schedule's: the talk it jumped over
       * comes next even though its slot is behind.
       */
      const force = epingle(data)
      const suivante = force == null
        ? sessions.findIndex((s) => s.startsAtMs > m && !s.pause)
        : sessions.findIndex((s) => s.id === data.state.nextSession?.id)
      sessions.forEach((s, i) => {
        const li = lignes[i]!
        const enCours = force == null ? m >= s.startsAtMs && m < s.endsAtMs : s.id === force
        li.classList.toggle('est-passee', m >= s.endsAtMs)
        li.classList.toggle('est-encours', enCours)
        li.classList.toggle('est-suivante', i === suivante)
        li.style.setProperty('--avance', enCours ? ((m - s.startsAtMs) / (s.endsAtMs - s.startsAtMs)).toFixed(4) : '0')
      })
    },
  }
  return scene
}
