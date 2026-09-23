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
  const ajuster = () => plateau.style.setProperty('--scale', String(Math.min(innerWidth / 1920, innerHeight / 1080) || 1))
  addEventListener('resize', ajuster, { signal })
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
    if (premier) lever()
  }

  /** The loading screen lifts once the first state is drawn. */
  function lever(): void {
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
    etat: () => ({
      mode: regie.mode,
      scene: regie.prog.etapes[regie.courante]?.scene ?? null,
      courante: regie.courante + 1,
      enPause: regie.enPause,
      scenes: regie.prog.etapes.map((e, i) => ({ scene: e.scene, jouable: regie.jouable(i) })),
    }),
  }
  if (params.get('hud') === '1') hud.basculer()

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
