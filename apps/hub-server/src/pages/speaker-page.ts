import { escapeHtml } from '@conference-operator/format'
import type { Session } from '@conference-operator/program'
import {
  ENDING_SOON_MS,
  effectiveEndAt,
  nextTalk,
  roomPosition,
  type SessionStatuses,
} from '@conference-operator/room-state'

/** What the speaker's screen shows, decided by the hub. */
export interface SpeakerView {
  talk: { title: string; speakers: string[] } | null
  /** The instant the timer counts towards, or `null` when there is nothing to count. */
  targetMs: number | null
  /** The timer aims at a start, not an end. */
  beforeStart: boolean
  next: { title: string; startsAtMs: number } | null
}

export interface SpeakerPayload {
  serverTimeMs: number
  view: SpeakerView
}

const preview = (session: Session): SpeakerView['talk'] => ({
  title: session.title,
  speakers: session.speakers.map((person) => person.name),
})

/**
 * The talk and the instant its timer aims at.
 *
 * The same rule as the control app's stopwatch: before the slot, the time left
 * before starting; from its hour on, or once started early, what is left of the
 * slot. An overrunning talk stays the target, so its timer goes past zero. An
 * ended talk gives way to the next one.
 */
export function speakerView(
  sessions: readonly Session[],
  nowMs: number,
  statuses: SessionStatuses,
  pinnedId: string | null,
): SpeakerView {
  const target = roomPosition(sessions, nowMs, statuses, pinnedId).target
  const status = target == null ? null : (statuses[target.id] ?? 'scheduled')
  const upcoming = nextTalk(sessions, nowMs, statuses)

  if (target == null || status === 'ended') {
    return {
      talk: upcoming == null ? null : preview(upcoming),
      targetMs: upcoming?.startsAtMs ?? null,
      beforeStart: upcoming != null,
      next: null,
    }
  }

  const next = upcoming == null || upcoming === target
    ? null
    : { title: upcoming.title, startsAtMs: upcoming.startsAtMs }
  if (status === 'scheduled' && target.startsAtMs > nowMs) {
    return { talk: preview(target), targetMs: target.startsAtMs, beforeStart: true, next }
  }
  return {
    talk: preview(target),
    targetMs: effectiveEndAt(sessions, sessions.indexOf(target)),
    beforeStart: false,
    next,
  }
}

export interface SpeakerPageOptions {
  roomName: string
  eventName: string
  timezone: string
  stateUrl: string
  initial: SpeakerPayload
}

/**
 * The speaker's return screen, for one room.
 *
 * Standalone HTML with its own styles: it is read from the stage, at a distance,
 * on whatever screen was at hand. The state is embedded so that a reload shows
 * the timer at once, and the timer keeps counting if the hub stops answering.
 */
export function renderSpeakerPage({ roomName, eventName, timezone, stateUrl, initial }: SpeakerPageOptions): string {
  const data = JSON.stringify({ stateUrl, timezone, initial, endingSoonMs: ENDING_SOON_MS }).replace(/</g, '\\u003c')

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(roomName)} — retour orateur</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; }
  body {
    display: flex; flex-direction: column; gap: 2vh; padding: 3vh 4vw;
    background: #000; color: #fff; font-family: system-ui, sans-serif;
  }
  header, footer { display: flex; justify-content: space-between; gap: 2vw; font-size: clamp(14px, 2.4vh, 28px); color: #a3a3a3; }
  main { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: center; gap: 2vh; text-align: center; }
  #title { font-size: clamp(22px, 6vh, 64px); font-weight: 600; line-height: 1.15; overflow-wrap: anywhere; }
  #speakers { font-size: clamp(16px, 3.6vh, 40px); color: #d4d4d4; }
  #label { font-size: clamp(16px, 3.6vh, 40px); font-weight: 600; color: #a3a3a3; }
  #timer { font-size: min(24vw, 42vh); font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
  #timer[data-long] { font-size: min(17vw, 42vh); }
  body[data-phase="fin-proche"] #timer, body[data-phase="fin-proche"] #label { color: #fbbf24; }
  body[data-phase="depassement"] #timer, body[data-phase="depassement"] #label { color: #f87171; }
  #link, #veille { color: #fbbf24; }
</style>
</head>
<body>
<header><span>${escapeHtml(roomName)}</span><span>${escapeHtml(eventName)}</span></header>
<main>
  <div id="title"></div>
  <div id="speakers"></div>
  <div id="label"></div>
  <div id="timer" role="timer"></div>
</main>
<footer><span id="next"></span><span><span id="veille"></span> <span id="link"></span></span></footer>
<script id="donnees" type="application/json">${data}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('donnees').textContent);
  var POLL_MS = 5000;
  var view, offset;
  var el = function (id) { return document.getElementById(id); };
  var hour = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: data.timezone });

  function clock(ms) {
    var total = Math.ceil(Math.abs(ms) / 1000);
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = String(total % 60).padStart(2, '0');
    return hours > 0
      ? hours + ':' + String(minutes).padStart(2, '0') + ':' + seconds
      : minutes + ':' + seconds;
  }

  function tick() {
    if (view.targetMs == null) {
      document.body.dataset.phase = 'attente';
      el('label').textContent = '';
      el('timer').textContent = '';
      return;
    }
    var left = view.targetMs - (Date.now() + offset);
    var phase = view.beforeStart ? 'attente'
      : left < 0 ? 'depassement'
      : left <= data.endingSoonMs ? 'fin-proche'
      : 'en-cours';
    document.body.dataset.phase = phase;
    el('label').textContent = phase === 'attente' ? 'Début dans'
      : phase === 'depassement' ? 'Dépassement'
      : 'Temps restant';
    var text = (left < 0 && !view.beforeStart ? '+' : '') + clock(view.beforeStart ? Math.max(left, 0) : left);
    el('timer').textContent = text;
    el('timer').toggleAttribute('data-long', text.length > 5);
  }

  function apply(payload) {
    view = payload.view;
    offset = payload.serverTimeMs - Date.now();
    el('title').textContent = view.talk ? view.talk.title : 'Aucune conférence en cours';
    el('speakers').textContent = view.talk ? view.talk.speakers.join(', ') : '';
    el('next').textContent = view.next
      ? 'Ensuite, à ' + hour.format(view.next.startsAtMs) + ' : ' + view.next.title
      : '';
    tick();
  }

  function refresh() {
    fetch(data.stateUrl, { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(function (payload) {
        apply(payload);
        el('link').textContent = '';
      })
      .catch(function () {
        // The timer keeps counting on what it knows, and says it is no longer fed.
        el('link').textContent = 'Connexion au hub perdue';
      });
  }

  // The browser drops the lock whenever the page is hidden: it has to be asked again.
  var wakeLock = null;
  var asking = false;
  function keepAwake() {
    if (!navigator.wakeLock) {
      el('veille').textContent = 'Mise en veille non bloquée par ce navigateur';
      return;
    }
    if (wakeLock || asking || document.visibilityState !== 'visible') return;
    asking = true;
    navigator.wakeLock.request('screen')
      .then(function (lock) {
        wakeLock = lock;
        el('veille').textContent = '';
        lock.addEventListener('release', function () {
          wakeLock = null;
          keepAwake();
        });
      })
      .catch(function () {
        el('veille').textContent = 'Mise en veille non bloquée : touchez l’écran';
      })
      .then(function () {
        asking = false;
      });
  }
  document.addEventListener('visibilitychange', keepAwake);
  document.addEventListener('pointerdown', keepAwake);
  keepAwake();

  apply(data.initial);
  setInterval(tick, 250);
  setInterval(refresh, POLL_MS);
})();
</script>
</body>
</html>`
}
