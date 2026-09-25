import type { Data } from './scene.js'
import { BarreBas } from './barre-bas.js'
import { Regie, type Reglages } from './engine.js'
import { Hud } from './hud.js'
import { peutAnimer } from './effects.js'

declare global {
  interface Window {
    __PREVIEW__?: boolean
    __BOUCLE__?: Partial<Reglages>
    __BOUCLE_ARRET__?: AbortController
    boucle?: Record<string, unknown>
    applyStreamPatch?: (current: Data, patch: unknown) => Data
  }
}

/**
 * The projected page's entry point.
 *
 * The state arrives embedded in the page — no blank screen when the Browser
 * Source reloads — then over the SSE stream, which reconnects by itself. The
 * stage is scaled to the window: the design is a fixed 1920×1080, which holds
 * from a 1024×768 projector to a 4K one.
 */
export function demarrer(): void {
  const params = new URLSearchParams(location.search)
  const reglages: Reglages = {
    effets: true,
    barreProgression: true,
    transition: null,
    reduireAnimations: params.get('animations') === 'reduites',
    ...(window.__BOUCLE__ ?? {}),
  }

  // A page replayed in the same window — the tests, a preview — drops the
  // listeners of the previous one: two instances would each act on every key.
  window.__BOUCLE_ARRET__?.abort()
  const arret = new AbortController()
  window.__BOUCLE_ARRET__ = arret
  const { signal } = arret

  const plateau = document.getElementById('stage')!
  /*
   * The hub's preview, opened on a phone: held upright, the 16:9 stage would be
   * a strip in the middle. It turns a quarter so the phone only has to be turned.
   * Previews only, and touch screens only: a room machine, or a narrow window
   * on a desk, are never turned.
   */
  const apercu = window.__PREVIEW__ === true
  const tactile = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  document.body.classList.toggle('apercu', apercu)
  const ajuster = () => {
    const pivote = apercu && tactile && innerHeight > innerWidth
    document.body.classList.toggle('pivote', pivote)
    const [largeur, hauteur] = pivote ? [innerHeight, innerWidth] : [innerWidth, innerHeight]
    plateau.style.setProperty('--scale', String(Math.min(largeur / 1920, hauteur / 1080) || 1))
  }
  addEventListener('resize', ajuster, { signal })
  addEventListener('orientationchange', ajuster, { signal })
  ajuster()

  const regie = new Regie(reglages)
  const barre = new BarreBas()
  const hud = new Hud(regie)
  regie.onChange = () => hud.maj(true)
  let courant: Data | null = null

  const recevoir = (data: Data) => {
    const premier = courant == null
    courant = data
    regie.recevoir(data)
    barre.maj(data, true)
    if (premier) void lever()
  }

  /**
   * The loading screen lifts once the first state is drawn **and the typefaces
   * are there**, as in the reference loop: the agenda and the sponsor pages are
   * sized by measuring their text, and measured in a fallback face they overflow
   * once the real one arrives. Three seconds at most — a missing face must not
   * keep the screen dark.
   */
  async function lever(): Promise<void> {
    const polices = document.fonts?.ready
    if (polices != null) {
      await Promise.race([polices, new Promise((r) => setTimeout(r, 3000))])
      regie.relire(true)
    }
    const chargement = document.getElementById('chargement')
    regie.lever()
    if (chargement == null) return
    if (!peutAnimer() || !reglages.effets) { chargement.remove(); return }
    chargement.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, easing: 'ease-out', fill: 'forwards' })
      .finished.then(() => chargement.remove(), () => chargement.remove())
  }

  setInterval(() => {
    regie.tick()
    if (courant) barre.maj(courant)
    hud.maj(false)
  }, 1000)

  // The OBS source in or out of the program scene, told by the page's OBS script.
  addEventListener('on-air', (event) => {
    regie.antenne((event as CustomEvent<{ active?: boolean }>).detail?.active !== false)
  }, { signal })

  const cycle = [null, ...regie.nomsTransitions]
  addEventListener('keydown', (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
    const k = event.key.toLowerCase()
    if (k === 'f') {
      // Full screen, and back: whoever plugs the projector in needs the browser's
      // frame gone in one gesture.
      event.preventDefault()
      try {
        if (document.fullscreenElement) void document.exitFullscreen?.()
        else document.documentElement.requestFullscreen?.()?.catch(() => {})
      } catch { /* an engine without the full screen API: the page stays as it is */ }
    } else if (k === ' ') { event.preventDefault(); regie.basculerPause() }
    else if (k === 'arrowright') regie.suivante()
    else if (k === 'arrowleft') regie.precedente()
    else if (/^[0-9]$/.test(k)) { const n = k === '0' ? 10 : Number(k); if (n <= regie.prog.etapes.length) void regie.allerA(n - 1) }
    else if (k === 't') regie.transitionForcee = cycle[(cycle.indexOf(regie.transitionForcee) + 1) % cycle.length] ?? null
    else if (k === 'r') regie.relire()
    else if (k === 'h') { hud.basculer(); return }
    hud.maj(true)
  }, { signal })

  let minuterie: ReturnType<typeof setTimeout> | undefined
  addEventListener('mousemove', () => {
    document.body.classList.add('curseur')
    clearTimeout(minuterie)
    minuterie = setTimeout(() => document.body.classList.remove('curseur'), 2000)
  }, { signal })

  // Driving from the console, the tests and the preview: boucle.allerA(2, 'dip').
  window.boucle = {
    suivante: () => regie.suivante(),
    precedente: () => regie.precedente(),
    allerA: (numero: number, transition?: string) => regie.allerA(numero - 1, transition),
    pause: () => { if (!regie.enPause) regie.basculerPause() },
    lecture: () => { if (regie.enPause) regie.basculerPause() },
    relire: () => regie.relire(),
    /**
     * Fetches the state again at this address, every `ms` — the hub's public and
     * global screens, which have no stream of their own. A failed fetch keeps the
     * last state: the screen stays on what it knew.
     */
    suivre: (url: string, ms: number) => {
      setInterval(() => {
        fetch(url, { cache: 'no-store', credentials: 'same-origin' })
          .then((response) => (response.ok ? (response.json() as Promise<Data>) : null))
          .then((data) => { if (data != null) recevoir(data) })
          .catch(() => {})
      }, ms)
    },
    etat: () => ({
      mode: regie.mode,
      scene: regie.prog.etapes[regie.courante]?.scene ?? null,
      courante: regie.courante + 1,
      enPause: regie.enPause,
      scenes: regie.prog.etapes.map((e, i) => ({ scene: e.scene, jouable: regie.jouable(i) })),
    }),
  }
  if (params.get('hud') === '1') hud.basculer()

  /*
   * « Toucher pour le plein écran » — the preview on a phone or a tablet. A page
   * may only go full screen on a gesture, and only then lock itself sideways
   * (Android). Where the engine cannot do it at all — an iPhone — nothing is
   * offered: the stage already turns in portrait.
   */
  const pleinEcranPossible = typeof document.documentElement.requestFullscreen === 'function' && document.fullscreenEnabled
  if (apercu && tactile && pleinEcranPossible) {
    const invite = document.createElement('button')
    invite.type = 'button'
    invite.id = 'plein-ecran'
    invite.textContent = 'Toucher pour le plein écran'
    document.body.append(invite)
    const passer = () => {
      invite.remove()
      document.documentElement.requestFullscreen()
        .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
        .catch(() => {})
        .finally(ajuster)
    }
    addEventListener('pointerup', passer, { once: true, signal })
    // Out of the way once read: the whole screen still answers the tap.
    setTimeout(() => invite.classList.add('discret'), 6000)
  }

  const embarque = document.getElementById('etat-initial')
  if (embarque?.textContent) recevoir(JSON.parse(embarque.textContent) as Data)

  const patch = window.applyStreamPatch
  if (typeof EventSource !== 'undefined' && !window.__PREVIEW__ && patch) {
    const flux = new EventSource('/display/state?vue=projecteur&partiel=1')
    flux.onmessage = (event) => recevoir(JSON.parse(event.data as string) as Data)
    flux.addEventListener('patch', (event) => {
      if (courant) recevoir(patch(courant, JSON.parse((event as MessageEvent).data as string)))
    })
  }
}

demarrer()
