import type { AgendaEntry } from '@conference-operator/program'
import type { Data, Scene } from '../scene.js'
import { cree, ecrire } from '../dom.js'
import { heureDans, maintenant } from '../time.js'

const POLICE_MAX = 68 // px, the agenda's largest text

/**
 * The room's day in two columns, text size computed to fill the space.
 *
 * The reference's agenda, fed by `data.agenda`: the room's slots, the shared ones
 * covering it, the plenaries held elsewhere with an orange pill. Finished
 * sessions leave, and the rest of the day takes their room.
 */
export function agenda(el: HTMLElement): Scene {
  el.innerHTML = `
    <header class="bande">
      <h2 class="f-titre" data-titre data-effet="mots"></h2>
      <p class="bande-droite" data-horloge>--:--</p>
    </header>
    <div class="contenu agenda" data-effet-enfants="entre" data-cible=".seance" data-pas="60" data-delai="200">
      <ol class="agenda-col"></ol>
      <ol class="agenda-col"></ol>
    </div>
    <p class="vide" hidden>Programme indisponible</p>`
  const titre = el.querySelector<HTMLElement>('[data-titre]')!
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
    cle: (data: Data) => [data.agenda, data.roomName, data.timezone, masquer(data)],
    jouable: (data: Data) => data.agenda.length > 0,
    rendre(data: Data) {
      ecrire(titre, data.roomName ?? '')
      toutes = data.agenda
      vide.hidden = toutes.length > 0
      const m = maintenant(data)
      nbTerminees = toutes.filter((s) => m >= s.endsAtMs).length
      // Finished sessions leave to give the rest of the day all the room — except
      // at the end of the day, when the whole program stays.
      const restantes = toutes.filter((s) => m < s.endsAtMs)
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
      const suivante = sessions.findIndex((s) => s.startsAtMs > m && !s.pause)
      sessions.forEach((s, i) => {
        const li = lignes[i]!
        const enCours = m >= s.startsAtMs && m < s.endsAtMs
        li.classList.toggle('est-passee', m >= s.endsAtMs)
        li.classList.toggle('est-encours', enCours)
        li.classList.toggle('est-suivante', i === suivante)
        li.style.setProperty('--avance', enCours ? ((m - s.startsAtMs) / (s.endsAtMs - s.startsAtMs)).toFixed(4) : '0')
      })
    },
  }
  return scene
}
