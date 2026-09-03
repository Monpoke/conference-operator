import { TAILWIND_CSS } from '@cloudnord/ui'

import { OBS_ON_AIR_CSS, OBS_ON_AIR_JS } from './obs-browser.js'

/**
 * The transparent overlay composited over the capture in OBS-B.
 *
 * **Everything here goes into the master.** This page is a source of OBS-B's
 * scene: it is burned into the recording and into the live stream. It therefore
 * carries only what has its place in a VOD — the talk's lower third and the
 * event's logo. A recording indicator once appeared here: useful to the operator,
 * but engraved into the delivered video. That marker lives in the control app, in
 * the "Captation" panel, where it costs nobody anything.
 *
 * Constraints: a genuinely transparent background (the Browser Source composites
 * over the camera and the slides), no expensive animation — the page runs while
 * OBS encodes — and a lower-third area placed outside the thirds usually taken up
 * by the slides.
 *
 * **All sizes are in `vh`/`vw`, including through Tailwind.** The overlay must
 * follow the OBS canvas's resolution: a control room in 720p and another in 1080p
 * render the same framing. `rem` units would freeze the lower third's size in
 * pixels and make it overflow or shrink depending on the machine.
 */
export interface OverlayPageOptions {
  initialPayload?: unknown
}

export function renderOverlayPage(options: OverlayPageOptions = {}): string {
  const initialState =
    options.initialPayload == null
      ? ''
      : `<script id="etat-initial" type="application/json">${JSON.stringify(options.initialPayload).replace(/</g, '\\u003c')}</script>`

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Habillage captation</title>
<style>${TAILWIND_CSS}  ${OBS_ON_AIR_CSS}
</style>
<style>
  :root { --color: #1c71d8; --category: #1c71d8; }
  /* A genuinely transparent background: OBS composites this page over the video. */
  html, body { height: 100%; background: transparent; overflow: hidden; }

  /* Nothing shows while no talk is running. */
  #lower-third { opacity: 0; transition: opacity .4s ease; }
  body[data-lower-third="visible"] #lower-third { opacity: 1; }

  /*
   * A question from the audience.
   *
   * It **does** have its place in the master, unlike the console's banner: a VOD
   * where the speaker answers a question one has never read is incomprehensible.
   * It rises from its edge, as the lower third appears from its own.
   */
  #question { opacity: 0; transform: translateY(1.5vh); transition: opacity .35s ease, transform .35s ease; }
  body[data-question="visible"] #question { opacity: 1; transform: none; }
</style>
</head>
<body class="font-sans text-white" data-lower-third="hidden" data-question="hidden">
${initialState}
<img id="logo" alt="" class="absolute right-[3vw] top-[5vh] h-[7vh] opacity-90" hidden>

<!--
  The corner opposite the lower third: both can be on screen at the same time —
  the speaker is titled while they answer — and they must not overlap.
-->
<div id="question" class="absolute right-[3vw] bottom-[8vh] flex max-w-[34vw] items-stretch drop-shadow-[0_.6vh_1.6vh_rgba(0,0,0,.55)]">
  <div class="w-[.9vh] rounded-l-[.45vh] bg-[var(--color)]"></div>
  <div class="rounded-r-[.6vh] bg-[rgba(12,14,22,.88)] px-[2.2vh] py-[1.4vh] backdrop-blur-[2px]">
    <div class="mb-[.6vh] text-[1.6vh] font-semibold tracking-[.12em] text-[var(--color)] uppercase">Question du public</div>
    <div class="text-[2.5vh] leading-[1.25] font-semibold" id="question-text"></div>
    <div class="mt-[.5vh] text-[1.9vh] text-white/70" id="question-author" hidden></div>
  </div>
</div>

<div id="lower-third" class="absolute bottom-[8vh] left-[4vw] flex max-w-[60vw] items-stretch drop-shadow-[0_.6vh_1.6vh_rgba(0,0,0,.55)]">
  <div class="w-[.9vh] rounded-l-[.45vh] bg-[var(--category)]"></div>
  <div class="rounded-r-[.6vh] bg-[rgba(12,14,22,.88)] px-[2.4vh] py-[1.6vh] backdrop-blur-[2px]">
    <div class="text-[3.4vh] leading-[1.15] font-bold" id="title"></div>
    <div class="mt-[.7vh] text-[2.4vh] text-white/80" id="people" hidden></div>
    <span class="mt-[1vh] inline-block rounded-[.4vh] bg-[var(--category)] px-[1.1vh] py-[.35vh] text-[1.7vh] tracking-[.12em] uppercase" id="category" hidden></span>
  </div>
</div>

<script>
(() => {
  const setText = (id, value) => { document.getElementById(id).textContent = value ?? '' }

  function render(data) {
    // The title follows the event: nothing is hard-compiled, the name comes from
    // the hub and stays in cache to survive a start with the network cut.
    const eventName = data.eventIdentity?.name
    if (eventName) document.title = eventName + ' — habillage captation'
    const session = data.state.currentSession
    const root = document.documentElement.style

    if (data.event?.theme?.color) root.setProperty('--color', data.event.theme.color)
    const logo = document.getElementById('logo')
    if (data.event?.logoUrl) { logo.src = data.event.logoUrl; logo.hidden = false }

    /**
     * A question on air.
     *
     * Rendered **before** the lower third and outside its condition: it does not
     * depend on a talk being titleable, and above all the lower third leaves
     * through an early return — placing it after would have left it frozen on the
     * previous question between two talks.
     *
     * Reads the question, and never the console's banner: what is here goes into
     * the master, and the console's operational instructions have no business in
     * a VOD.
     */
    const question = data.state.question
    document.body.dataset.question = question == null ? 'hidden' : 'visible'
    if (question != null) {
      setText('question-text', question.text)
      const author = document.getElementById('question-author')
      author.hidden = !question.author
      setText('question-author', question.author)
    }

    // No talk, or a slot with no speaker: nothing to title.
    const titleable = session != null && session.kind === 'talk'
    document.body.dataset.lowerThird = titleable ? 'visible' : 'hidden'
    if (!titleable) return

    root.setProperty('--category', session.category?.color ?? data.event?.theme?.color ?? '#1c71d8')
    setText('title', session.title)
    /**
     * The line hidden when nobody is announced.
     *
     * The case has existed since a slot can be declared a talk by hand: an opening
     * keynote whose speaker is not announced yet carries a title and no name. An
     * empty line under the title would keep its margin and would read, in the live
     * stream as in the VOD, as a name that failed to load.
     */
    const names = session.speakers.map((s) => s.company ? s.name + ' — ' + s.company : s.name).join(' · ')
    document.getElementById('people').hidden = names === ''
    setText('people', names)

    const category = document.getElementById('category')
    category.hidden = session.category == null
    if (session.category) category.textContent = session.category.name
  }

  // The stream only sends what changes: we keep the current state and merge.
  // A complete message (on opening, and after every reconnection) replaces it.
  let currentState = {}
  const embedded = document.getElementById('etat-initial')
  if (embedded) { currentState = JSON.parse(embedded.textContent); render(currentState) }

  if (typeof EventSource !== 'undefined' && !window.__APERCU__) {
    const stream = new EventSource('/display/state?vue=overlay')
    stream.onmessage = (event) => {
      currentState = JSON.parse(event.data); render(currentState)
    }
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
