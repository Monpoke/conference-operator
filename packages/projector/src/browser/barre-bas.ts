import type { Data } from './scene.js'
import { cree } from './dom.js'
import { heureDans, maintenant } from './time.js'

/**
 * The permanent bottom band: the room's next session on the left (with the room
 * name when it happens elsewhere), the message with the hashtag in the centre,
 * the time on the right — and, discreetly, the room's break and its link to the
 * hub, which the old frame used to carry.
 */
export class BarreBas {
  private readonly el = document.getElementById('barre-bas')!
  private readonly q = <T extends HTMLElement>(sel: string) => this.el.querySelector<T>(sel)!
  private readonly libelle = this.q('[data-bb-libelle]')
  private readonly heure = this.q('[data-bb-heure]')
  private readonly titre = this.q('[data-bb-titre]')
  private readonly salle = this.q('[data-bb-salle]')
  private readonly message = this.q('[data-bb-message]')
  private readonly hashtag = this.q('[data-bb-hashtag]')
  private readonly horloge = this.q('[data-bb-horloge]')
  private readonly pause = this.q('#break-badge')
  private readonly lien = this.q('#status-dot')
  private seconde = -1
  private heureAffichee = ''
  private prochain = ''

  maj(data: Data, force = false): void {
    const conf = data.boucle?.barreBas
    const masquee = conf?.afficher === false
    // Read by the stylesheet: the scenes' own clock stands in for the band's.
    document.body.classList.toggle('sans-barre-bas', masquee)
    if (masquee) { this.el.hidden = true; return }
    this.el.hidden = false
    const now = maintenant(data)
    const s = Math.floor(now / 1000)
    if (s === this.seconde && !force) return
    this.seconde = s

    const heure = heureDans(now, data.timezone)
    if (heure !== this.heureAffichee) {
      const [hh, mm] = heure.split(':')
      this.horloge.replaceChildren(hh ?? '', cree('span', 'deux-points', ':'), mm ?? '')
      if (this.heureAffichee && typeof this.horloge.animate === 'function') {
        this.horloge.animate([{ opacity: 0, transform: 'translateY(-.5em)' }, { opacity: 1, transform: 'none' }],
          { duration: 550, easing: 'cubic-bezier(.2, .9, .25, 1.2)' })
      }
      this.heureAffichee = heure
    }

    this.message.textContent = conf?.message ?? 'Partagez la journée avec'
    this.hashtag.textContent = conf?.hashtag ?? ''

    // The room's break, running or coming — says *why* the screen is on the loop.
    const pause = data.state.breakBadge
    this.pause.hidden = pause == null
    if (pause != null) {
      this.pause.textContent = pause.state === 'en-cours' ? 'Pause' : 'Pause à venir'
      this.pause.classList.toggle('a-venir', pause.state !== 'en-cours')
    }
    // Only when something is wrong: it speaks to the technician, not to the room.
    this.lien.hidden = data.state.connectivity === 'ONLINE'

    // The room's next session: breaks skipped, to announce a real talk.
    const suivante = data.agenda.find((e) => e.startsAtMs > now && !e.pause)
    const empreinte = suivante ? `${suivante.startsAtMs}|${suivante.title}|${suivante.elsewhere}` : 'rien'
    if (empreinte !== this.prochain || force) {
      this.prochain = empreinte
      if (suivante) {
        this.libelle.textContent = conf?.libelle ?? 'Ensuite'
        this.heure.textContent = heureDans(suivante.startsAtMs, data.timezone)
        this.titre.textContent = suivante.title
        this.salle.textContent = suivante.elsewhere ?? ''
        this.salle.hidden = !suivante.elsewhere
      } else {
        this.libelle.textContent = ''
        this.heure.textContent = ''
        this.titre.textContent = data.agenda.length ? (conf?.finJournee ?? "Merci et à l'année prochaine !") : ''
        this.salle.hidden = true
      }
      const bloc = this.el.querySelector<HTMLElement>('.bb-prochain')
      if (bloc && typeof bloc.animate === 'function') {
        bloc.animate([{ opacity: 0, transform: 'translateY(.45em)' }, { opacity: 1, transform: 'none' }],
          { duration: 650, easing: 'cubic-bezier(.2, .9, .25, 1.15)' })
      }
    }
  }
}
