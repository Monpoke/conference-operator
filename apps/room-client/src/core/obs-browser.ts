/**
 * What an OBS Browser Source makes available to the page, and what we do with it.
 *
 * OBS injects `window.obsstudio` into every Browser Source. That object exists
 * nowhere else: not in an ordinary browser, not in the Electron fallback window,
 * not in the offline previews. **Everything here must therefore be strictly
 * optional** — a page that depended on it would no longer display outside OBS.
 *
 * ## What the object exposes
 *
 * | Member | What it returns |
 * |---|---|
 * | `pluginVersion` | the browser plugin's version, e.g. `2.17.0` |
 * | `getCurrentScene(cb)` | `{ name, width, height }` of the program scene |
 * | `getStatus(cb)` | `{ recording, streaming, recordingPaused, replaybuffer, virtualcam }` |
 * | `getControlLevel(cb)` | 0 to 5 — what the page is allowed to do |
 * | `startRecording()` … | driving OBS, reserved for the high levels |
 *
 * ⚠️ **The query methods sit behind a setting.** In the source's properties, "Page
 * permissions" defaults to *None*: in that case `getCurrentScene` and `getStatus`
 * are absent or silent. The **events**, for their part, are broadcast
 * unconditionally — which is why everything that matters here goes through them,
 * and why the queries only serve to enrich a diagnosis.
 *
 * ## The events, broadcast on `window`
 *
 * - `obsSceneChanged` — `detail.name`: the program scene has changed
 * - `obsSourceActiveChanged` — `detail.active`: **is this source rendered in the
 *   program scene**. That is the strict sense of "on air": in Studio mode, a
 *   source in preview is not active.
 * - `obsSourceVisibleChanged` — `detail.visible`: the eye lit in the current
 *   scene. More permissive, and not what we want here.
 * - `obsStreamingStarted` / `obsRecordingStarted` / …: the output's state, with no
 *   bearing on whether *this* source is being seen.
 * - `obsExit`: OBS is closing.
 *
 * ## Two configuration traps that override all of this code
 *
 * 1. **"Shutdown source when not visible"** destroys the page when the scene
 *    changes: no script runs, there is nothing to pause, and on the way back the
 *    page starts from scratch (SSE reconnection included).
 * 2. **"Refresh browser when scene becomes active"** reloads the page on every
 *    return, with the same effect.
 *
 * Both settings must stay **unchecked** for pausing to mean anything — and in any
 * case so that the room screen does not flicker on every scene switch.
 */

/**
 * Freezing the animations off air.
 *
 * `animation-play-state: paused` freezes without destroying: on the way back, the
 * animation resumes where it was instead of jumping to its start. Transitions are
 * cut dead, for want of an equivalent.
 *
 * What is NOT frozen: the JavaScript timers. The clock, the page loop and the SSE
 * stream carry on, otherwise the page would come back on air showing the time
 * from ten minutes ago.
 */
export const OBS_ON_AIR_CSS = `
  body[data-on-air="no"] *,
  body[data-on-air="no"] *::before,
  body[data-on-air="no"] *::after {
    animation-play-state: paused !important;
    transition: none !important;
  }
`

/**
 * The script inlined into the pages served to OBS.
 *
 * Written as a string, like the rest of these pages: they have no build step and
 * cannot `import`.
 */
export const OBS_ON_AIR_JS = `
(() => {
  const obs = window.obsstudio
  const body = document.body

  /*
   * Outside OBS — a browser, an offline preview, the Electron fallback window —
   * we set nothing at all. The absence of the attribute means "on air", so the
   * page animates normally everywhere else.
   */
  body.dataset.obs = obs ? 'yes' : 'no'
  if (!obs) return

  if (obs.pluginVersion) body.dataset.obsVersion = obs.pluginVersion

  /**
   * The consolidated state, readable from OBS's console and from a test.
   *
   * Exposed on window and not kept in a closure: it is the only way to diagnose a
   * source from OBS's inspector, which has no convenient breakpoint in an inlined
   * page.
   */
  const state = window.__obs = {
    version: obs.pluginVersion ?? null,
    onAir: true,
    scene: null,
    output: null,
    since: Date.now(),
  }

  function set(active) {
    if (state.onAir === active) return
    state.onAir = active
    state.since = Date.now()
    body.dataset.onAir = active ? 'yes' : 'no'
    window.dispatchEvent(new CustomEvent('on-air', { detail: { active } }))
  }

  /*
   * We start on air, deliberately.
   *
   * OBS only emits obsSourceActiveChanged on a *change*: a source already active
   * at load time emits nothing. Starting from "off air" would therefore freeze a
   * screen that is being projected in front of the room, until the next scene
   * change. The direction of the error is chosen: at worst we animate for
   * nothing, never the opposite.
   */
  body.dataset.onAir = 'yes'

  window.addEventListener('obsSourceActiveChanged', (event) => {
    set(event.detail?.active !== false)
  })

  // The scene's name: for diagnosis only, nothing depends on it.
  window.addEventListener('obsSceneChanged', (event) => {
    state.scene = event.detail?.name ?? null
  })

  for (const [name, output] of [
    ['obsStreamingStarted', 'streaming'],
    ['obsRecordingStarted', 'recording'],
    ['obsStreamingStopped', null],
    ['obsRecordingStopped', null],
  ]) {
    window.addEventListener(name, () => { state.output = output })
  }

  /*
   * The queries, last and without counting on them.
   *
   * They depend on the source's "Page permissions" setting, which defaults to
   * None. Absent or silent, we simply keep the null values: nothing displayed
   * depends on them.
   */
  try {
    obs.getCurrentScene?.((scene) => { state.scene = scene?.name ?? null })
    obs.getStatus?.((status) => {
      state.output = status?.streaming ? 'streaming' : status?.recording ? 'recording' : null
    })
  } catch (cause) {
    console.warn('obsstudio : requêtes indisponibles', cause)
  }
})()
`
