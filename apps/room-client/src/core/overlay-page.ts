import { themeOrDefault, themeOverlayFill, themeTokens, type ThemeSource } from '@conference-operator/projector/server'
import { OBS_ON_AIR_CSS, OBS_ON_AIR_JS } from './obs-browser.js'
import { STREAM_PATCH_JS } from './stream-patch.js'

/**
 * The capture overlay, a Browser Source in OBS-B's scene.
 *
 * Everything drawn here ends up in the recording and the live stream, so it only
 * shows what belongs in a VOD: the event frame, the talk card and the audience
 * question. The recording indicator lives in the control app instead.
 *
 * The decor is a 1920×1080 canvas with two transparent holes: the slides
 * (`SCREEN`, 16:9) and the webcam (`CAM`, 1:1). The OBS scene must place those
 * two sources at the same rectangles, in canvas pixels. The canvas is scaled to
 * the source size, so 720p and 1080p give the same framing.
 *
 * The page runs while OBS encodes: animations stay cheap, and nothing is loaded
 * from the Internet (local fonts, logo from the room's cache).
 */
export interface OverlayPageOptions {
  initialPayload?: unknown
  /** The event's colours, and possibly its own frame. `null`: the default theme. */
  theme?: ThemeSource | null
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
<style>${OBS_ON_AIR_CSS}
</style>
<style>
${themeTokens(themeOrDefault(options.theme).bundle)}
</style>
<style>
  :root {
    /* The theme's overlay tokens (--overlay-*), under the names this page uses. */
    --c1: var(--overlay-1);
    --c2: var(--overlay-2);
    --muted: var(--overlay-discret);
  }
  /* Any rule setting \`display\` would otherwise beat the \`hidden\` attribute. */
  [hidden] { display: none !important; }
  .row { display: flex; }
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
  /* Local fonts only: the room machine may be offline. */
  body { font-family: "Roboto", "Open Sans", "Helvetica Neue", Arial, sans-serif; color: #fff; }

  /* The 1920×1080 canvas, scaled to the OBS source size. */
  #stage { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; transform-origin: 0 0; }
  #stage > * { position: absolute; }
  #bg { inset: 0; }

  #header { left: 0; top: 0; width: 1920px; height: 150px; display: flex; flex-direction: column;
            align-items: center; justify-content: center; gap: 8px; }
  /* Conference name, with the program's logo beside it when there is one. */
  #brand { display: flex; align-items: center; gap: 18px; height: 64px; }
  #logo { height: 64px; width: auto; display: block; }
  #event-name { font-size: 52px; font-weight: 900; letter-spacing: .5px; line-height: 1; white-space: nowrap;
                background: linear-gradient(90deg, #fff 40%, var(--overlay-titre)); -webkit-background-clip: text;
                background-clip: text; color: transparent; }
  #date { font-size: 22px; font-weight: 700; letter-spacing: .5px; color: var(--overlay-date); }
  #date:empty { display: none; }

  /* Talk card under the webcam, hidden outside talks. */
  #card { box-sizing: border-box; padding: 28px 30px; display: flex; flex-direction: column;
          border-radius: 22px; background: rgba(var(--overlay-carte-rgb), .72); border: 2px solid rgba(var(--overlay-2-rgb), .55);
          box-shadow: 0 0 30px rgba(var(--overlay-2-rgb), .25) inset; overflow: hidden;
          opacity: 0; transition: opacity .4s ease; }
  body[data-card="visible"] #card { opacity: 1; }
  /* Category on the label row, to leave the height to the title. */
  #card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 26px; }
  .label { font-size: 18px; font-weight: 700; letter-spacing: 3px; text-transform: uppercase;
           background: linear-gradient(90deg, var(--c1), var(--c2)); -webkit-background-clip: text;
           background-clip: text; color: transparent; }
  #people { display: flex; flex-direction: column; gap: 12px; margin-top: 10px; }
  /* \`--fit\` scales the card texts down when they overflow, see \`fitCard()\`. */
  .speaker-name { font-size: calc(36px * var(--fit, 1)); font-weight: 900; line-height: 1.1; }
  .speaker-company { font-size: calc(22px * var(--fit, 1)); color: var(--muted); margin-top: 6px; line-height: 1.3; }
  /* Smaller names when there are several speakers. */
  #people[data-count="many"] .speaker-name { font-size: calc(28px * var(--fit, 1)); }
  #people[data-count="many"] .speaker-company { font-size: calc(19px * var(--fit, 1)); margin-top: 2px; }
  #sep { height: 3px; width: 80px; flex: none; border-radius: 2px; margin: 18px 0;
         background: linear-gradient(90deg, var(--c1), var(--c2)); }
  /* Clamp only applies once \`--fit\` is at its minimum. */
  #title { font-size: calc(28px * var(--fit, 1)); font-weight: 700; line-height: 1.25;
           display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; flex: none; }
  #category { flex: none; padding: 3px 9px; border-radius: 6px;
              font-size: 14px; letter-spacing: 2px; text-transform: uppercase; background: var(--category, var(--c2)); }
  #room-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #room { margin-top: auto; padding-top: 14px; font-size: 20px; font-weight: 500; color: var(--muted);
          display: flex; align-items: center; gap: 10px; }

  /*
   * Audience question, at the bottom of the slides. It belongs in the VOD so the
   * answer makes sense, and it can show alongside the talk card.
   */
  #question { align-items: stretch; filter: drop-shadow(0 6px 16px rgba(0, 0, 0, .55));
              opacity: 0; transform: translateY(16px); transition: opacity .35s ease, transform .35s ease; }
  body[data-question="visible"] #question { opacity: 1; transform: none; }
  #question .bar { width: 10px; border-radius: 5px 0 0 5px; background: linear-gradient(180deg, var(--c1), var(--c2)); }
  #question .body { border-radius: 0 8px 8px 0; background: rgba(var(--overlay-carte-rgb), .9); padding: 16px 24px; }
  #question .label { margin-bottom: 6px; }
  #question-text { font-size: 28px; font-weight: 700; line-height: 1.25; }
  #question-author { margin-top: 6px; font-size: 21px; color: var(--muted); }

  #footer { left: 40px; width: 1840px; top: 1000px; height: 50px; align-items: center;
            justify-content: center; gap: 28px; font-size: 22px; font-weight: 500; color: var(--overlay-pied); }
  #footer .network { color: var(--muted); font-weight: 400; margin-right: 8px; }
  #footer .dot-sep { color: var(--muted); }
  /* The website's address: one plain colour, the theme's (white by default) — a
     gradient across the letters read badly once the VOD is compressed. */
  #footer b { font-weight: 900; color: var(--overlay-site); }
</style>
</head>
<body data-card="hidden" data-question="hidden" data-theme="${options.theme?.sha ?? ''}">
${initialState}
<div id="stage">
<svg id="bg" width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="gAccent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" style="stop-color: var(--overlay-1)"/>
      <stop offset="1" style="stop-color: var(--overlay-2)"/>
    </linearGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="3"/></filter>
    <clipPath id="holes"><path id="holesPath" clip-rule="evenodd" d=""/></clipPath>
  </defs>

  <!-- Decor clipped so the slides and webcam areas stay transparent: the theme's, or the default frame. -->
  <g clip-path="url(#holes)">
    ${themeOverlayFill(options.theme)}
  </g>

  <!-- Glowing frames around the holes. -->
  <g id="frames" fill="none"></g>
</svg>

<div id="header">
  <div id="brand">
    <img id="logo" alt="" hidden>
    <div id="event-name"></div>
  </div>
  <div id="date"></div>
</div>

<div id="card">
  <div id="card-head">
    <div class="label" id="card-label">Speaker</div>
    <span id="category" hidden></span>
  </div>
  <div id="people"></div>
  <div id="sep"></div>
  <div id="title"></div>
  <div id="room" hidden><span id="room-name"></span></div>
</div>

<div id="question" class="row">
  <div class="bar"></div>
  <div class="body">
    <div class="label">Question du public</div>
    <div id="question-text"></div>
    <div id="question-author" hidden></div>
  </div>
</div>

<!-- Conference website and LinkedIn. -->
<div id="footer" class="row">
</div>
</div>

<script>
(() => {
  // Geometry in canvas pixels. The OBS scene uses the same rectangles.
  const SCREEN = { x: 40, y: 165, w: 1440, h: 810, r: 16 }    // slides, 16:9
  const CAM = { x: 1510, y: 165, w: 370, h: 370, r: 22 }      // webcam, 1:1
  const CARD = { x: 1510, y: 560, w: 370, h: 415 }

  const place = (id, box) => Object.assign(document.getElementById(id).style,
    { left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' })

  // A rounded rectangle as an SVG path.
  function rr(b) {
    const { x, y, w, h, r } = b
    return 'M' + (x + r) + ',' + y + 'H' + (x + w - r) + 'A' + r + ',' + r + ' 0 0 1 ' + (x + w) + ',' + (y + r) +
      'V' + (y + h - r) + 'A' + r + ',' + r + ' 0 0 1 ' + (x + w - r) + ',' + (y + h) +
      'H' + (x + r) + 'A' + r + ',' + r + ' 0 0 1 ' + x + ',' + (y + h - r) +
      'V' + (y + r) + 'A' + r + ',' + r + ' 0 0 1 ' + (x + r) + ',' + y + 'Z'
  }
  document.getElementById('holesPath').setAttribute('d', 'M0,0H1920V1080H0Z' + rr(SCREEN) + rr(CAM))

  const frames = document.getElementById('frames')
  function frame(b, pad, width, opacity, blurred) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    p.setAttribute('d', rr({ x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad, r: b.r + pad }))
    p.setAttribute('stroke', 'url(#gAccent)')
    p.setAttribute('stroke-width', width)
    p.setAttribute('opacity', opacity)
    if (blurred) p.setAttribute('filter', 'url(#blur)')
    frames.appendChild(p)
  }
  for (const b of [SCREEN, CAM]) {
    frame(b, 6, 8, .55, true)   // halo
    frame(b, 3, 4, 1, false)    // sharp line
  }
  place('card', CARD)
  // The question sits inside the slides hole, at the bottom.
  Object.assign(document.getElementById('question').style,
    { left: (SCREEN.x + 24) + 'px', bottom: (1080 - SCREEN.y - SCREEN.h + 24) + 'px', maxWidth: '1100px' })

  // Scale the canvas to the source size.
  const stage = document.getElementById('stage')
  function fit() {
    const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080) || 1
    stage.style.transform = 'scale(' + scale + ')'
  }
  fit()
  window.addEventListener('resize', fit)

  const setText = (id, value) => { document.getElementById(id).textContent = value ?? '' }

  // The talk's day (the event's first day between talks), then the venue.
  function dateLine(data, session) {
    const at = session?.startsAt ?? data.event?.startsAt
    let day = ''
    if (at) {
      try {
        day = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: data.timezone })
          .format(new Date(at))
      } catch { day = '' }
    }
    return [day, data.event?.locationName].filter(Boolean).join(' • ')
  }

  function render(data) {
    const eventName = data.eventIdentity?.name ?? ''
    if (eventName) document.title = eventName + ' • habillage captation'
    // The talk the room started and has not ended, not the scheduled slot: an
    // overrunning talk keeps its speaker until End. With nothing on air, the talk
    // Start will launch: the recording often begins with the talk, and its first
    // frame must already carry the names rather than wait for a fade-in.
    const session = data.state.onAirSession ?? data.state.targetSession

    const logo = document.getElementById('logo')
    // The console's logo first, as on the loop: the capture wears the same one.
    const logoUrl = data.boucle?.logoUrl ?? data.event?.logoUrl
    if (logoUrl) { if (logo.getAttribute('src') !== logoUrl) logo.src = logoUrl; logo.hidden = false } else logo.hidden = true
    setText('event-name', eventName)
    // A logo that already spells the name (set in the console) stands alone.
    const nameInLogo = !logo.hidden && data.boucle?.logoAvecNom === true
    document.getElementById('event-name').hidden = eventName === '' || nameInLogo
    setText('date', dateLine(data, session))

    // Footer: website and LinkedIn, picked from the hub's social accounts. The
    // website is the entry named "Site" (or "Site web", "Website"...).
    const footer = document.getElementById('footer')
    const items = []
    const links = data.socialLinks ?? []
    const site = links.find((link) => /^\\s*(site( web| internet)?|web ?site|web|internet)\\s*$/i.test(link.network))
    const linkedIn = links.find((link) => /linkedin/i.test(link.network))
    if (site) {
      const item = document.createElement('b')
      item.className = 'social site'
      item.textContent = site.handle
      items.push(item)
    }
    if (linkedIn) {
      const item = document.createElement('div')
      item.className = 'social'
      const network = document.createElement('span')
      network.className = 'network'
      network.textContent = linkedIn.network
      item.append(network, linkedIn.handle)
      items.push(item)
    }
    footer.replaceChildren(...items.flatMap((item, index) => {
      if (index === 0) return [item]
      const dot = document.createElement('span')
      dot.className = 'dot-sep'
      dot.textContent = '•'
      return [dot, item]
    }))

    // Question on air. Rendered before the card's early return so it still
    // updates between talks. The console banner is never shown here.
    const question = data.state.question
    document.body.dataset.question = question == null ? 'hidden' : 'visible'
    if (question != null) {
      setText('question-text', question.text)
      const author = document.getElementById('question-author')
      author.hidden = !question.author
      setText('question-author', question.author)
    }

    const roomName = data.roomName ?? ''
    setText('room-name', roomName)
    document.getElementById('room').hidden = roomName === ''

    // No talk on air: no card.
    const titleable = session != null && session.kind === 'talk'
    document.body.dataset.card = titleable ? 'visible' : 'hidden'
    if (!titleable) return

    setText('title', session.title)
    // A talk can have no announced speaker yet: hide the block rather than leave
    // an empty gap.
    const people = document.getElementById('people')
    const speakers = session.speakers ?? []
    people.replaceChildren(...speakers.map((speaker) => {
      const block = document.createElement('div')
      const name = document.createElement('div')
      name.className = 'speaker-name'
      name.textContent = speaker.name
      block.appendChild(name)
      if (speaker.company) {
        const company = document.createElement('div')
        company.className = 'speaker-company'
        company.textContent = speaker.company
        block.appendChild(company)
      }
      return block
    }))
    people.dataset.count = speakers.length > 1 ? 'many' : 'one'
    people.hidden = speakers.length === 0
    const label = document.getElementById('card-label')
    label.hidden = speakers.length === 0
    label.textContent = speakers.length > 1 ? 'Speakers' : 'Speaker'

    const category = document.getElementById('category')
    category.hidden = session.category == null
    if (session.category) {
      category.textContent = session.category.name
      category.style.setProperty('--category', session.category.color ?? '')
    }
    fitCard()
  }

  // Scale the card texts down in 5% steps, to 60% at most, until the card
  // (room line included) fits. Starts again from 100% on every render.
  function fitCard() {
    const card = document.getElementById('card')
    let fit = 1
    card.style.setProperty('--fit', '1')
    while (fit > 0.6 && card.scrollHeight > card.clientHeight + 1) {
      fit = Math.round((fit - 0.05) * 100) / 100
      card.style.setProperty('--fit', String(fit))
    }
  }
  // Fonts may load after the first render.
  document.fonts?.ready?.then(() => fitCard())

  // The stream sends a full state on connect, then patches.
  let currentState = {}
  const embedded = document.getElementById('etat-initial')
  if (embedded) { currentState = JSON.parse(embedded.textContent); render(currentState) }

${STREAM_PATCH_JS}
  // Another theme: its colours and frame are baked into the page — it reloads to wear them.
  const otherTheme = (state) => state.boucle != null && (state.boucle.theme ?? '') !== (document.body.dataset.theme ?? '')
  if (typeof EventSource !== 'undefined' && !window.__PREVIEW__) {
    const stream = new EventSource('/display/state?vue=overlay&partiel=1')
    stream.onmessage = (event) => {
      currentState = JSON.parse(event.data)
      if (otherTheme(currentState)) return location.reload()
      render(currentState)
    }
    stream.addEventListener("patch", (event) => {
      currentState = applyStreamPatch(currentState, JSON.parse(event.data))
      if (otherTheme(currentState)) return location.reload()
      render(currentState)
    })
  }
})()
</script>
<script>${OBS_ON_AIR_JS}</script>
</body>
</html>`
}
