import { cree } from './dom.js'
import { NOMS_TRANSITIONS, type Regie } from './engine.js'
import { heureDans, maintenant } from './time.js'

/** The control panel (H): what plays, for how long, and what the page knows. */
export class Hud {
  private readonly el = document.getElementById('hud')!
  private readonly liste = this.el.querySelector<HTMLElement>('[data-hud-liste]')!
  private readonly barre = this.el.querySelector<HTMLElement>('[data-hud-barre]')!
  private readonly etat = this.el.querySelector<HTMLElement>('[data-hud-etat]')!
  private readonly transition = this.el.querySelector<HTMLElement>('[data-hud-transition]')!
  private readonly infos = this.el.querySelector<HTMLElement>('[data-hud-infos]')!
  private prog: unknown = null

  constructor(private readonly regie: Regie) {}

  basculer(): void {
    this.el.hidden = !this.el.hidden
    document.body.classList.toggle('hud-on', !this.el.hidden)
    this.maj(true)
  }

  maj(complet: boolean): void {
    if (this.el.hidden) return
    const r = this.regie
    const etape = r.prog.etapes[r.courante]
    const duree = r.duree(etape)
    this.barre.style.transform = `scaleX(${duree ? Math.min(1, r.ecoule / (duree * 1000)) : 0})`
    if (!complet) return
    const cle = JSON.stringify(r.prog.etapes.map((e) => [e.scene, r.duree(e)]))
    if (this.prog !== cle) {
      this.prog = cle
      this.liste.replaceChildren(...r.prog.etapes.map((e, i) => {
        const li = cree('li', null, `${i + 1}. ${r.scenes.get(e.scene)?.def.nom ?? e.scene}`)
        li.append(cree('span', null, r.prog.tourne ? `${r.duree(e)} s, ${NOMS_TRANSITIONS[e.transition] ?? e.transition}` : 'tenu'))
        return li
      }))
    }
    ;[...this.liste.children].forEach((li, i) => {
      li.classList.toggle('est-live', i === r.courante)
      li.classList.toggle('est-vide', !r.jouable(i))
    })
    this.etat.textContent = r.enPause ? 'En pause' : 'Lecture'
    this.transition.textContent = r.transitionForcee
      ? `Transition forcée : ${NOMS_TRANSITIONS[r.transitionForcee] ?? r.transitionForcee}`
      : 'Transition propre à chaque scène'
    const data = r.data
    const infos: string[] = []
    if (data) {
      infos.push(`Mode : ${data.state.mode}`)
      if (data.roomName) infos.push(`Salle : ${data.roomName}`)
      infos.push(`Heure du hub : ${heureDans(maintenant(data), data.timezone)}`)
      if (data.state.serverTimeOffsetMs && Math.abs(data.state.serverTimeOffsetMs) > 60_000) infos.push('horloge du hub décalée')
      if (data.boucle?.wallsio.src) infos.push(`Walls.io : ${data.wallsIoReachable ? 'joignable' : 'hors ligne, scène sautée'}`)
      if (data.screensDisabled.length) infos.push(`Écrans retirés : ${data.screensDisabled.join(', ')}`)
    }
    this.infos.textContent = infos.join('. ')
  }
}
