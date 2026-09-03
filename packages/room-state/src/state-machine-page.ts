import { MACHINE_JS } from './generated/browser.js'

/**
 * Test bench for the state machine.
 *
 * A standalone page where you load a room's program, push the clock at whatever
 * speed you like, and watch the state machine answer. It imitates nothing: it
 * inlines `MACHINE_JS`, exactly like the control app and the console, and calls
 * the same functions. A state that holds here holds in the room, and that is the
 * whole point — on the day, you cannot replay 09:50.
 *
 * Three things you see nowhere else:
 *
 * - the **log** of state changes, timestamped on the simulated clock: that is
 *   what shows a room coming back — or not — to a neutral state;
 * - **automatic closing** applied live, with its grace period, and a switch to
 *   strip explicit end times — the case where the scheduling rule sees nothing
 *   go by;
 * - the **diagram** of the state machine, with the current state lit and the
 *   last transition highlighted.
 */
export interface SlotPreview {
  id: string
  title: string
  kind: 'talk' | 'break'
  startsAt: string
  startsAtMs: number
  endsAt: string | null
  endsAtMs: number | null
  durationMinutes: number | null
}

export interface RoomPreview {
  id: string
  name: string
  slots: SlotPreview[]
}

export interface StateMachinePageOptions {
  rooms: RoomPreview[]
  timezone: string
  /** Opening instant. Defaults to the start of the first slot. */
  startAt?: number
  /** Event name, for the title. */
  eventName?: string
}

export function renderStateMachinePage(options: StateMachinePageOptions): string {
  const data = {
    rooms: options.rooms,
    timezone: options.timezone,
    startAt: options.startAt ?? options.rooms[0]?.slots[0]?.startsAtMs ?? Date.now(),
    eventName: options.eventName ?? 'Programme',
  }

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Automate d'une salle — banc d'essai</title>
<style>
  :root {
    --bg: #0e1116; --surface: #161b22; --surface2: #1c2129; --border: #2b3240;
    --text: #e6edf3; --muted: #8b949e;
    --ok: #3fb950; --warn: #d29922; --alert: #f85149; --brand: #58a6ff;
    --off: #484f58;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  h1 { font-size: 15px; margin: 0; font-weight: 600; }
  h2 { font-size: 12px; margin: 0 0 10px; font-weight: 600; text-transform: uppercase;
       letter-spacing: .08em; color: var(--muted); }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
         padding: 12px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
  .grid { display: grid; grid-template-columns: 360px 1fr; gap: 16px; padding: 16px; align-items: start; }
  @media (max-width: 1100px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  .card + .card { margin-top: 16px; }
  button, select, input[type=number], input[type=datetime-local] {
    font: inherit; color: inherit; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 7px; padding: 6px 10px;
  }
  button { cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--brand); }
  button:disabled { opacity: .4; cursor: not-allowed; }
  button.primary { background: var(--brand); color: #05121f; border-color: transparent; font-weight: 600; }
  button.active { border-color: var(--ok); }
  label { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
  .muted { color: var(--muted); }
  .alert { color: var(--alert); }
  .warn { color: var(--warn); }
  .num { font-variant-numeric: tabular-nums; }

  /*
   * Status dot: the same tints as the control app and the console, in the test
   * bench palette.
   *
   * This bench has its own palette — more contrasted, meant to be read next to a
   * diagram, not in a dark room. What has to match are the *names*: they come
   * from the appearance table, and this list must cover them all. The trust
   * outline (doute, muette) is not here, and that is deliberate — this bench only
   * renders a talk state, never a connectivity. The "status dot vocabulary" test,
   * in the ui package, holds the correspondence.
   */
  .dot { width: 14px; height: 14px; border-radius: 999px; background: var(--ok); display: inline-block; }
  .dot.off { background: var(--off); }
  .dot.not-started { background: var(--off); }
  .dot.late { background: var(--warn); }
  .dot.ending-soon { background: var(--warn); }
  .dot.ended { background: var(--off); }
  .dot.overrun { background: var(--alert); }

  .state-large { display: flex; align-items: center; gap: 12px; font-size: 22px; font-weight: 600; }
  .state-large .dot { width: 20px; height: 20px; }

  .slot { display: grid; grid-template-columns: 96px 1fr auto; gap: 10px; align-items: baseline;
          padding: 6px 8px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
  .slot:hover { background: var(--surface2); }
  .slot.current { background: color-mix(in srgb, var(--brand) 18%, transparent);
                  box-shadow: inset 3px 0 0 var(--brand); }
  .slot.target { border-color: var(--brand); }
  .slot.past { opacity: .45; }
  .slot.break { font-style: italic; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border); }
  .badge.running { border-color: var(--ok); color: var(--ok); }
  .badge.ended { border-color: var(--off); color: var(--muted); }
  button.kind { font-size: 11px; padding: 1px 8px; border-radius: 999px; color: var(--muted); }
  button.kind.override { color: var(--brand); border-color: var(--brand); }

  #log { max-height: 260px; overflow-y: auto; font-size: 12.5px; }
  #log div { padding: 3px 0; border-top: 1px solid var(--border); }
  #log div:first-child { border-top: 0; }

  svg .node rect { fill: var(--surface2); stroke: var(--border); stroke-width: 1.5; }
  svg .node text { fill: var(--muted); font-size: 12px; text-anchor: middle; }
  svg .node.lit rect { stroke-width: 2.5; }
  svg .node.lit text { fill: var(--text); font-weight: 600; }
  svg .edge { stroke: var(--border); fill: none; stroke-width: 1.5; marker-end: url(#arrow); }
  svg .edge.last { stroke: var(--brand); stroke-width: 2.5; marker-end: url(#arrowLit); }
  /* The halo punches through the lines running underneath: without it, the label
     is half-readable as soon as two arrows cross. */
  svg .label { fill: var(--muted); font-size: 10.5px; text-anchor: middle;
               stroke: var(--surface); stroke-width: 3px; paint-order: stroke; }
  svg .label.last { fill: var(--brand); }
</style>
</head>
<body>

<div class="bar">
  <h1>Automate d'une salle</h1>
  <select id="room"></select>
  <span class="muted">|</span>
  <label>heure simulée <input type="datetime-local" id="clock" step="1"></label>
  <button id="play">▶︎</button>
  <select id="speed">
    <option value="1">×1</option>
    <option value="60" selected>×60</option>
    <option value="600">×600</option>
  </select>
  <button id="back">−5 min</button>
  <button id="forward">+5 min</button>
  <span class="muted">|</span>
  <button id="replay">Rejouer la journée</button>
  <span id="stamp" class="muted num"></span>
</div>

<div style="padding: 0 16px;">
  <input type="range" id="scrubber" style="width: 100%;" min="0" max="1000" value="0">
</div>

<div class="grid">
  <div>
    <div class="card">
      <h2>Où en est la salle</h2>
      <div class="state-large"><span class="dot" id="dot"></span><span id="word"></span></div>
      <div id="detail" class="muted" style="margin-top: 8px;"></div>
      <div id="break-badge" style="margin-top: 8px;"></div>
      <div id="overrun"></div>
    </div>

    <div class="card">
      <h2>Piloter la conférence</h2>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <button id="start" class="primary">Commencer</button>
        <button id="end">Terminer</button>
        <button id="reset">Remettre à venir</button>
      </div>
      <div id="target" class="muted" style="margin-top: 10px;"></div>
    </div>

    <div class="card">
      <h2>Clôture automatique</h2>
      <div style="display: flex; gap: 14px; align-items: center; flex-wrap: wrap;">
        <label><input type="checkbox" id="auto-enabled" checked> active</label>
        <label>grâce <input type="number" id="auto-grace" value="5" min="0" max="120" style="width: 68px;"> min</label>
      </div>
      <label style="margin-top: 10px;">
        <input type="checkbox" id="no-end">
        retirer les heures de fin explicites
      </label>
      <div class="muted" style="margin-top: 6px; font-size: 12.5px;">
        La règle horaire lit la même fin que le dépassement : heure explicite, sinon durée,
        sinon début du créneau suivant. Cocher ci-dessus le vérifie — seul un créneau
        qu'aucune des trois règles ne ferme reste ouvert, et c'est alors à raison.
      </div>
    </div>
  </div>

  <div>
    <div class="card">
      <h2>L'automate</h2>
      <svg id="diagram" viewBox="0 0 900 360" style="width: 100%; height: auto;"></svg>
    </div>

    <div class="card">
      <h2>Créneaux de la salle <span class="muted" style="text-transform: none; letter-spacing: 0;">— cliquer pour cibler, le type pour le surcharger</span></h2>
      <div id="slots"></div>
    </div>

    <div class="card">
      <h2>Journal <span class="muted" style="text-transform: none; letter-spacing: 0;">— heure simulée</span></h2>
      <div id="log"></div>
    </div>
  </div>
</div>

<script id="data" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>

<!-- The state machine, inlined: the same functions as the hub and the control app. -->
<script>${MACHINE_JS}</script>

<script>
(() => {
  const $ = (id) => document.getElementById(id)
  const DATA = JSON.parse($('data').textContent)

  /** What the page drives: a room, an instant, decisions. */
  let roomId = DATA.rooms[0].id
  let instantMs = DATA.startAt
  /**
   * Decisions, **dated with the simulated time they were taken at**.
   *
   * Not a plain identifier → status map: winding the clock back must undo what
   * had not happened yet. Without the date, ending a talk at 09:05 then going
   * back to 08:59 left the room "ended" — on a slot nobody had touched at that
   * hour. The hub has always applied exactly this rule; it was the page that did
   * not.
   */
  let decisions = {}
  /**
   * Slot overrides, as the hub serves them.
   *
   * The export does not say everything: the normalizer has a single signal to
   * decide on — a slot **with no speaker** is a break — and it gets it wrong both
   * ways. A keynote whose speaker is not announced yet passes for lunch, and the
   * room reads "rien dans la salle" while an audience is expected. Correcting the
   * slot kind is the intended answer, and this is where we check what it gives
   * before setting it on the hub.
   */
  let overrides = {}
  let manualTarget = null
  let playing = false
  let lastState = null
  let lastEdge = null
  const logEntries = []

  const room = () => DATA.rooms.find((r) => r.id === roomId)

  /**
   * The slots as the state machine sees them.
   *
   * The "no end time" switch does not tamper with the state machine: it removes
   * the data, as an export carrying only start times would.
   */
  function slots() {
    const raw = room().slots.map((s) =>
      overrides[s.id] == null ? s : { ...s, kind: overrides[s.id] },
    )
    return $('no-end').checked ? raw.map((s) => ({ ...s, endsAtMs: null, endsAt: null })) : raw
  }

  const time = (ms) =>
    new Intl.DateTimeFormat('fr-FR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: DATA.timezone,
    }).format(new Date(ms))

  const dayAndTime = (ms) =>
    new Intl.DateTimeFormat('fr-FR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: DATA.timezone,
    }).format(new Date(ms))

  function duration(ms) {
    const sign = ms < 0 ? '−' : ''
    const total = Math.round(Math.abs(ms) / 1000)
    const min = Math.floor(total / 60)
    return sign + min + ' min ' + String(total % 60).padStart(2, '0') + ' s'
  }

  /**
   * The driven slot: the one designated, else the current one, else the next.
   *
   * Same rule as the control app: between two talks or during a break, what you
   * want to be able to launch is the talk coming up.
   */
  function target() {
    const list = slots()
    if (manualTarget != null) return list.find((s) => s.id === manualTarget) ?? null
    // The same rule as the control app, taken from the same place: the bench is
    // only of interest if it runs the state machine and not a lookalike copy.
    return RoomState.talkToControl(list, instantMs, statusesAt(instantMs))
  }

  /**
   * Statuses as they apply at a given instant.
   *
   * We filter on read, never by erasing: winding the clock forward again finds
   * the day where it was left.
   */
  function statusesAt(t) {
    const seen = {}
    for (const [id, decision] of Object.entries(decisions)) {
      if (RoomState.isDecisionApplicable(decision.at, t)) seen[id] = decision.status
    }
    return seen
  }

  const statusOf = (slot) =>
    slot == null ? 'scheduled' : statusesAt(instantMs)[slot.id] ?? 'scheduled'

  function note(text, tint) {
    logEntries.unshift({ at: instantMs, text, tint: tint ?? '' })
    if (logEntries.length > 200) logEntries.pop()
  }

  /** Applies a gesture, if the table allows it. */
  function act(action) {
    const slot = target()
    if (slot == null) return
    const status = statusOf(slot)
    const refusal = RoomState.transitionRefusal(status, action)
    if (refusal != null) {
      note('refusé — ' + refusal, 'alert')
      render()
      return
    }
    const next = RoomState.statusAfter(status, action)
    if (action === 'reset') delete decisions[slot.id]
    else decisions[slot.id] = { status: next, at: instantMs }
    note(
      { start: 'Commencer', end: 'Terminer', reset: 'Remettre à venir' }[action] +
        ' · ' + slot.title.slice(0, 40) + ' → ' + next,
    )
    render()
  }

  /**
   * The scheduling rule, applied on every tick.
   *
   * This is the library's toAutoEnd, not an imitation: what closes here closes on
   * the hub, and what stays open here stays open on the day.
   */
  function autoEnd() {
    const setting = {
      enabled: $('auto-enabled').checked,
      graceMinutes: Number($('auto-grace').value) || 0,
    }
    const list = slots()
    for (const slot of RoomState.toAutoEnd(list, instantMs, statusesAt(instantMs), setting)) {
      decisions[slot.id] = { status: 'ended', at: instantMs }
      note('clôture automatique · ' + slot.title.slice(0, 40), 'warn')
    }
  }

  // ————————————————————————————————— the diagram

  /**
   * The state machine diagram, drawn by hand.
   *
   * The eight states, laid out the way a slot's life unfolds: outside the slot at
   * the top, the talk in the middle, what ends it at the bottom.
   */
  const NODES = {
    aucune: { x: 120, y: 40, word: 'hors créneau' },
    pause: { x: 320, y: 40, word: 'pause' },
    'pas-commencee': { x: 120, y: 130, word: 'pas commencée' },
    retard: { x: 320, y: 130, word: 'retard' },
    'en-cours': { x: 540, y: 130, word: 'en cours' },
    'fin-proche': { x: 750, y: 130, word: 'vers la fin' },
    terminee: { x: 540, y: 290, word: 'terminée' },
    depassement: { x: 750, y: 230, word: 'dépassement' },
  }
  const W = 150
  const H = 34

  const EDGES = [
    ['aucune', 'pause', 'un break'],
    ['aucune', 'pas-commencee', 'un talk'],
    ['pause', 'pas-commencee', ''],
    ['pas-commencee', 'retard', '+5 min'],
    ['pas-commencee', 'en-cours', 'Commencer'],
    ['retard', 'en-cours', 'Commencer'],
    ['en-cours', 'fin-proche', '≤5 min'],
    ['fin-proche', 'depassement', 'fin atteinte'],
    ['en-cours', 'terminee', 'Terminer'],
    ['fin-proche', 'terminee', 'Terminer'],
    ['depassement', 'terminee', 'clôture'],
    ['terminee', 'aucune', 'fin du créneau'],
    ['terminee', 'pas-commencee', ''],
    ['depassement', 'pas-commencee', ''],
  ]

  /**
   * The point where the centre-to-centre line leaves the box.
   *
   * Without this, arrows start from the centre and run under the boxes: you can
   * no longer see what goes where, and labels land in the middle of a state.
   */
  function boxEdge(centre, dx, dy) {
    const rx = W / 2 + 5
    const ry = H / 2 + 5
    const scale = Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry)
    if (scale === 0) return { x: centre.x, y: centre.y }
    return { x: centre.x + dx / scale, y: centre.y + dy / scale }
  }

  /** Edge to edge: the arrow stops at the box, not at the centre. */
  function segment(a, b) {
    const from = NODES[a]
    const to = NODES[b]
    const dx = to.x - from.x
    const dy = to.y - from.y
    const p1 = boxEdge(from, dx, dy)
    const p2 = boxEdge(to, -dx, -dy)
    return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }
  }

  function drawDiagram() {
    const parts = [
      '<defs>',
      '<marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">',
      '<path d="M0,0 L8,4 L0,8 z" fill="#2b3240"/></marker>',
      '<marker id="arrowLit" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">',
      '<path d="M0,0 L8,4 L0,8 z" fill="#58a6ff"/></marker>',
      '</defs>',
    ]

    for (const [from, to, word] of EDGES) {
      const s = segment(from, to)
      const lit = lastEdge != null && lastEdge[0] === from && lastEdge[1] === to
      parts.push(
        '<line class="edge' + (lit ? ' last' : '') + '" x1="' + s.x1 + '" y1="' + s.y1 +
          '" x2="' + s.x2 + '" y2="' + s.y2 + '"/>',
      )
      if (word) {
        parts.push(
          '<text class="label' + (lit ? ' last' : '') + '" x="' + (s.x1 + s.x2) / 2 +
            '" y="' + ((s.y1 + s.y2) / 2 - 5) + '">' + word + '</text>',
        )
      }
    }

    for (const [name, node] of Object.entries(NODES)) {
      const appearance = RoomState.appearanceOf(name)
      const lit = name === lastState
      const colour = {
        '': 'var(--ok)', off: 'var(--off)', 'not-started': 'var(--off)',
        late: 'var(--warn)', 'ending-soon': 'var(--warn)',
        ended: 'var(--off)', overrun: 'var(--alert)',
      }[appearance.tint] ?? 'var(--off)'
      parts.push(
        '<g class="node' + (lit ? ' lit' : '') + '">' +
          '<rect x="' + (node.x - W / 2) + '" y="' + (node.y - H / 2) + '" width="' + W +
          '" height="' + H + '" rx="8"' + (lit ? ' stroke="' + colour + '"' : '') + '/>' +
          '<circle cx="' + (node.x - W / 2 + 14) + '" cy="' + node.y + '" r="5" fill="' + colour +
          '" opacity="' + (lit ? 1 : 0.35) + '"/>' +
          '<text x="' + (node.x + 7) + '" y="' + (node.y + 4) + '">' + node.word + '</text>' +
          '</g>',
      )
    }

    $('diagram').innerHTML = parts.join('')
  }

  // ————————————————————————————————— rendering

  function render() {
    const list = slots()
    const state = RoomState.stateOfSlots(list, instantMs, statusesAt(instantMs))
    const appearance = RoomState.appearanceOf(state)

    if (state !== lastState) {
      lastEdge = lastState == null ? null : [lastState, state]
      note(
        lastState == null ? 'état initial · ' + appearance.word : lastState + ' → ' + state,
        appearance.tint === 'overrun' ? 'alert' : '',
      )
      lastState = state
    }

    $('dot').className = 'dot ' + appearance.tint
    $('word').textContent = appearance.word

    const position = RoomState.timelinePosition(list, instantMs)
    const current = position.current
    const index = current == null ? -1 : list.indexOf(current)
    const end = index < 0 ? null : RoomState.effectiveEndAt(list, index)
    $('detail').innerHTML = current == null
      ? 'Aucun créneau à cet instant. Suivant : ' +
        (position.next == null ? '—' : position.next.title + ' à ' + time(position.next.startsAtMs))
      : '<b>' + current.title + '</b><br>' +
        time(current.startsAtMs) + ' → ' + (end == null ? 'fin inconnue' : time(end)) +
        (end == null ? '' : ' · <span class="num">' + duration(end - instantMs) + '</span> ' +
          (end - instantMs < 0 ? 'de dépassement' : 'restantes'))

    /**
     * Who is overrunning, by name.
     *
     * The state says "dépassement", but the slot shown just above is the
     * *current* slot — not the one dragging on. Without this reminder, you go
     * hunting for the culprit in the list, and that is exactly what you came to
     * see.
     */
    const applicable = statusesAt(instantMs)
    const overrunning = list.filter((s, i) => {
      if (applicable[s.id] !== 'running' || s.kind === 'break') return false
      const slotEnd = RoomState.effectiveEndAt(list, i)
      return slotEnd != null && slotEnd <= instantMs
    })
    $('overrun').innerHTML = overrunning.length === 0
      ? ''
      : overrunning.map((s) =>
          '<div class="alert" style="margin-top:8px;">Déborde depuis ' +
          duration(instantMs - (RoomState.effectiveEndAt(list, list.indexOf(s)) ?? instantMs)) + ' : <b>' +
          s.title + '</b> <button data-overrun="' + s.id + '" style="padding:2px 8px;">cibler</button></div>',
        ).join('')
    for (const b of $('overrun').querySelectorAll('[data-overrun]')) {
      b.onclick = () => { manualTarget = b.dataset.overrun; render() }
    }

    const roomBreak = RoomState.breakOfSlots(list, instantMs)
    $('break-badge').innerHTML = roomBreak == null
      ? '<span class="muted">Aucun break en vue.</span>'
      : '<span class="badge">' + (roomBreak.state === 'en-cours' ? 'BREAK' : 'BREAK à venir') + '</span> ' +
        roomBreak.session.title + (roomBreak.endsAtMs == null ? '' : ' · reprise ' + time(roomBreak.endsAtMs))

    // The three buttons follow the table, as in the control app.
    const targetSlot = target()
    const status = statusOf(targetSlot)
    for (const [id, action] of [['start', 'start'], ['end', 'end'], ['reset', 'reset']]) {
      const refusal = targetSlot == null
        ? 'Aucune conférence à piloter.'
        : RoomState.transitionRefusal(status, action)
      $(id).disabled = refusal != null
      $(id).title = refusal ?? ''
    }
    $('target').innerHTML = targetSlot == null
      ? 'Aucun créneau piloté.'
      : 'Créneau piloté : <b>' + targetSlot.title + '</b> · statut <span class="badge ' + status +
        '">' + status + '</span>' +
        (manualTarget == null ? '' : ' <button id="unbind" style="padding:2px 8px;">délier</button>')
    const unbind = $('unbind')
    if (unbind != null) unbind.onclick = () => { manualTarget = null; render() }

    $('slots').innerHTML = list.map((s, i) => {
      const slotEnd = RoomState.effectiveEndAt(list, i)
      const slotStatus = applicable[s.id]
      const classes = ['slot']
      if (s === current) classes.push('current')
      if (targetSlot != null && s.id === targetSlot.id) classes.push('target')
      if (slotEnd != null && slotEnd <= instantMs && s !== current) classes.push('past')
      if (s.kind === 'break') classes.push('break')
      const overridden = overrides[s.id] != null
      return '<div class="' + classes.join(' ') + '" data-id="' + s.id + '">' +
        '<span class="muted num">' + time(s.startsAtMs).slice(0, 5) +
        (slotEnd == null ? '' : '–' + time(slotEnd).slice(0, 5)) + '</span>' +
        '<span>' + s.title + '</span>' +
        '<span style="white-space: nowrap;">' +
        (slotStatus == null ? '' : '<span class="badge ' + slotStatus + '">' + slotStatus + '</span> ') +
        '<button class="kind' + (overridden ? ' override' : '') + '" data-kind="' + s.id +
        '" title="Surcharger le type de ce créneau, comme le fait le hub">' +
        s.kind + (overridden ? ' ✳︎' : '') + '</button>' +
        '</span></div>'
    }).join('')
    for (const row of $('slots').querySelectorAll('[data-id]')) {
      row.onclick = () => { manualTarget = row.dataset.id; render() }
    }
    for (const b of $('slots').querySelectorAll('[data-kind]')) {
      b.onclick = (event) => {
        // Without this, overriding a slot would also designate it as the target.
        event.stopPropagation()
        const id = b.dataset.kind
        const currentSlot = list.find((s) => s.id === id)
        const to = currentSlot.kind === 'talk' ? 'break' : 'talk'
        const origin = room().slots.find((s) => s.id === id).kind
        if (to === origin) delete overrides[id]
        else overrides[id] = to
        note('surcharge · ' + currentSlot.title.slice(0, 32) + ' → ' + to)
        render()
      }
    }

    $('log').innerHTML = logEntries.map((e) =>
      '<div><span class="muted num">' + time(e.at) + '</span> ' +
      '<span class="' + e.tint + '">' + e.text + '</span></div>').join('')

    const bounds = dayBounds()
    $('scrubber').value = String(
      Math.round(((instantMs - bounds.start) / (bounds.end - bounds.start)) * 1000),
    )
    $('clock').value = dateField(instantMs)
    $('stamp').textContent = dayAndTime(instantMs)

    drawDiagram()
  }

  /** The room's day, from the first start to the last end, with a little air. */
  function dayBounds() {
    const list = slots()
    const first = list[0]
    const last = list[list.length - 1]
    const start = (first?.startsAtMs ?? DATA.startAt) - 30 * 60000
    const rawEnd = last == null
      ? DATA.startAt
      : RoomState.effectiveEndAt(list, list.length - 1) ?? last.startsAtMs + 60 * 60000
    return { start, end: rawEnd + 60 * 60000 }
  }

  /**
   * The datetime-local field wants a local time, not an instant.
   *
   * We write it in the event's timezone: reading 10:00 when the room is playing
   * at 10:00 is the least you expect from a clock test bench.
   */
  function dateField(ms) {
    const parts = new Intl.DateTimeFormat('sv-SE', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: DATA.timezone, hour12: false,
    }).format(new Date(ms))
    return parts.replace(' ', 'T')
  }

  /** The inverse: we look for the instant whose local writing is the one entered. */
  function fromDateField(value) {
    const wanted = value.length === 16 ? value + ':00' : value
    const aimed = Date.parse(wanted + 'Z')
    if (Number.isNaN(aimed)) return null
    /**
     * We look for the fixed point: the instant whose local writing is the one
     * entered. The gap is measured against the input, never against the current
     * attempt — otherwise each pass subtracts the timezone offset again, and two
     * passes put the page two hours before the requested time.
     */
    let attempt = aimed
    for (let i = 0; i < 3; i += 1) {
      const gap = Date.parse(dateField(attempt) + 'Z') - aimed
      if (gap === 0) break
      attempt -= gap
    }
    return attempt
  }

  // ————————————————————————————————— the controls

  $('room').innerHTML = DATA.rooms
    .map((r) => '<option value="' + r.id + '">' + r.name + ' (' + r.slots.length + ')</option>')
    .join('')
  $('room').onchange = () => {
    roomId = $('room').value
    manualTarget = null
    lastState = null
    lastEdge = null
    note('salle : ' + room().name)
    render()
  }

  $('start').onclick = () => act('start')
  $('end').onclick = () => act('end')
  $('reset').onclick = () => act('reset')

  $('play').onclick = () => {
    playing = !playing
    $('play').textContent = playing ? '❚❚' : '▶︎'
    $('play').classList.toggle('active', playing)
  }
  $('back').onclick = () => { instantMs -= 5 * 60000; tick(0) }
  $('forward').onclick = () => { instantMs += 5 * 60000; tick(0) }

  $('replay').onclick = () => {
    // Overrides survive: they correct the program, they are not part of the
    // decisions of the day being replayed.
    decisions = {}
    manualTarget = null
    lastState = null
    lastEdge = null
    logEntries.length = 0
    instantMs = dayBounds().start
    note('journée remise à zéro')
    render()
  }

  $('scrubber').oninput = () => {
    const bounds = dayBounds()
    instantMs = bounds.start + (Number($('scrubber').value) / 1000) * (bounds.end - bounds.start)
    tick(0)
  }
  $('clock').onchange = () => {
    const read = fromDateField($('clock').value)
    if (read != null) { instantMs = read; tick(0) }
  }
  for (const id of ['auto-enabled', 'auto-grace', 'no-end']) $(id).onchange = () => render()

  /** One tick: the clock moves on, the scheduling rule applies, we redraw. */
  function tick(deltaMs) {
    if (deltaMs > 0) instantMs += deltaMs
    autoEnd()
    render()
  }

  const STEP_MS = 100
  setInterval(() => {
    if (!playing) return
    tick(Number($('speed').value) * STEP_MS)
  }, STEP_MS)

  note('ouverture')
  render()
})()
</script>
</body>
</html>`
}
