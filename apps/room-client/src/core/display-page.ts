import { MACHINE_JS } from '@conference-operator/room-state'
import { TAILWIND_CSS } from '@conference-operator/ui'

import { OBS_ON_AIR_CSS, OBS_ON_AIR_JS } from './obs-browser.js'

/**
 * The page projected in the room.
 *
 * The constraints that explain its shape: it is rendered by OBS-A's Browser
 * Source (or an Electron fallback window), must hold with no build step, no
 * network, and stay readable from ten metres away. Hence standalone HTML, an
 * `EventSource` that reconnects by itself, and no external dependency.
 *
 * **One exception, and only one**: X's button on the Social slide, whose script
 * is served by X. It is loaded `async`, last, and nothing depends on it — the
 * slide carries the hashtag in large type, which stays readable when the script
 * does not load. The "no network" rule is therefore not lifted: it still covers
 * everything that is read.
 *
 * **Everything is sized in `vmin`**, including through Tailwind. The screen goes
 * from a 1024×768 video projector to a 4K one depending on the room: sizes in
 * `rem` would give tiny text on one and overflowing text on the other.
 */
export interface ProjectorPageOptions {
  /**
   * The state embedded in the page, rendered before any connection.
   *
   * Avoids the blank screen between the load and the first SSE message — visible
   * in the room on every reload of the Browser Source. Also serves to produce an
   * offline preview strictly identical to the real page.
   */
  initialPayload?: unknown
}

export function renderProjectorPage(options: ProjectorPageOptions = {}): string {
  const initialState =
    options.initialPayload == null
      ? ''
      : `<script id="etat-initial" type="application/json">${JSON.stringify(options.initialPayload).replace(/</g, '\\u003c')}</script>`

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Écran de salle</title>
<style>${TAILWIND_CSS}</style>
<style>
  :root { --color: #5b7cfa; --secondary: #22d3ee; --gold: #d4a24c; }
  html, body { height: 100%; }

  /* Cursor hidden: the page lives on a video projector, not on a desktop. */
  body { overflow: hidden; cursor: none; }

  /*
   * Brand halos, derived from the event's colours.
   *
   * Outside Tailwind: two radial gradients composed with color-mix, which the
   * utilities do not express, and which must follow --color live.
   *
   * On their own layer, behind the stage, because they drift: a layer carrying
   * only a gradient moves on the GPU without relaying out anything written over
   * it. The opaque background stays on the body, the only place where the screen
   * is guaranteed painted.
   */
  #halo {
    background:
      radial-gradient(120vmax 90vmax at 12% -10%, color-mix(in srgb, var(--color) 38%, transparent), transparent 60%),
      radial-gradient(90vmax 70vmax at 110% 110%, color-mix(in srgb, var(--secondary) 32%, transparent), transparent 60%);
    animation: drift 44s ease-in-out infinite;
    will-change: transform;
  }

  /*
   * The background's drift.
   *
   * Forty-four seconds for a round trip: at that speed the movement goes
   * unnoticed, but the screen stops being a still image. A break lasts twenty
   * minutes, and a video projector that does not move at all ends up reading as a
   * machine switched off on an image.
   */
  @keyframes drift {
    0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
    50% { transform: translate3d(2.5vmin, -2vmin, 0) scale(1.07); }
  }

  /*
   * The top tier, in gold.
   *
   * A colour that does not come from the event's theme, and that is intended: the
   * brand dresses the screen, the gold says the rank. The two were not saying the
   * same thing and blurred together when the band took --color back — the tier
   * that paid the most then read as one more framed box.
   *
   * It dresses the **first** tier, not the one called "Gold". The name can change
   * from one edition to the next, the rank cannot.
   */
  .top-tier {
    border-color: color-mix(in srgb, var(--gold) 62%, transparent);
    border-width: .28vmin;
    background: linear-gradient(160deg,
      color-mix(in srgb, var(--gold) 30%, transparent),
      color-mix(in srgb, var(--gold) 10%, transparent) 70%);
    /* A lit top edge, and a halo that lifts the band off the background. */
    box-shadow:
      inset 0 .2vmin 0 color-mix(in srgb, var(--gold) 75%, transparent),
      0 0 4vmin color-mix(in srgb, var(--gold) 12%, transparent);
  }
  .top-tier .tier-name {
    color: color-mix(in srgb, var(--gold) 92%, #fff);
    text-shadow: 0 0 1.4vmin color-mix(in srgb, var(--gold) 45%, transparent);
  }

  /*
   * Stacked layers: the next page pushes the previous one.
   *
   * The leaving one goes off to the left while the entering one arrives from the
   * right, at the same speed and on the same curve. At every instant they are
   * exactly adjacent: nothing overlaps, ever. Both occupy the same cell, hence
   * the absolute positioning, and the frame clips them.
   *
   * It replaces the crossfade that was there before, which let both slides be
   * read at the same time: its two curves rose in the same direction at the worst
   * moment — a steep ease-out entrance (67 % in a fifth of its duration) while
   * the ease-in exit still lingered at 87 %. At the peak, both pages were more
   * than 80 % visible each. Measured at 0.838 by computation, 0.836 observed.
   *
   * The same duration AND the same curve for both: a gap opens a void between the
   * layers, or makes them overlap.
   *
   * Only transform is animated, the property the compositor handles without going
   * back through layout — and a translation costs it less than recompositing two
   * translucent layers. That is what holds inside a 4K OBS Browser Source.
   */
  .layer { animation: enter .55s cubic-bezier(.4, 0, .2, 1) both; }
  .layer.leaving { animation: leave .55s cubic-bezier(.4, 0, .2, 1) both; pointer-events: none; }
  @keyframes enter {
    from { transform: translateX(100%); }
    to { transform: none; }
  }
  @keyframes leave {
    from { transform: none; }
    to { transform: translateX(-100%); }
  }

  /*
   * A cascading entrance.
   *
   * A list appearing all at once reads as a refresh; the same list whose rows
   * arrive one after another reads as something being shown to you. The step is
   * set per parent element: twenty-seven program slots need a shorter step than
   * four cards.
   *
   * The offset is lateral, and not vertical as it was: the whole page now arrives
   * from the right, and rows rising while their frame slides would make two
   * gestures instead of one. They therefore trail behind the push and settle
   * after it.
   */
  .cascade > * {
    animation: settle .5s cubic-bezier(.22, 1, .36, 1) both;
    animation-delay: calc(var(--step, 55ms) * var(--i, 0));
  }
  @keyframes settle {
    from { opacity: 0; transform: translateX(3vmin); }
    to { opacity: 1; transform: none; }
  }

  /*
   * Cards: they settle instead of sliding.
   *
   * A framed card arriving by sliding reads as a list row; the same one with a
   * hint of scale reads as an object being set down.
   *
   * Reserved for card lists, and that is the whole point of a modifier applied by
   * hand: on twenty-seven program rows, twenty-seven scale changes would make
   * noise, not an effect.
   */
  .cascade.cards > * {
    animation-name: settle-card;
  }
  @keyframes settle-card {
    from { opacity: 0; transform: translateX(2vmin) scale(.965); }
    to { opacity: 1; transform: none; }
  }

  /*
   * The running slot settles last, and from a little further away.
   *
   * Nothing blinking or repetitive: it comes from the same direction as its
   * neighbours, a little more slowly and from a little further. The eye follows
   * the last movement, and the last movement is the one that says where we are in
   * the day. The permanent highlight — tinted background, accent bar — stays what
   * it was; this only plays when the page arrives.
   */
  .cascade > .running {
    animation-name: settle-running;
    animation-duration: .72s;
  }
  @keyframes settle-running {
    from { opacity: 0; transform: translateX(6vmin); }
    to { opacity: 1; transform: none; }
  }

  /*
   * Scrolling the program.
   *
   * The day is two to three times the screen's height. Rather than jumping to the
   * running slot and stopping there, the list starts from it and slides towards
   * what follows while the page is displayed. The two plateaus leave time to read
   * before and after the movement.
   *
   * As a translation, not as scrollTop: native scrolling goes back through layout
   * on every frame, the translation does not.
   */
  .scroller { overflow: hidden; }
  .scrolling {
    animation-name: scroll;
    animation-timing-function: cubic-bezier(.4, 0, .2, 1);
    animation-fill-mode: both;
  }
  @keyframes scroll {
    0%, 14% { transform: translateY(var(--from)); }
    86%, 100% { transform: translateY(var(--to)); }
  }

  /*
   * The progress marker.
   *
   * The active dot fills over the page's duration: it is the only thing on screen
   * that says *when* it is going to change. The negative offset picks the gauge
   * up where it is, so that a state received mid-page does not restart it from
   * zero.
   */
  .dot {
    display: block;
    height: .7vmin;
    width: .7vmin;
    border-radius: 999px;
    background: rgb(255 255 255 / .25);
    transition: width .45s cubic-bezier(.22, 1, .36, 1);
  }
  .dot.active {
    position: relative;
    width: 4vmin;
    overflow: hidden;
    background: rgb(255 255 255 / .18);
  }
  .dot.active::after {
    content: '';
    position: absolute;
    inset: 0;
    background: var(--color);
    transform-origin: left;
    animation: fill var(--duration, 12000ms) linear both;
    animation-delay: calc(-1 * var(--elapsed, 0ms));
  }
  @keyframes fill {
    from { transform: scaleX(0); }
    to { transform: scaleX(1); }
  }

  /* The countdown's beat, restarted every second. */
  .beat { animation: beat .5s ease-out; }
  @keyframes beat {
    from { transform: scale(1.035); }
    to { transform: scale(1); }
  }

  /* Network state: discreet, informative, never alarming to the audience. */
  .status-label { display: none; }
  body[data-connectivity="OFFLINE"] .status-offline { display: inline; }
  body[data-connectivity="DEGRADED"] .status-degraded { display: inline; }

  /*
   * On live, the screen fades away: it is the HDMI capture that takes the stage.
   *
   * As a fade, and not at once: the switch happens in front of the room, and an
   * instant disappearance reads as a signal loss.
   */
  header, footer, main { transition: opacity .45s ease; }
  body[data-mode="live"] { background: #000; }
  body[data-mode="live"] #halo { opacity: 0; }
  body[data-mode="live"] header,
  body[data-mode="live"] footer,
  body[data-mode="live"] main { opacity: 0; }

  /*
   * A machine set to reduced motion: we keep the states, not the journeys. This
   * does not concern the video projector, but the machines these pages get
   * reviewed from.
   */
  ${OBS_ON_AIR_CSS}

  @media (prefers-reduced-motion: reduce) {
    *, *::after {
      animation-duration: .01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: .01ms !important;
    }
  }
</style>
</head>
<body class="bg-canvas font-sans text-text" data-mode="sponsors" data-connectivity="OFFLINE">
${initialState}
<div id="halo" class="pointer-events-none absolute inset-0"></div>
<div id="scene" class="absolute inset-0 flex flex-col gap-[3vmin] p-[4.5vmin]">
  <header class="flex flex-none items-center justify-between gap-[2vmin]">
    <img id="logo" alt="" data-logo class="h-[7vmin] max-w-[30vw] object-contain" hidden>
    <div class="flex items-center gap-[1.6vmin]">
      <!--
        The shared slot, announced on the room's screen.

        The styling switches to the waiting loop during a break, which does not
        say *why*: an attendee who came in halfway does not know whether they
        missed the talk or everyone is at lunch. The badge says it, and announces
        it a quarter of an hour ahead, while the talk is still finishing.
      -->
      <span class="rounded-[.6vmin] bg-white/10 px-[1.4vmin] py-[.5vmin] text-[2vmin] tracking-[.14em] uppercase"
            id="break-badge" hidden></span>
      <div class="text-[2.6vmin] tracking-[.16em] text-dim uppercase" id="room-name"></div>
    </div>
  </header>

  <!--
    A stack of layers: the leaving page stays there long enough to leave the frame.

    overflow-hidden is not decorative: without it, the sliding layer overflows onto
    the header and the footer instead of being cut at the edge.
  -->
  <main id="content" class="relative flex min-h-0 flex-1 flex-col overflow-hidden"></main>

  <footer class="flex flex-none items-center justify-between gap-[2vmin] border-t border-white/10 pt-[2vmin] text-[2.2vmin] text-dim">
    <div id="next-up"></div>
    <div class="flex items-center gap-[1vmin]">
      <span class="block size-[1.4vmin] rounded-full bg-ok" id="status-dot"></span>
      <span class="status-label status-offline">hors ligne</span>
      <span class="status-label status-degraded">temps réel interrompu</span>
      <span class="tabular-nums" id="clock"></span>
    </div>
  </footer>
</div>

<!--
  The state machine, inlined as in the control app and the console.

  The screen only needs a slot's effective end, but it derived it in its own way —
  and its way was wrong for a slot the export bounds only by a duration.
-->
<script>${MACHINE_JS}</script>

<!--
  The OBS scene's state, before everything else: the page must know whether it is
  on air from its very first frame, not after the first scene change.
-->
<script>${OBS_ON_AIR_JS}</script>

<script>
(() => {
  const content = document.getElementById('content')
  let last = null
  // What is currently on screen: used to decide on a transition.
  let shownMode = null
  let shownIndex = -1

  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  const time = (iso, tz) => new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit', minute: '2-digit', timeZone: tz,
  }).format(new Date(iso))

  // A section heading, shared by every mode.
  const SECTION_TITLE = "mb-[2.5vmin] text-[3vmin] tracking-[.18em] text-dim uppercase"

  function applyTheme(event) {
    if (!event) return
    const root = document.documentElement.style
    if (event.theme?.color) root.setProperty('--color', event.theme.color)
    if (event.theme?.colorSecondary) root.setProperty('--secondary', event.theme.colorSecondary)
    /*
     * Set once per URL.
     *
     * The cropping then replaces the source with the cropped image; reassigning
     * the original on every received state would make it reappear uncropped for
     * the length of one frame.
     */
    const logo = document.getElementById('logo')
    if (event.logoUrl && logo.dataset.source !== event.logoUrl) {
      logo.dataset.source = event.logoUrl
      logo.src = event.logoUrl
      logo.hidden = false
    }
  }

  /**
   * Automatic cropping of the logos.
   *
   * The logos arrive as the sponsors submitted them: some are cropped tight,
   * others float in the middle of a large margin. Placed side by side at equal
   * height, the latter look twice as small — it is not a question of size, it is
   * emptiness being displayed in their place. So we measure the ink and crop to
   * it.
   *
   * The computation is only possible because the cached images are served by the
   * client itself, on /assets: a logo that is still remote — the cache not filled
   * yet — invalidates the canvas, the read throws, and we keep the image as it
   * is. That is also what happens outside a browser.
   *
   * Once per URL only: the result is kept, and the page comes round every fifty
   * seconds.
   */
  const cropped = new Map()

  /** Is the pixel background? Transparent, or white — and nothing else. */
  const isBackground = (d, i) => d[i + 3] < 16 || (d[i] > 244 && d[i + 1] > 244 && d[i + 2] > 244)

  /**
   * Crops to the ink, and returns an image or nothing.
   *
   * Only transparent or white backgrounds are trimmed. A logo set on a flat
   * colour — AXA's blue square, HoppR's purple — has that flat colour for its
   * mark: tightening it onto the text it contains would damage the logo instead
   * of serving it. All four corners must therefore be background, otherwise we
   * touch nothing.
   */
  function crop(img) {
    const width = img.naturalWidth
    const height = img.naturalHeight
    if (!width || !height) return null

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext && canvas.getContext('2d')
    if (!ctx || !ctx.getImageData) return null
    canvas.width = width
    canvas.height = height
    ctx.drawImage(img, 0, 0)

    // Throws if the image comes from another origin: that is the nominal case
    // while the asset cache does not have the logo yet.
    let pixels
    try { pixels = ctx.getImageData(0, 0, width, height).data } catch (_) { return null }

    const corners = [0, (width - 1) * 4, (height - 1) * width * 4, (height * width - 1) * 4]
    if (!corners.every((i) => isBackground(pixels, i))) return null

    let x1 = width, y1 = height, x2 = -1, y2 = -1
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (isBackground(pixels, (y * width + x) * 4)) continue
        if (x < x1) x1 = x
        if (x > x2) x2 = x
        if (y < y1) y1 = y
        if (y > y2) y2 = y
      }
    }
    if (x2 < x1 || y2 < y1) return null

    const w = x2 - x1 + 1
    const h = y2 - y1 + 1
    // Nothing to gain, or too much to lose: ink covering almost nothing betrays a
    // badly chosen threshold rather than a tiny logo.
    if (w > width * 0.97 && h > height * 0.97) return null
    if (w * h < width * height * 0.02) return null

    const cut = document.createElement('canvas')
    cut.width = w
    cut.height = h
    cut.getContext('2d').drawImage(img, x1, y1, w, h, 0, 0, w, h)
    return cut.toDataURL('image/png')
  }

  /**
   * The same visual weight for every logo.
   *
   * Lined up on their height, an elongated logo covers five times the surface of
   * a square one: side by side, the second reads as small even though both were
   * given the same room. So it is the **area** that is held constant. The height
   * carried by the markup is that of a logo of ordinary proportions — about
   * 2.2:1 — and each logo deduces its own from its ratio, within a range that
   * keeps a row from tipping over: a banner does not become a thread, a square
   * does not become a poster.
   *
   * Runs on the displayed image, therefore after the crop: the empty margins the
   * crop removes are exactly what falsified the comparison.
   */
  const NOMINAL_RATIO = 2.2

  function fitLogo(img) {
    const base = Number(img.dataset.height)
    if (!base || !img.naturalWidth || !img.naturalHeight) return
    const height = base * Math.sqrt(NOMINAL_RATIO / (img.naturalWidth / img.naturalHeight))
    img.style.height = Math.min(Math.max(height, base * 0.68), base * 1.45).toFixed(2) + 'vmin'
  }

  /** Runs \`then\` on the image's real dimensions: now, or once it is loaded. */
  const whenLoaded = (img, then) => {
    if (img.complete && img.naturalWidth > 0) then()
    else img.addEventListener('load', then, { once: true })
  }

  /** Crops a layer's logos, once each, sizes them all alike, never throwing. */
  function cropLogos(layer) {
    for (const img of layer ? layer.querySelectorAll('img[data-logo]') : []) {
      const fit = () => fitLogo(img)
      const source = img.getAttribute('src')
      if (!source || source.startsWith('data:')) { whenLoaded(img, fit); continue }

      // Already measured: the crop is replayed from the cache and only the
      // sizing is redone — the layer is rewritten on every pass of the loop.
      const known = cropped.get(source)
      if (known !== undefined) {
        if (known) img.src = known
        whenLoaded(img, fit)
        continue
      }

      whenLoaded(img, () => {
        let result = null
        try { result = crop(img) } catch (_) { result = null }
        cropped.set(source, result)
        // The cropped image reloads: its proportions are the ones to size on.
        if (result) { img.src = result; whenLoaded(img, fit) } else fit()
      })
    }
  }

  /**
   * A sponsor's identity, from one tier to the next.
   *
   * The upstream export gives one identifier **per tier**: "ape factory", which
   * took three packs, carries three different ones. The website is the only thing
   * that does not move from one row to another; the name serves as a fallback for
   * the rare sponsors that declare none.
   */
  // The trailing slash goes through a character class: in a literal template, an
  // escaped slash vanishes before reaching the browser, and the regex that is
  // left no longer compiles.
  const sponsorKey = (s) =>
    (s.website || s.name || '').trim().toLowerCase().replace(/[/]+$/, '')

  /**
   * The partners, on a podium.
   *
   * The first tier is the one that paid the most — the tiers arrive already
   * sorted by rank. It therefore takes the top of the screen, large, alone on its
   * surface: that is what was sold to it.
   *
   * All the rest is merged into one row where each sponsor appears **only once**,
   * with the list of what it took. Previously the same logo came back identically
   * three rows apart: projected, a repeated logo reads as a display defect, not as
   * generosity. Those who committed on several fronts are bigger there and framed
   * in the brand colour — it is the data that decides, not a list of names written
   * here, which would be wrong at the very next edition.
   */
  function renderSponsors(data) {
    const tiers = data.sponsorTiers.filter((t) => t.sponsors.length > 0)
    if (tiers.length === 0) return '<div class="' + SECTION_TITLE + '">Merci à nos partenaires</div>'

    const top = tiers[0]
    const bySponsor = new Map()
    for (const tier of tiers.slice(1)) {
      for (const sponsor of tier.sponsors) {
        const known = bySponsor.get(sponsorKey(sponsor))
        if (known) known.tierNames.push(tier.name)
        else bySponsor.set(sponsorKey(sponsor), { sponsor, tierNames: [tier.name] })
      }
    }
    // The most committed first: it is the one we put forward, and JavaScript's
    // sort is stable, so the others keep the tiers' order.
    const committed = [...bySponsor.values()].sort((a, b) => b.tierNames.length - a.tierNames.length)
    const onEveryFront = committed.some((e) => e.tierNames.length > 1)

    // The screen does not stretch: beyond a handful of logos, everything shrinks
    // a notch rather than overflowing under the footer.
    const dense = top.sponsors.length > 5 || committed.length > 5

    /**
     * A logo on its white badge.
     *
     * \`height\` is a number of \`vmin\`, and the height of a logo of ordinary
     * proportions only: the page then reworks each one so that they all cover
     * the same surface (see \`fitLogo\`). It is written inline rather than as a
     * class because the value serves twice — as a size before the images load,
     * and as the base for that computation — and because a preview rendered
     * without a browser keeps it that way.
     *
     * The width is bounded by the caller, not here: in the band it is the screen
     * that limits, in a card it is the card. A very elongated logo — ape
     * factory's is five times its height — otherwise came out of its frame on
     * both sides.
     */
    const badge = (sponsor, height, width, index) => sponsor.logoUrl
      ? '<img src="' + escape(sponsor.logoUrl) + '" alt="' + escape(sponsor.name) + '"' +
        ' data-logo data-height="' + height + '"' +
        ' style="--i:' + index + ';height:' + height + 'vmin"' +
        ' class="' + width + ' rounded-[1.2vmin] bg-white' +
        ' object-contain px-[2vmin] py-[1.4vmin] drop-shadow-[0_.4vmin_1.2vmin_rgba(0,0,0,.45)]">'
      : '<span style="--i:' + index + '" class="text-[3.2vmin] font-semibold">' +
        escape(sponsor.name) + '</span>'

    const band =
      '<section class="top-tier rounded-[2vmin] border px-[4vmin] py-[3vmin]">' +
      '<div class="tier-name mb-[2.2vmin] text-center text-[2.4vmin] tracking-[.2em] uppercase">' +
      escape(top.name) + '</div>' +
      '<div class="cascade cards flex flex-wrap items-center justify-center gap-[3vmin]" style="--step:70ms">' +
      top.sponsors.map((s, index) =>
        badge(s, dense ? 11 : 14, 'max-w-[28vw]', index)).join('') +
      '</div></section>'

    if (committed.length === 0) return '<div class="' + SECTION_TITLE + '">Nos partenaires</div>' + band

    const row = committed.map((entry, index) => {
      const featured = entry.tierNames.length > 1
      /**
       * The same weight for the whole row, and the same vertical padding.
       *
       * The hierarchy is carried by the frame — width, brand rule, tint — not by
       * the logo's size. Slimming down the one that took a single pack broke the
       * line: the badges no longer shared a top or a bottom, and the captions
       * floated at different heights. A row of partners reads like a shelf, or it
       * does not read at all. Hence one surface for every logo, and one slot of
       * fixed height to hold them: what varies from one badge to the next is the
       * shape of the logo, never how much of the screen it takes.
       */
      const frame = featured
        ? 'border-[color-mix(in_srgb,var(--color)_50%,transparent)] bg-[color-mix(in_srgb,var(--color)_14%,transparent)] px-[3vmin] py-[2.2vmin]'
        : 'border-white/10 bg-white/5 px-[2.4vmin] py-[2.2vmin]'
      const height = dense ? 6.5 : 8
      // A slot of fixed height for the badge, whatever the logo's own height:
      // that is what keeps the captions on one line. It is cut to the tallest a
      // logo can be, a square one, and no taller — otherwise the row would carry
      // empty space that nothing ever fills.
      const slot = dense ? 'h-[9.5vmin]' : 'h-[11.6vmin]'
      // Fixed width: the cards line up, and the row stops depending on the length
      // of the packs' names.
      const width = featured ? 'w-[38vmin]' : 'w-[27vmin]'
      return '<article style="--i:' + index + '" class="flex ' + width + ' flex-col items-center' +
        ' gap-[1.4vmin] rounded-[1.6vmin] border text-center ' + frame + '">' +
        '<div class="flex ' + slot + ' items-center justify-center">' +
        badge(entry.sponsor, height, 'max-w-full', 0) + '</div>' +
        '<div class="text-[2vmin] leading-snug text-dim">' +
        escape(entry.tierNames.join(' · ')) + '</div></article>'
    }).join('')

    return '<div class="' + SECTION_TITLE + '">Nos partenaires</div>' + band +
      '<section class="mt-[3.5vmin]">' +
      '<div class="mb-[2vmin] text-[2.4vmin] tracking-[.2em] text-dim uppercase">' +
      (onEveryFront ? 'Et sur tous les fronts' : 'Et aussi') + '</div>' +
      '<div class="cascade cards flex flex-wrap items-stretch justify-center gap-[2.5vmin]" style="--step:70ms">' +
      row + '</div></section>'
  }

  function renderProgram(data) {
    const now = Date.now() + (data.state.serverTimeOffsetMs || 0)
    const running = data.state.currentSession?.id
    /**
     * What the room must find first: what is happening, or failing that what is
     * coming. Between two talks, currentSession is empty — which is precisely the
     * moment one looks for the next one's time.
     *
     * "anchor" is a hook, not styling: render() uses it to bring the row to the
     * centre.
     */
    const anchor = running ?? data.state.nextSession?.id
    if (data.sessions.length === 0) return '<div class="' + SECTION_TITLE + '">Programme indisponible</div>'

    /**
     * The frame carries the overflow, the list carries the translation.
     *
     * Two levels and not one: it is the whole list that slides, and it can only
     * do so if something above it cuts off what goes out.
     */
    return '<div class="' + SECTION_TITLE + '">Programme de la salle</div>' +
      '<div class="scroller min-h-0 flex-1">' +
      '<div class="cascade flex flex-col gap-[1.1vmin]" style="--step:25ms">' +
      data.sessions.map((session, index) => {
        /**
         * The effective end, not the raw end time.
         *
         * With no fallback on the duration or on the next slot, a talk the export
         * bounds only by its duration was greyed out from its start time: the room
         * read "past" on the talk that was being given. Returns null for a slot
         * nothing closes, which we prefer not to grey out at all.
         */
        const end = RoomState.effectiveEndAt(data.sessions, index)
        // Only one highlight possible: running, otherwise past, otherwise upcoming.
        const state = session.id === running
          ? "running bg-[color-mix(in_srgb,var(--color)_26%,transparent)] shadow-[inset_.5vmin_0_0_var(--color)]"
          : end != null && end < now ? "opacity-35" : ""
        const isBreak = session.kind === 'break' ? "opacity-55" : ""
        const timeTint = session.id === running ? "text-text" : "text-dim"
        const speakers = session.speakers.map((s) =>
          s.company ? \`\${s.name} — \${s.company}\` : s.name).join(' · ')
        const anchorClass = session.id === anchor ? 'anchor' : ''
        return \`<article style="--i:\${index}" class="\${anchorClass} grid grid-cols-[15vmin_1fr] items-baseline gap-[2.5vmin] rounded-[1.2vmin] px-[2vmin] py-[1.4vmin] \${state} \${isBreak}">
          <div class="text-[2.8vmin] tabular-nums \${timeTint}">\${time(session.startsAt, data.timezone)}</div>
          <div>
            <div class="text-[3vmin] font-semibold">\${escape(session.title)}</div>
            \${speakers ? \`<div class="mt-[.4vmin] text-[2.2vmin] text-dim">\${escape(speakers)}</div>\` : ''}
          </div>
        </article>\`
      }).join('') + '</div></div>'
  }

  /**
   * The countdown: the skeleton only.
   *
   * The digits are left empty and filled by updateCountdown(). That is what lets
   * the screen live: as long as this html does not change, render()'s memo
   * rebuilds nothing, and an animation placed on the digits survives from one
   * second to the next. The old version rewrote the whole block every second,
   * which forbade any animation by construction.
   */
  function renderCountdown(data) {
    const next = data.state.nextSession
    if (!next) return '<div class="text-center"><div class="text-[3.4vmin] text-dim">Fin des interventions</div></div>'
    return '<div class="text-center">' +
      '<div class="cd-chiffres text-[22vmin] leading-none font-bold tabular-nums">' +
      '<span class="cd-min">--</span>:<span class="cd-sec">--</span></div>' +
      // A one-minute sweep: with no start-of-break instant, it is the only honest
      // marker — and it is enough to show that time is passing.
      '<div class="mx-auto mt-[3vmin] h-[.8vmin] w-[40vmin] overflow-hidden rounded-full bg-white/15">' +
      '<div class="cd-arc h-full w-full origin-left rounded-full bg-[var(--color)] transition-transform duration-1000 ease-linear"></div></div>' +
      '<div class="mt-[2.5vmin] text-[3.4vmin] text-dim">Reprise — ' + escape(next.title) + '</div></div>'
  }

  /** The countdown's values, written without touching the structure. */
  let lastSecond = null
  function updateCountdown(data) {
    const layer = content.querySelector('.layer:not(.leaving)')
    const min = layer?.querySelector('.cd-min')
    const next = data.state.nextSession
    if (!min || !next) return

    const now = Date.now() + (data.state.serverTimeOffsetMs || 0)
    const remaining = Math.max(0, next.startsAtMs - now)
    const seconds = Math.floor((remaining % 60000) / 1000)
    min.textContent = String(Math.floor(remaining / 60000)).padStart(2, '0')
    layer.querySelector('.cd-sec').textContent = String(seconds).padStart(2, '0')

    /**
     * The bar empties over the current minute.
     *
     * A countdown that fills up says the opposite of what it counts. On crossing
     * zero it jumps back up: without cutting the transition, that return would
     * read as a second going backwards.
     */
    const arc = layer.querySelector('.cd-arc')
    if (arc) {
      arc.style.transitionDuration = lastSecond !== null && seconds > lastSecond ? '0s' : ''
      arc.style.transform = 'scaleX(' + seconds / 60 + ')'
    }

    // The beat restarted by hand: reassigning the class is not enough, the
    // browser has to have recomputed between the removal and the reapplication.
    if (seconds !== lastSecond) {
      lastSecond = seconds
      const digits = layer.querySelector('.cd-chiffres')
      digits.classList.remove('beat')
      void digits.offsetWidth
      digits.classList.add('beat')
    }
  }

  /**
   * The running talk's OpenFeedback QR code.
   *
   * Displayed at the end of the talk, while the audience is still seated: it is
   * the only moment one gets any feedback, and a link dictated out loud is never
   * scanned.
   */
  function renderFeedback(data) {
    const session = data.state.currentSession
    const feedback = data.feedback
    if (feedback == null || !feedback.qrSvg) {
      return '<div class="' + SECTION_TITLE + '">Aucune conférence à noter</div>'
    }

    return '<div class="' + SECTION_TITLE + '">Votre avis sur cette conférence</div>' +
      '<div class="flex items-center justify-center gap-[6vmin]">' +
      '<div class="rounded-[1.4vmin] bg-white p-[1.4vmin] [&>svg]:h-[34vmin] [&>svg]:w-[34vmin]">' +
      feedback.qrSvg + '</div>' +
      '<div class="max-w-[46vmin]">' +
      (session ? '<div class="text-[3.6vmin] leading-snug font-semibold">' + escape(session.title) + '</div>' : '') +
      '<div class="mt-[2vmin] text-[2.8vmin] leading-relaxed text-dim">' +
      'Scannez pour noter la conférence et laisser un commentaire aux speakers.</div></div></div>'
  }

  /**
   * An audience question, chosen in the control app.
   *
   * The same data as on both overlays — one selection, three surfaces: burned
   * into the capture, small over the room's video, or large in front of the
   * audience. They do not serve at the same moment, and the operator chooses
   * which ones.
   *
   * Reads the question, never the console's banner: that one has its own screen
   * mode, and confusing them projected "we resume in 5 minutes" under the heading
   * "Question du public".
   */
  function renderQuestion(data) {
    const question = data.state.question
    if (question == null) {
      return '<div class="' + SECTION_TITLE + '">Aucune question affichée</div>'
    }
    // No animation placed here: the whole layer enters on every rewrite, and the
    // render is only rewritten if it differs. A question that changes is therefore
    // already announced — placing a second one on top made the text move twice for
    // a single event.
    return '<div class="' + SECTION_TITLE + '">Question du public</div>' +
      '<div class="max-w-[80vmin] text-[6vmin] leading-snug font-semibold">' +
      escape(question.text) + '</div>' +
      (question.author
        ? '<div class="mt-[2vmin] text-[3vmin] text-dim">' + escape(question.author) + '</div>'
        : '')
  }

  function renderWall(data) {
    const messages = data.state.comments ?? []
    const qr = data.wall
    const column = qr
      ? '<div class="text-center">' +
        '<div class="rounded-[1.4vmin] bg-white p-[1vmin] [&>svg]:h-auto [&>svg]:w-full">' + qr.qrSvg + '</div>' +
        '<div class="mt-[1.4vmin] text-[2.2vmin] leading-relaxed text-dim">Scannez pour laisser un message<br>ou poser une question</div></div>'
      : ''

    const card = "rounded-[1.4vmin] bg-white/8 px-[2.4vmin] py-[1.8vmin]"
    const body = messages.length === 0
      // The wall can be empty at the start of the day: better to invite than to
      // leave a deserted frame.
      ? '<div class="' + card + '"><div class="text-[2.9vmin] leading-snug">Les premiers messages apparaîtront ici.</div></div>'
      : messages.map((message, index) =>
          '<div class="' + card + '" style="--i:' + index + '">' +
          '<div class="mb-[.6vmin] text-[2.1vmin] text-dim">' + escape(message.author) + '</div>' +
          '<div class="text-[2.9vmin] leading-snug">' + escape(message.text) + '</div></div>').join('')

    return '<div class="' + SECTION_TITLE + '">Vos messages</div>' +
      '<div class="grid h-full grid-cols-[1fr_26vmin] items-start gap-[4vmin]">' +
      '<div class="cascade flex flex-col gap-[1.6vmin] overflow-hidden">' + body + '</div>' + column + '</div>'
  }

  /**
   * What is going on next door.
   *
   * The only piece of information an attendee sitting in this room cannot guess:
   * the other two tracks are running at the same time, and changing room between
   * two talks is decided in thirty seconds, during the break.
   */
  function renderOtherRooms(data) {
    const rooms = (data.otherRooms ?? []).filter((room) => room.session != null)
    if (rooms.length === 0) return '<div class="' + SECTION_TITLE + '">Pendant ce temps…</div>'

    return '<div class="' + SECTION_TITLE + '">Pendant ce temps, à côté</div>' +
      '<div class="cascade cards grid gap-[2.5vmin] ' +
      (rooms.length > 2 ? 'grid-cols-2' : 'grid-cols-1') + '">' +
      rooms.map((room, index) => \`<article style="--i:\${index}" class="rounded-[1.6vmin] border border-white/10 bg-white/5 px-[3vmin] py-[2.4vmin]">
        <div class="flex items-baseline justify-between gap-[2vmin]">
          <div class="text-[2.6vmin] tracking-[.14em] text-dim uppercase">\${escape(room.name)}</div>
          <div class="text-[2.4vmin] tabular-nums \${room.running ? 'text-[var(--color)]' : 'text-dim'}">\${
            room.running ? 'en ce moment' : time(room.session.startsAt, data.timezone)}</div>
        </div>
        <div class="mt-[1.2vmin] text-[3.2vmin] leading-snug font-semibold">\${escape(room.session.title)}</div>
        \${room.session.speakers.length > 0
          ? \`<div class="mt-[.8vmin] text-[2.4vmin] text-dim">\${escape(room.session.speakers.join(' · '))}</div>\`
          : ''}
      </article>\`).join('') + '</div>'
  }

  /**
   * The event's accounts, and the hashtag.
   *
   * Set on the hub and sent down at sync: the upstream export only carries the
   * speakers' networks. The handle is written large because it is what one retypes
   * on one's phone from the back of the room — the URL is not something one copies
   * out.
   *
   * **The hashtag's card is hard-written**, unlike the accounts: it carries X's
   * official button, whose script lives at \`platform.x.com\` (see the note at the
   * bottom of the page). The hashtag in large type is what remains when that
   * script does not load — that is, offline, that is, every case this page is
   * built for. The button lands on top of it when it can; it never carries the
   * slide's readability.
   */
  function renderSocial(data) {
    const links = data.socialLinks ?? []
    const name = shortName(data)
    const cards = links.map((link, index) => \`<article style="--i:\${index}" class="rounded-[1.6vmin] border border-white/10 bg-white/5 px-[4vmin] py-[3vmin] text-center">
        <div class="text-[2.4vmin] tracking-[.16em] text-dim uppercase">\${escape(link.network)}</div>
        <div class="mt-[1.2vmin] text-[4.2vmin] leading-none font-bold">\${escape(link.handle)}</div>
      </article>\`).join('')

    const hashtag = \`<article style="--i:\${links.length}" class="rounded-[1.6vmin] border border-white/10 bg-white/5 px-[4vmin] py-[3vmin] text-center">
        <div class="text-[2.4vmin] tracking-[.16em] text-dim uppercase">X</div>
        <div class="mt-[1.2vmin] text-[4.2vmin] leading-none font-bold">#CloudNord</div>
        <div class="mt-[1.8vmin] flex min-h-[3.6vmin] items-center justify-center">
          <a href="https://x.com/intent/tweet?button_hashtag=CloudNord&amp;ref_src=twsrc%5Etfw" class="twitter-hashtag-button" data-related="@Cloud_Nord" data-dnt="true" data-show-count="false">Post #CloudNord</a>
        </div>
      </article>\`

    const title = links.length === 0 ? escape(name) : 'Suivez ' + escape(name)
    return '<div class="' + SECTION_TITLE + '">' + title + '</div>' +
      '<div class="cascade cards flex flex-wrap items-stretch justify-center gap-[3vmin]">' +
      cards + hashtag + '</div>'
  }

  /**
   * The waiting loop.
   *
   * What we leave running during the breaks: each page has its own duration, and
   * those with nothing to show are **skipped** rather than displayed empty — ten
   * seconds of a deserted frame in front of the room read as a failure.
   *
   * The durations are not equal: a twenty-seven-line program is read, a row of
   * logos is looked at. They are deliberately long — a screen that changes every
   * three seconds draws the eye during a break where people are talking.
   */
  const LOOP_PAGES = [
    { duration: 12_000, available: (d) => (d.sponsorTiers ?? []).some((t) => t.sponsors.length > 0), render: renderSponsors },
    { duration: 15_000, available: (d) => (d.sessions ?? []).length > 0, render: renderProgram },
    { duration: 12_000, available: (d) => (d.otherRooms ?? []).some((s) => s.session != null), render: renderOtherRooms },
    { duration: 10_000, available: (d) => (d.socialLinks ?? []).length > 0, render: renderSocial },
  ]
  /**
   * An index into LOOP_PAGES, and not into the list of available pages.
   *
   * It is the fix for a discreet defect: when a page lost its content — the other
   * rooms' last talk ends — or gained some at sync, the filtered list changed
   * length and the same index suddenly designated another page. The screen then
   * changed in the middle, keeping the previous page's deadline, and with no
   * transition since the index itself had not moved. An index that always
   * designates the same page cannot slide out from under us.
   */
  let loopIndex = 0
  let loopUntil = 0
  // The index and duration actually displayed: it is on them that a transition is
  // decided, and on them that the gauge and the program's scroll are aligned.
  let loopShownIndex = 0
  let loopDuration = 0

  const loopPages = (data) => LOOP_PAGES.filter((page) => page.available(data))

  /**
   * The first page that has something to show, starting from this index.
   *
   * Returns -1 when none has anything — a room never synchronized.
   */
  function pageFrom(data, start) {
    for (let step = 0; step < LOOP_PAGES.length; step += 1) {
      const index = (start + step) % LOOP_PAGES.length
      if (LOOP_PAGES[index].available(data)) return index
    }
    return -1
  }

  function renderLoop(data) {
    // Nothing to show anywhere — a room never synchronized: the sponsors at least
    // say which event this is.
    if (pageFrom(data, loopIndex) === -1) return renderSponsors(data)
    const pages = loopPages(data)

    const index = pageFrom(data, loopIndex)
    // The targeted page may have emptied since the last switch: we adopt the one
    // we actually display, and give it its own duration — otherwise it would
    // inherit the deadline of a page that is no longer on screen.
    if (index !== loopIndex) { loopIndex = index; loopUntil = 0 }
    const page = LOOP_PAGES[index]
    if (loopUntil === 0) loopUntil = Date.now() + page.duration
    loopShownIndex = index
    loopDuration = page.duration

    /**
     * The progress marker.
     *
     * Three dots at the bottom say there is more to come, and that it turns:
     * without them, a screen that changes on its own reads as an unstable screen.
     * The active dot fills over the page's duration, which additionally says
     * *when* it is going to turn.
     *
     * The duration is written here because it does not move for the whole page;
     * the time already elapsed is set afterwards from the script — putting it in
     * the html would make it change every second, and the slightest received
     * state would restart a transition in the middle.
     */
    const position = pages.indexOf(page)
    const dots = pages.map((_, i) => i === position
      ? '<span class="dot active" style="--duration:' + page.duration + 'ms"></span>'
      : '<span class="dot"></span>').join('')

    return '<div class="flex min-h-0 flex-1 flex-col justify-center">' + page.render(data) + '</div>' +
      '<div class="mt-[2.5vmin] flex flex-none items-center justify-center gap-[1.2vmin]">' + dots + '</div>'
  }

  /** Moves to the next page, skipping those with nothing to say. */
  function advanceLoop(data) {
    const index = pageFrom(data, (loopIndex + 1) % LOOP_PAGES.length)
    if (index === -1) { loopUntil = Date.now() + 5_000; return }
    loopIndex = index
    loopUntil = Date.now() + LOOP_PAGES[index].duration
  }

  function renderMessage(data) {
    const message = data.state.message
    if (!message) return '<div class="' + SECTION_TITLE + '">—</div>'
    const background = message.level === 'urgent' ? "bg-[#7a1420]" : ""
    const tint = message.level === 'warning' ? "text-warn" : ""
    return \`<div class="flex h-full flex-col justify-center gap-[3vmin] rounded-[2vmin] text-center \${background}">
      <div class="text-[7vmin] leading-[1.15] font-bold \${tint}">\${escape(message.text)}</div>
    </div>\`
  }

  /**
   * Writes a page, pushing the old one out of the frame if asked.
   *
   * innerHTML destroys everything that was there: the leaving layer is therefore
   * set aside first, then grafted back for the length of its exit animation. It
   * removes itself on animationend, and in any case at the next rewrite — there
   * can never be two of them.
   *
   * Grafted back at the front, so painted *under* the new one. Of no importance
   * since the move to lateral motion, where the two layers are adjacent and never
   * overlap; it mattered in the crossfade days.
   */
  function write(html, crossfade) {
    if (html === content.__html) return
    const leaving = crossfade ? content.querySelector('.layer:not(.leaving)') : null
    content.__html = html
    content.innerHTML = html
    if (!leaving) return
    leaving.classList.add('leaving')
    content.insertBefore(leaving, content.firstChild)

    // Two ways of leaving, because one is not enough: an engine that does not
    // animate — a Browser Source in the background, reduced motion — never says
    // animationend, and the layer would stay there, transparent, until the next
    // rewrite.
    const remove = () => leaving.remove()
    leaving.addEventListener('animationend', remove, { once: true })
    setTimeout(remove, 1_200)
  }

  /**
   * Aligns the active dot's gauge on the time already elapsed.
   *
   * Set here and not in the html: the value changes every second, and putting it
   * in the template would make the render differ permanently.
   */
  function setGauge(layer) {
    const gauge = layer?.querySelector('.dot.active')
    if (!gauge) return
    gauge.style.setProperty('--elapsed', Math.max(0, loopDuration - (loopUntil - Date.now())) + 'ms')
  }

  /**
   * Slides the program, from the running slot towards the rest of the day.
   *
   * Both bounds are measured after insertion: they depend on the screen's real
   * height, which goes from 1024x768 to 4K. Outside a real browser all these
   * measurements are zero, the class is not applied, and the list simply stays
   * where it is.
   */
  function setScroll(layer) {
    const frame = layer?.querySelector('.scroller')
    const list = frame?.firstElementChild
    if (!frame || !list || list.classList.contains('scrolling')) return

    const height = frame.clientHeight
    const travel = list.scrollHeight - height
    if (!(travel > 0)) return

    const anchor = layer.querySelector('.anchor')
    const aim = anchor ? anchor.offsetTop - (height - anchor.offsetHeight) / 2 : 0
    const from = Math.max(0, Math.min(aim, travel))
    // About one screen further down, without ever going past the end of the day.
    const to = Math.min(from + height * 0.85, travel)

    list.style.setProperty('--from', -from + 'px')
    list.style.setProperty('--to', -to + 'px')
    list.style.animationDuration = loopDuration + 'ms'
    list.classList.add('scrolling')
  }

  /**
   * The event's short name, pushed by the hub and cached by the room.
   *
   * Not the program's name (data.event.name): the hub can contradict it by
   * setting, and it knows it even before a program has been imported.
   */
  function shortName(data) {
    return data.eventIdentity?.shortName || ''
  }

  function render(data) {
    last = data
    // The title follows the event: the fallback window and the Browser Source's
    // tab must say which event this is, without a name being compiled into the
    // binary installed on the machine.
    const title = data.eventIdentity?.name
    if (title) document.title = title + ' — écran de salle'
    document.body.dataset.mode = data.state.mode
    document.body.dataset.connectivity = data.state.connectivity
    applyTheme(data.event)

    document.getElementById('room-name').textContent = data.roomName ?? data.state.roomId ?? ''

    const onBreak = data.state.breakBadge
    const badge = document.getElementById('break-badge')
    badge.hidden = onBreak == null
    if (onBreak != null) {
      badge.textContent = onBreak.state === 'en-cours' ? 'Break' : 'Break à venir'
      // "Upcoming" draws the eye, "running" is content to exist: at that moment,
      // the whole screen already says nothing is going on.
      badge.style.color = onBreak.state === 'en-cours' ? '' : 'var(--color-warn)'
    }
    const statusDot = document.getElementById('status-dot')
    statusDot.className = "block size-[1.4vmin] rounded-full " + (
      data.state.connectivity === 'OFFLINE' ? "bg-alert"
      : data.state.connectivity === 'DEGRADED' ? "bg-warn" : "bg-ok")

    const next = data.state.nextSession
    document.getElementById('next-up').textContent = next
      ? \`À suivre \${time(next.startsAt, data.timezone)} — \${next.title}\`
      : ''

    const modes = {
      sponsors: renderSponsors,
      programme: renderProgram,
      countdown: renderCountdown,
      message: renderMessage,
      feedback: renderFeedback,
      question: renderQuestion,
      wall: renderWall,
      loop: renderLoop,
      live: () => '',
    }
    /**
     * The loop restarts from the beginning every time one comes back to it.
     *
     * Leaving on a message then coming back must resume at the sponsors, not land
     * in the middle of the program with two seconds before the next switch.
     */
    if (data.state.mode !== 'loop') { loopIndex = 0; loopUntil = 0 }
    /**
     * Redrawn only when the render changes.
     *
     * A state arrives on every scene switch, every queue depth: rewriting
     * everything every time restarted the animations and made the screen flicker
     * in front of the room, for identical content.
     */
    const body = (modes[data.state.mode] ?? renderSponsors)(data)
    const html = body === ''
      ? ''
      : '<div class="layer absolute inset-0 flex flex-col justify-center overflow-hidden">' + body + '</div>'

    /**
     * The transition, only where it means something.
     *
     * We cross over on a real page change — another mode, or the loop's next
     * page. Not on one more message on the wall nor on a rewritten question:
     * there, superimposing two different texts would not read, whereas the new
     * layer's entrance is enough to say that something moved.
     */
    const crossing = data.state.mode !== shownMode
      || (data.state.mode === 'loop' && loopShownIndex !== shownIndex)
    write(html, crossing)
    shownMode = data.state.mode
    shownIndex = loopShownIndex

    /**
     * Brings what is happening now to the centre.
     *
     * A conference day is two to three times the screen's height, and nobody can
     * scroll a video projector: without this, the room would be looking at
     * breakfast at four in the afternoon. The container has overflow hidden, so it
     * shows no bar, but it positions perfectly well from the script.
     *
     * In the loop, the same question has a better answer: the list starts from the
     * running slot and slides towards what follows during the page's fifteen
     * seconds. The control app's "programme" mode, on the other hand, is a screen
     * one sets and leaves: it is content to be in the right place.
     *
     * Always on the live layer, never on the one fading away.
     */
    const alive = content.querySelector('.layer:not(.leaving)')
    /**
     * X's button, every time the Social slide comes back.
     *
     * \`widgets.js\` replaces the anchor with an iframe **when the script loads**,
     * once. But the layer is rewritten entirely on every return of the loop:
     * without this reminder, the button would only appear on the very first pass
     * and the slide would then fall back on its bare link.
     *
     * Optional end to end: \`twttr\` does not exist if the script could not be
     * loaded, which is the normal case for an offline room.
     */
    if (alive?.querySelector('.twitter-hashtag-button')) {
      try { window.twttr?.widgets?.load(alive) } catch { /* the hashtag stays readable */ }
    }
    // The whole document, and not just the layer: the event's logo lives in the
    // header. Since the result is kept per URL, the sweep costs nothing more.
    cropLogos(document)
    if (data.state.mode === 'loop') {
      setGauge(alive)
      setScroll(alive)
    } else {
      alive?.querySelector('.anchor')?.scrollIntoView({ block: 'center' })
    }
  }

  function tick() {
    const tz = last?.timezone ?? 'Europe/Paris'
    const offset = last?.state.serverTimeOffsetMs ?? 0
    document.getElementById('clock').textContent = new Intl.DateTimeFormat('fr-FR', {
      hour: '2-digit', minute: '2-digit', timeZone: tz,
    }).format(new Date(Date.now() + offset))
    // The countdown changes values every second, the rest waits for a state. Only
    // the digits move: the structure itself holds.
    if (last?.state.mode === 'countdown') updateCountdown(last)

    /**
     * The loop advances on this same tick.
     *
     * It goes back through the render function rather than writing directly into
     * the container: it is the render function that recentres the program on the
     * running slot, and that only rewrites if the html changes — so the entrance
     * animation only replays on a real page change.
     */
    if (last?.state.mode === 'loop' && Date.now() >= loopUntil) {
      advanceLoop(last)
      render(last)
    }
  }
  setInterval(tick, 1000)

  // The embedded state: the page displays something as soon as it loads, without
  // waiting for the stream's first message.
  // The stream only sends what changes: we keep the current state and merge.
  // A complete message (on opening, and after every reconnection) replaces it.
  let currentState = {}
  const embedded = document.getElementById('etat-initial')
  if (embedded) { currentState = JSON.parse(embedded.textContent); render(currentState); tick() }

  // EventSource reconnects by itself: the screen cannot stay frozen after a
  // restart of the local application, with no line of resume code.
  if (typeof EventSource !== 'undefined' && !window.__PREVIEW__) {
    const stream = new EventSource('/display/state?vue=projecteur')
    stream.onmessage = (event) => {
      currentState = JSON.parse(event.data); render(currentState); tick()
    }
    stream.addEventListener("delta", (event) => {
      currentState = Object.assign({}, currentState, JSON.parse(event.data))
      render(currentState); tick()
    })
  }
})()
</script>

<!--
  This page's only external dependency, and it is optional.

  The rest of the file holds with no network, by construction — that is the whole
  point of the embedded state and the cached assets. This one script cannot: X's
  official button is served by X. It is therefore loaded \`async\`, last, and
  **nothing depends on it**: without it the Social slide shows the hashtag in
  large type, which is in any case what gets retyped from the back of the room. A
  room cut off from the Internet loses a button nobody can click — a projected
  screen has no mouse — and keeps everything that is read.
-->
<script async src="https://platform.x.com/widgets.js" charset="utf-8"></script>
</body>
</html>`
}
