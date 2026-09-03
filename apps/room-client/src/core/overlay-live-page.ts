import { TAILWIND_CSS } from '@cloudnord/ui'

import { OBS_ON_AIR_CSS, OBS_ON_AIR_JS } from './obs-browser.js'

/**
 * The banner composited over the live scenes.
 *
 * A second transparent surface, distinct from the capture overlay, and for a
 * fundamental reason: this one says nothing about the talk, it carries what the
 * console decides to put on air — "we resume in 5 minutes", "the sound is being
 * fixed". It is therefore placed wherever a message should appear, including in
 * OBS-A's `LIVE` scene, where the speaker's slides keep running underneath.
 *
 * It interrupts nothing: that is the whole difference with the room screen's
 * "message" mode, which takes the whole screen. Here the talk carries on.
 *
 * As for the overlay: a genuinely transparent background, sizes in `vh`/`vw` to
 * follow the OBS canvas, and no expensive animation — the page runs while OBS
 * encodes.
 *
 * The `?style=` parameter and its values (`bandeau`, `encart`) are typed into the
 * OBS source's address: they are a contract with the machines, and do not get
 * renamed.
 */
export interface OverlayLivePageOptions {
  initialPayload?: unknown
}

export function renderOverlayLivePage(options: OverlayLivePageOptions = {}): string {
  const initialState =
    options.initialPayload == null
      ? ''
      : `<script id="etat-initial" type="application/json">${JSON.stringify(options.initialPayload).replace(/</g, '\\u003c')}</script>`

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Bandeau live</title>
<style>${TAILWIND_CSS}  ${OBS_ON_AIR_CSS}
</style>
<style>
  /* A genuinely transparent background: OBS composites this page over the video. */
  html, body { height: 100%; background: transparent; overflow: hidden; }

  /*
   * Two presentations, chosen in the OBS source's address.
   *
   * ?style=encart places a card at the bottom right, made to sit over slides
   * without eating their content; with no parameter, a banner at the top, more
   * discreet on a camera shot. The choice belongs to the scene — the same page
   * serves both, and nothing changes at runtime.
   */
  #place { position: absolute; }
  body[data-style="bandeau"] #place { top: 6vh; left: 50%; transform: translateX(-50%); max-width: 80vw; }
  body[data-style="encart"] #place { right: 4vw; bottom: 9vh; max-width: 42vw; }
  body[data-style="bandeau"] #label { display: none; }

  /*
   * Nothing on screen while there is nothing to say.
   *
   * The appearance goes through an opacity and position transition: a blunt
   * arrival in the middle of a shot shows up as a compositing defect. The banner
   * comes down, the card comes up — each arrives from the edge it is close to.
   */
  #frame { opacity: 0; transition: opacity .3s ease, transform .3s ease; }
  body[data-style="bandeau"] #frame { transform: translateY(-1.5vh); }
  body[data-style="encart"] #frame { transform: translateY(1.5vh); }
  body[data-banner="visible"] #frame { opacity: 1; transform: none; }

  /* A tint per level, set from the script on the body. */
  body[data-level="info"] #frame { --tint: var(--color-brand); }
  body[data-level="warning"] #frame { --tint: var(--color-warn); }
  body[data-level="urgent"] #frame { --tint: var(--color-alert); }
</style>
</head>
<body class="font-sans text-white" data-banner="hidden" data-level="info" data-style="bandeau">
${initialState}
<div id="place">
  <div id="frame" class="flex items-stretch drop-shadow-[0_.6vh_1.6vh_rgba(0,0,0,.55)]">
    <div class="w-[.9vh] rounded-l-[.45vh] bg-[var(--tint)]"></div>
    <div class="rounded-r-[.6vh] bg-[rgba(12,14,22,.88)] px-[2.6vh] py-[1.6vh] backdrop-blur-[2px]">
      <div class="mb-[.6vh] text-[1.7vh] font-semibold tracking-[.12em] text-[var(--tint)] uppercase" id="label">Question du public</div>
      <div class="text-[2.8vh] leading-[1.25] font-semibold" id="text"></div>
    </div>
  </div>
</div>

<script>
(() => {
  /**
   * The presentation, chosen in the OBS source's address.
   *
   * ?style=encart for a card over slides, nothing for the banner. A parameter
   * rather than a setting: it is a scene decision, taken once when setting the
   * source up, not a control-room gesture in the middle of a talk.
   */
  const STYLE = new URLSearchParams(location.search).get('style') === 'encart' ? 'encart' : 'bandeau'
  document.body.dataset.style = STYLE

  /** The transition's duration, aligned on the CSS above. */
  const TRANSITION_MS = 300
  let shown = null
  let switchTimer = null

  /**
   * Changes question **in two steps**.
   *
   * Replacing the text in place would give a jump: two questions of different
   * lengths substitute at once, and the viewer does not know whether it changed
   * or was always there. We take the old one out, put the new one in, and bring
   * it in.
   */
  function render(data) {
    // The title follows the event: nothing is hard-compiled, the name comes from
    // the hub and stays in cache to survive a start with the network cut.
    const eventName = data.eventIdentity?.name
    if (eventName) document.title = eventName + ' — bandeau live'
    /**
     * Two channels, a single place on screen.
     *
     * The console's banner comes before the question: when there is one, it means
     * something is happening — "we resume in 5 minutes" — and that takes
     * precedence over the question the speaker was answering. The question comes
     * back by itself as soon as the banner is removed.
     *
     * This page is placed in OBS-A's scenes: it is seen by the room, not by the
     * VOD. That is why it is allowed to show both, where the capture overlay only
     * shows the question.
     */
    const message = data.state.liveMessage
    const question = data.state.question
    const banner = message != null
      ? { text: message.text, level: message.level, label: null }
      : question != null
        ? {
            text: question.text,
            level: 'info',
            label: question.author ? 'Question — ' + question.author : 'Question du public',
          }
        : null

    const next = banner == null ? null : banner.level + ' | ' + banner.label + ' | ' + banner.text
    // Nothing new: above all, do not replay the animation on every received state.
    if (next === shown) return

    const first = shown == null
    shown = next
    clearTimeout(switchTimer)

    if (banner == null) {
      document.body.dataset.banner = 'hidden'
      return
    }

    const show = () => {
      document.body.dataset.level = banner.level
      // The label announces a question; an operational message does without a
      // heading, it reads as it is.
      const label = document.getElementById('label')
      label.textContent = banner.label ?? ''
      label.hidden = banner.label == null
      document.getElementById('text').textContent = banner.text
      document.body.dataset.banner = 'visible'
    }

    // Nothing on screen: we come straight in, with no empty exit.
    if (first) { show(); return }
    document.body.dataset.banner = 'hidden'
    switchTimer = setTimeout(show, TRANSITION_MS)
  }

  // The stream only sends what changes: we keep the current state and merge.
  // A complete message (on opening, and after every reconnection) replaces it.
  let currentState = {}
  const embedded = document.getElementById('etat-initial')
  if (embedded) { currentState = JSON.parse(embedded.textContent); render(currentState) }

  if (typeof EventSource !== 'undefined' && !window.__PREVIEW__) {
    const stream = new EventSource('/display/state?vue=bandeau')
    stream.onmessage = (event) => { currentState = JSON.parse(event.data); render(currentState) }
    stream.addEventListener("delta", (event) => {
      currentState = Object.assign({}, currentState, JSON.parse(event.data))
      render(currentState)
    })
  }
})()
</script>
<script>${OBS_ON_AIR_JS}</script>
</body>
</html>`
}
