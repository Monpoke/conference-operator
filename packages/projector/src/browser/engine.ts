import type { DisplayMode } from '@conference-operator/contract'
import type { Data, Scene } from './scene.js'
import { contours, cree, linkedin } from './dom.js'
import { DEBUT_EFFETS, jouerEffets, peutAnimer } from './effects.js'
import { maintenant } from './time.js'
import { programmation, SCENES, type DefinitionScene, type Etape, type Programmation } from './sequence.js'

/**
 * Settings of the page itself, the reference's `REGLAGES`.
 *
 * Overridable from `window.__BOUCLE__` — the tests and the offline preview cut
 * the transitions and the effects to get a stable frame.
 */
export interface Reglages {
  effets: boolean
  barreProgression: boolean
  /** Forces one transition for every scene (`cut` in the tests). */
  transition: string | null
  /** Honour the machine's "reduce motion". Ignored by default: this is a display. */
  reduireAnimations: boolean
}

interface Montee {
  def: DefinitionScene
  scene: Scene
  cle: string
  sale: boolean
}

/** Scenes that replay their entry when they change in front of the room: a new question is news. */
const ANIMEES_SUR_PLACE = new Set(['banniere', 'question', 'avis'])

export const NOMS_TRANSITIONS: Record<string, string> = {
  cut: 'Coupure', fade: 'Fondu', slide: 'Glissement', wipe: 'Balayage',
  zoom: 'Zoom', dip: 'Fondu au noir', stinger: 'Stinger',
}

const EASE = 'cubic-bezier(.77, 0, .18, 1)'
const prochaineImage = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
const attendre = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class Regie {
  readonly scenes = new Map<string, Montee>()
  data: Data | null = null
  mode: DisplayMode | null = null
  prog: Programmation = programmation('loop')
  courante = 0
  visible: Montee | null = null
  ecoule = 0
  enPause = false
  enTransition = false
  transitionForcee: string | null = null
  private enAttente: { i: number; transition?: string } | null = null
  private dernierTick = Date.now()
  private animBarre: Animation | null = null
  private readonly barre = document.querySelector<HTMLElement>('#progression i')
  private readonly voile = document.getElementById('voile')!
  private readonly stinger = document.getElementById('stinger')!
  private readonly logo = document.getElementById('logo') as HTMLImageElement
  /** Called after every change the control panel shows. */
  onChange: () => void = () => {}

  constructor(readonly reglages: Reglages) {
    for (const def of SCENES) {
      const el = document.querySelector<HTMLElement>(`[data-scene="${def.id}"]`)
      if (el == null) continue
      if (def.signature) el.dataset.signature = ''
      this.scenes.set(def.id, { def, scene: def.fabrique(el), cle: '', sale: true })
    }
    if (reglages.reduireAnimations) document.documentElement.classList.add('anim-reduites')
  }

  /* ================= Data ================= */

  /** A new state: mark what changed, rebuild what is off screen, follow the mode. */
  recevoir(data: Data): void {
    const premier = this.data == null
    this.data = data
    document.body.dataset.mode = data.state.mode
    document.body.dataset.connectivity = data.state.connectivity
    if (data.eventIdentity?.name) document.title = `${data.eventIdentity.name} — écran de salle`
    this.majLogo(data)
    this.majSignatures(data)

    for (const m of this.scenes.values()) {
      let cle: string
      try { cle = JSON.stringify(m.scene.cle(data) ?? null) } catch { cle = String(Math.random()) }
      if (cle !== m.cle) { m.cle = cle; m.sale = true }
    }

    if (premier) {
      this.rendreSales(true)
      this.mode = data.state.mode
      this.prog = programmation(data.state.mode)
      this.courante = this.premiereJouable()
      const depart = this.scenes.get(this.etape().scene)!
      depart.scene.el.classList.add('is-live')
      this.visible = depart
      this.barreDepart()
      this.onChange()
      return
    }

    this.rendreSales(false)
    if (data.state.mode !== this.mode) this.changerMode(data.state.mode)
  }

  /** The first scene to play, with its effects: after the loading screen lifts. */
  lever(delai = 250): void {
    if (this.visible && this.reglages.effets) jouerEffets(this.visible.scene.el, delai)
  }

  private etape(i = this.courante): Etape {
    return this.prog.etapes[i] ?? this.prog.etapes[0]!
  }

  /** Seconds on screen: the hub's setting for its kind, or the reference's. */
  duree(e: Etape | undefined = this.etape()): number {
    if (e == null) return 0
    // A sponsor page or another room's schedule may carry its own.
    if (e.page?.de === 'sponsors') {
      const own = this.data?.boucle?.sponsorPages[e.page.index]?.duree
      if (own != null) return own
    }
    if (e.page?.de === 'plannings') return this.data?.plannings[e.page.index]?.duree ?? 15
    return (e.groupe != null ? this.data?.boucle?.durees[e.groupe] : undefined) ?? e.duree
  }

  private estVisible(m: Montee): boolean {
    const cl = m.scene.el.classList
    return cl.contains('is-live') || cl.contains('is-entering')
  }

  /**
   * Rebuilds the dirty scenes. Off screen always; in front of the room only the
   * screen the operator put up — the loop never changes a scene under the eyes of
   * the public.
   */
  private rendreSales(tout: boolean): void {
    const data = this.data
    if (data == null) return
    for (const m of this.scenes.values()) {
      if (!m.sale && !m.scene.sale) continue
      const visible = !tout && this.estVisible(m)
      if (visible && this.prog.tourne) continue
      m.sale = false
      m.scene.sale = false
      try {
        m.scene.rendre(data)
        contours(m.scene.el)
      } catch (cause) {
        console.error(`Scène « ${m.def.nom} »`, cause)
      }
      if (visible && ANIMEES_SUR_PLACE.has(m.def.id) && this.reglages.effets) jouerEffets(m.scene.el, 0)
    }
  }

  /**
   * Everything rebuilt — the R key, off screen only. `aussiVisible`: the scene on
   * screen too, for the one moment it is allowed — under the loading screen, once
   * the typefaces have arrived and every measurement is to be taken again.
   */
  relire(aussiVisible = false): void {
    for (const m of this.scenes.values()) m.sale = true
    this.rendreSales(aussiVisible)
  }

  private majLogo(data: Data): void {
    const url = data.boucle?.logoUrl ?? data.event?.logoUrl ?? null
    if (url) {
      if (this.logo.getAttribute('src') !== url) this.logo.src = url
      this.logo.alt = data.eventIdentity?.name ?? ''
      this.logo.hidden = false
      this.logo.style.visibility = 'visible'
    } else {
      this.logo.hidden = true
    }
  }

  private majSignatures(data: Data): void {
    const s = data.boucle?.signature ?? null
    for (const m of this.scenes.values()) {
      if (!m.def.signature) continue
      let bloc = m.scene.el.querySelector<HTMLElement>(':scope > .signature')
      if (!s || !s.texte) { bloc?.remove(); continue }
      if (!bloc) {
        bloc = cree('div', 'signature')
        bloc.dataset.effet = 'glisse'
        bloc.dataset.delai = '600'
        m.scene.el.append(bloc)
      }
      const enfants: Node[] = []
      if (s.icone === 'linkedin') enfants.push(linkedin())
      enfants.push(cree('span', null, s.texte))
      bloc.replaceChildren(...enfants)
    }
  }

  /* ================= What plays ================= */

  /** Withdrawn on the hub — only the loop listens to it. */
  private retiree(e: Etape): boolean {
    const retires = this.data?.screensDisabled ?? []
    return (e.ecran != null && retires.includes(e.ecran)) || (e.aussi != null && retires.includes(e.aussi))
  }

  jouable(i: number): boolean {
    const e = this.prog.etapes[i]
    if (e == null || this.data == null) return false
    // One screen chosen by the operator is shown, even empty: it then says so.
    if (!this.prog.tourne) return true
    if (this.retiree(e)) return false
    const m = this.scenes.get(e.scene)
    if (m == null) return false
    try { return m.scene.jouable(this.data) } catch { return false }
  }

  private premiereJouable(): number {
    for (let i = 0; i < this.prog.etapes.length; i++) if (this.jouable(i)) return i
    return 0
  }

  voisine(depart: number, sens: 1 | -1): number {
    const n = this.prog.etapes.length
    for (let k = 1; k <= n; k++) {
      const i = (((depart + sens * k) % n) + n) % n
      if (this.jouable(i)) return i
    }
    return this.jouable(depart) ? depart : this.premiereJouable()
  }

  /**
   * The operator changed the screen. Coming back to the loop always restarts at
   * the welcome, with the stinger — never in the middle of the agenda, two
   * seconds before the next switch.
   */
  private changerMode(mode: DisplayMode): void {
    this.mode = mode
    this.prog = programmation(mode)
    this.courante = -1
    const cible = this.premiereJouable()
    void this.allerA(cible)
  }

  /* ================= Transitions ================= */

  private anim(el: Element, images: Keyframe[], duration: number, easing = EASE): Promise<unknown> {
    return el.animate(images, { duration, easing, fill: 'forwards' }).finished
  }

  private readonly TRANSITIONS: Record<string, (p: { from: HTMLElement; to: HTMLElement; d: number; swap: () => void }) => Promise<unknown>> = {
    cut: async () => {},
    fade: ({ from, to, d }) => Promise.all([
      this.anim(from, [{ opacity: 1 }, { opacity: 0 }], d, 'ease-in-out'),
      this.anim(to, [{ opacity: 0 }, { opacity: 1 }], d, 'ease-in-out'),
    ]),
    slide: ({ from, to, d }) => Promise.all([
      this.anim(from, [{ transform: 'translateX(0)' }, { transform: 'translateX(-100%)' }], d),
      this.anim(to, [{ opacity: 1, transform: 'translateX(100%)' }, { opacity: 1, transform: 'translateX(0)' }], d),
    ]),
    wipe: ({ from, to, d }) => Promise.all([
      this.anim(from, [{ clipPath: 'inset(0 0 0 0%)' }, { clipPath: 'inset(0 0 0 100%)' }], d),
      this.anim(to, [{ opacity: 1, clipPath: 'inset(0 100% 0 0)' }, { opacity: 1, clipPath: 'inset(0 0% 0 0)' }], d),
    ]),
    zoom: ({ from, to, d }) => Promise.all([
      this.anim(from, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.9)' }], d),
      this.anim(to, [{ opacity: 0, transform: 'scale(1.12)' }, { opacity: 1, transform: 'scale(1)' }], d),
    ]),
    dip: async ({ d, swap }) => {
      await this.anim(this.voile, [{ opacity: 0 }, { opacity: 1 }], d / 2, 'ease-in')
      swap()
      await this.anim(this.voile, [{ opacity: 1 }, { opacity: 0 }], d / 2, 'ease-out')
    },
    stinger: async ({ d, swap }) => {
      await this.anim(this.stinger, [
        { transform: 'translateX(-2800px) skewX(-14deg)' },
        { transform: 'translateX(0) skewX(-14deg)' },
      ], d / 2, 'cubic-bezier(.55, 0, .9, .6)')
      swap() // switches while the band covers the whole screen
      await this.anim(this.stinger, [
        { transform: 'translateX(0) skewX(-14deg)' },
        { transform: 'translateX(2800px) skewX(-14deg)' },
      ], d / 2, 'cubic-bezier(.1, .4, .45, 1)')
    },
  }

  get nomsTransitions(): string[] {
    return Object.keys(this.TRANSITIONS)
  }

  async allerA(index: number, transition?: string): Promise<void> {
    const n = this.prog.etapes.length
    const i = ((index % n) + n) % n
    if (this.enTransition) { this.enAttente = { i, transition }; return }
    const vers = this.scenes.get(this.etape(i).scene)
    if (vers == null) return
    const depuis = this.visible
    if (vers === depuis) {
      this.courante = i
      this.ecoule = 0
      this.barreDepart()
      this.onChange()
      return
    }

    // The scene coming in is rebuilt before it shows, if its data moved.
    if ((vers.sale || vers.scene.sale) && this.data) {
      vers.sale = false
      vers.scene.sale = false
      try { vers.scene.rendre(this.data); contours(vers.scene.el) } catch (cause) { console.error(cause) }
    }

    const e = this.etape(i)
    let nom = transition ?? this.reglages.transition ?? this.transitionForcee ?? e.transition
    if (!this.TRANSITIONS[nom]) nom = 'fade'
    if (this.reglages.reduireAnimations && nom !== 'cut') nom = 'fade'
    if (!peutAnimer() || depuis == null) nom = 'cut'
    const d = e.dureeTransition

    this.enTransition = true
    // With a veil (stinger, dip), the effects start when the content is uncovered.
    const avecVoile = nom === 'dip' || nom === 'stinger'
    let bascule = false
    const swap = () => {
      if (bascule) return
      bascule = true
      vers.scene.el.classList.add('is-live')
      depuis?.scene.el.classList.remove('is-live')
      if (avecVoile && this.reglages.effets) jouerEffets(vers.scene.el, 60)
    }
    const finir = () => {
      swap()
      vers.scene.el.classList.remove('is-entering')
      for (const el of [depuis?.scene.el, vers.scene.el, this.voile, this.stinger]) {
        el?.getAnimations?.().forEach((a) => a.cancel())
      }
      this.courante = i
      this.visible = vers
      this.ecoule = 0
      this.enTransition = false
      this.barreDepart()
      this.onChange()
      if (depuis?.scene.quitte && this.data) {
        const data = this.data
        setTimeout(() => { if (!this.estVisible(depuis)) depuis.scene.quitte!(data) }, 150)
      }
      // What was dirty on the scene that just left can now be rebuilt.
      this.rendreSales(false)
      const suite = this.enAttente
      this.enAttente = null
      if (suite) void this.allerA(suite.i, suite.transition)
    }

    vers.scene.el.classList.add('is-entering')
    if (nom === 'cut') {
      if (this.reglages.effets) jouerEffets(vers.scene.el, 0)
      finir()
      return
    }
    // Two frames ahead: the incoming scene's layer is ready before it moves.
    await prochaineImage()
    await prochaineImage()
    this.barreVide(d)
    if (!avecVoile && this.reglages.effets) jouerEffets(vers.scene.el, d * (DEBUT_EFFETS[nom] ?? 0))
    try {
      // A background tab may never finish an animation: the switch happens anyway.
      await Promise.race([this.TRANSITIONS[nom]!({ from: depuis!.scene.el, to: vers.scene.el, d, swap }), attendre(d + 800)])
    } catch (cause) {
      console.error('Transition interrompue', cause)
    } finally {
      finir()
    }
  }

  suivante(): void { void this.allerA(this.voisine(this.courante, 1)) }
  precedente(): void { void this.allerA(this.voisine(this.courante, -1)) }

  /* ================= Progress bar ================= */

  private jouerBarre(images: Keyframe[], duree: number, easing: string): void {
    if (this.barre == null) return
    const cadre = this.barre.parentElement!
    cadre.hidden = !this.reglages.barreProgression || !this.prog.tourne
    if (cadre.hidden || !peutAnimer()) return
    this.animBarre?.cancel()
    this.animBarre = this.barre.animate(images, { duration: Math.max(1, duree), easing, fill: 'forwards' })
    if (this.enPause) this.animBarre.pause()
  }

  private barreDepart(): void {
    this.jouerBarre([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], this.duree() * 1000, 'linear')
  }

  private barreVide(duree: number): void {
    this.jouerBarre([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], duree, 'ease-in-out')
  }

  basculerPause(): void {
    this.enPause = !this.enPause
    if (this.animBarre) (this.enPause ? this.animBarre.pause() : this.animBarre.play())
    this.onChange()
  }

  /* ================= The clock ================= */

  /**
   * Every second: the scenes' clocks, then the loop moves on when the scene's
   * time is up. A second is plenty for durations counted in seconds, and it
   * keeps running where an OBS source slows its animation frames down.
   */
  tick(): void {
    const data = this.data
    const t = Date.now()
    const dt = Math.min(t - this.dernierTick, 5_000)
    this.dernierTick = t
    if (data == null) return
    const now = maintenant(data)
    for (const m of this.scenes.values()) {
      if (!m.scene.tick) continue
      try { m.scene.tick(data, now) } catch (cause) { console.error(`Scène « ${m.def.nom} »`, cause) }
    }
    this.rendreSales(false)

    if (this.prog.tourne && !this.enPause && !this.enTransition) {
      this.ecoule += dt
      if (this.ecoule >= this.duree() * 1000) {
        const suivante = this.voisine(this.courante, 1)
        if (suivante === this.courante) this.ecoule = 0
        else void this.allerA(suivante)
      }
    }
  }
}
