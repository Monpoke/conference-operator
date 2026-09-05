import { escapeHtml } from '@conference-operator/format'
import { TAILWIND_CSS } from '@conference-operator/ui'
import { DEFAULT_EVENT_IDENTITY, type EventIdentity } from '@conference-operator/contract'

export interface WallPageOptions {
  roomId: string | null
  rooms: { id: string; name: string }[]
  /**
   * The event's name, decided by the hub.
   *
   * Rendered into the page rather than requested by it: it is the first word read
   * by someone who has just scanned a QR code at the back of a room, and getting
   * it from one more network round trip would make it appear after the rest — on
   * the 4G of a conference room, well after.
   */
  event?: EventIdentity
}

/**
 * Escapes a value inserted into the rendered HTML.
 *
 * The event's name comes from the upstream export or from a console setting: two
 * trusted sources, but no reason to make an exception to the rule in a page built
 * by concatenation.
 *
 * This half is ordinary TypeScript, outside the template: it can import. The
 * JavaScript embedded in the page keeps its own copy — it has no build step and
 * cannot import anything at all.
 */
const escapeServer = escapeHtml

/**
 * The public wall, reached by QR code from a mobile phone.
 *
 * The constraints that explain its shape: it opens on the 4G of a conference
 * room, on any old phone, in a handful of seconds. Hence standalone HTML, no
 * external dependency, and contract calls through a minimal `fetch` — the oRPC
 * protocol over HTTP is a plain `{ json: … }`.
 */
export function renderWallPage({ roomId, rooms, event }: WallPageOptions): string {
  const data = JSON.stringify({ roomId, rooms }).replace(/</g, '\\u003c')
  const identity = event ?? DEFAULT_EVENT_IDENTITY
  const name = escapeServer(identity.name)

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#10121a">
<title>${name} — mur &amp; questions</title>
<style>${TAILWIND_CSS}</style>
<style>
  /*
   * Constraints specific to mobile, which the utilities do not express.
   *
   * The input size is the most important one: **below 16 px, iOS zooms
   * automatically on focus** and breaks the layout for the rest of the visit. The
   * shared sheet sets inputs at 14 px, the right size for a console on a keyboard;
   * here it has to be raised.
   */
  input, textarea, select { font-size: 16px; }
  textarea { min-height: 108px; resize: vertical; }
  body {
    min-height: 100dvh;
    padding: env(safe-area-inset-top) 16px calc(env(safe-area-inset-bottom) + 24px);
  }
  /* No grey flash on touch: the page is made for the finger. */
  * { -webkit-tap-highlight-color: transparent; }
</style>
</head>
<body class="mx-auto max-w-[620px] bg-canvas font-sans text-text">
<header class="pt-[22px] pb-3.5">
  <h1 class="text-[21px] font-bold">${name}</h1>
  <div class="mt-1 text-sm text-dim" id="room"></div>

  <!--
    Choosing the room, on the page.

    Each room's QR code already carries its own, but an attendee also arrives
    through a shared link, or changes room between two talks. Without this choice
    they landed on "Ouvrez le lien de votre salle" with no idea what to open — and
    their question stayed in their head.

    It concerns **only** the questions: the wall itself is shared by the whole
    event. Hence its place in the Questions tab rather than in the header.
  -->

  <!-- What they are listening to right now: "ask your question" has to say what
       about, and the question reaches the control app attached to the right talk. -->
  <div class="mt-2.5 rounded-[10px] border border-edge bg-surface p-3" id="talk" hidden>
    <div class="text-[11px] tracking-[.1em] text-dim uppercase" id="talk-when">En ce moment</div>
    <div class="mt-1 text-[15px] leading-snug font-semibold" id="talk-title"></div>
    <div class="mt-0.5 text-[13px] text-dim" id="talk-who"></div>
  </div>
</header>

<div class="tabs my-3.5 flex gap-1.5">
  <button id="tab-wall" class="active">Mur</button>
  <button id="tab-questions">Questions</button>
</div>

<section id="view-wall">
  <!--
    What the message becomes, said before writing it.

    It is the page's promise: you are not writing into a suggestion box, you are
    writing on the event's screens. Saying it after the form — which is what the
    previous version did, small and in grey — amounted to not saying it: nobody
    reads under a button they have just pressed.
  -->
  <div class="mb-3.5 rounded-[12px] border border-brand/40 bg-[color-mix(in_srgb,var(--color-brand)_12%,transparent)] p-3.5">
    <div class="text-[15px] leading-snug font-semibold">
      Votre message s'affiche <span class="text-brand">dans toutes les salles</span>
    </div>
    <div class="mt-1 text-[13px] leading-relaxed text-dim" id="scope">
      Projeté sur les écrans de l'événement, après relecture.
    </div>
  </div>

  <form class="card" id="form-message">
    <label for="author">Votre prénom</label>
    <input class="mb-3.5 rounded-[10px] p-[13px]" id="author" maxlength="80" autocomplete="given-name" required>
    <label for="message">Votre message</label>
    <textarea class="mb-3.5 w-full rounded-[10px] border border-edge bg-canvas p-[13px] text-text" id="message" maxlength="500" required></textarea>
    <div class="-mt-2.5 mb-3 text-right text-xs text-dim"><span id="count-message">0</span>/500</div>
    <button class="send" type="submit">Envoyer à l'événement</button>
  </form>

  <!--
    What is already on the screens.

    Without this, dropping a message amounted to speaking into the void: nothing
    showed that others were writing, nor that it really ended up projected. It is
    what makes the difference between a contact form and a wall.
  -->
  <div class="mt-5 flex items-baseline gap-2">
    <h2 class="text-[13px] font-semibold tracking-[.1em] text-dim uppercase">En ce moment sur les écrans</h2>
  </div>
  <div class="mt-2.5 flex flex-col gap-2.5" id="list-wall"></div>
</section>

<section id="view-questions" hidden>
  <!-- The room only matters here: a question is addressed to one precise speaker,
       in one precise room, whereas a wall message is addressed to everyone. -->
  <label class="mb-1" for="room-choice">Dans quelle salle êtes-vous ?</label>
  <select class="mb-3.5 rounded-[10px] p-[11px]" id="room-choice"></select>

  <form class="card" id="form-question">
    <label for="question">Votre question au speaker</label>
    <textarea class="mb-3.5 w-full rounded-[10px] border border-edge bg-canvas p-[13px] text-text" id="question" maxlength="300" required></textarea>
    <div class="-mt-2.5 mb-3 text-right text-xs text-dim"><span id="count-question">0</span>/300</div>
    <button class="send" type="submit">Poser la question</button>
  </form>
  <div class="mt-4 flex flex-col gap-2.5" id="list-questions"></div>
</section>

<div class="notice" id="notice"></div>

<script id="data" type="application/json">${data}</script>
<script>
(() => {
  const { roomId, rooms } = JSON.parse(document.getElementById('data').textContent)
  const $ = (id) => document.getElementById(id)

  /**
   * Device identifier: bounds the votes without imposing an account.
   * Asking for a sign-up to vote on a question would guarantee that nobody votes.
   */
  let deviceId = localStorage.getItem('mur-device')
  if (!deviceId || deviceId.length < 8) {
    deviceId = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    localStorage.setItem('mur-device', deviceId)
  }
  const votes = new Set(JSON.parse(localStorage.getItem('mur-votes') || '[]'))

  /**
   * Current room.
   *
   * Three sources, in this order: the scanned link, this phone's last choice, then
   * nothing. The choice is remembered because an attendee stays in the same room
   * for several talks in a row, and rescanning every time to ask a question would
   * never happen.
   *
   * The storage key stays \`mur-salle\`: it is written on phones that are already
   * in the field, and renaming it would silently forget their choice.
   */
  let currentRoom = roomId || localStorage.getItem('mur-salle') || ''
  if (!rooms.some((r) => r.id === currentRoom)) currentRoom = ''

  const select = $('room-choice')
  select.innerHTML = '<option value="">Choisissez votre salle…</option>' +
    rooms.map((r) => '<option value="' + r.id + '">' + r.name + '</option>').join('')
  select.value = currentRoom

  function setRoom(value) {
    currentRoom = value
    select.value = value
    const room = rooms.find((r) => r.id === value)
    // The room now only qualifies the questions: the wall is shared by the event,
    // and leaving a room name at the top of the page made it look as though one
    // was writing to that room.
    $('room').textContent = room
      ? 'Questions — ' + room.name
      : 'Mur commun à toutes les salles'
    if (value) localStorage.setItem('mur-salle', value)
    // The address follows, so that a shared or reloaded page stays the right one.
    // The query parameter stays \`salle\`: it is in links already shared around.
    const url = new URL(location.href)
    if (value) url.searchParams.set('salle', value)
    else url.searchParams.delete('salle')
    history.replaceState(null, '', url)
    void refreshTalk()
    if (!$('view-questions').hidden) void refreshQuestions()
  }

  select.onchange = (event) => setRoom(event.target.value)

  /**
   * The talk the questions attach to.
   *
   * The one running, or failing that the next one: a question asked during the
   * break that precedes a talk is aimed at it, and attaching it to nothing would
   * make it invisible to everyone — to the control app as to the other attendees.
   */
  let currentSession = null
  /** Its title, to say what the list is about. */
  let currentTitle = null

  /** The talk running in the chosen room, read back regularly. */
  async function refreshTalk() {
    const block = $('talk')
    if (!currentRoom) { block.hidden = true; return }
    try {
      const { current, next } = await call('rooms/current', { roomId: currentRoom })
      const session = current || next
      const before = currentSession
      currentSession = session ? session.id : null
      currentTitle = session ? session.title : null
      if (!session) { block.hidden = true; return }
      block.hidden = false
      $('talk-when').textContent = current ? 'En ce moment' : 'À suivre'
      $('talk-title').textContent = session.title
      $('talk-who').textContent = session.speakers.join(' · ')
      // The day moves on while the phone stays on the table: when the talk
      // changes, the displayed list must follow without waiting for its refresh
      // turn.
      if (before !== currentSession && !$('view-questions').hidden) void refreshQuestions()
    } catch {
      // The wall stays usable without it: this block informs, it commands nothing.
      block.hidden = true
    }
  }

  /** The wall's scope, said with the real number of rooms rather than in principle. */
  $('scope').textContent = rooms.length > 1
    ? 'Projeté sur les écrans des ' + rooms.length + ' salles, après relecture.'
    : "Projeté sur les écrans de l'événement, après relecture."

  setRoom(currentRoom)
  void refreshWall()
  // The day moves on while the page stays open on a phone left on a table:
  // without a re-read, it would announce the talk from an hour ago.
  setInterval(() => void refreshTalk(), 60_000)

  /** The oRPC protocol over HTTP fits in one { json: ... } object: no client needed. */
  async function call(path, input) {
    const response = await fetch('/rpc/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: input }),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body?.json?.message || 'Échec de la requête')
    return body.json
  }

  function notify(message, isError) {
    const el = $('notice')
    el.textContent = message
    el.className = 'notice visible ' + (isError ? 'error' : 'ok')
    clearTimeout(el.__t)
    el.__t = setTimeout(() => el.classList.remove('visible'), 4000)
  }

  const counter = (field, target) => {
    $(field).addEventListener('input', () => { $(target).textContent = $(field).value.length })
  }
  counter('message', 'count-message')
  counter('question', 'count-question')

  $('tab-wall').onclick = () => { toggle(true); refreshWall() }
  $('tab-questions').onclick = () => { toggle(false); refreshQuestions() }
  function toggle(wall) {
    $('view-wall').hidden = !wall
    $('view-questions').hidden = wall
    $('tab-wall').classList.toggle('active', wall)
    $('tab-questions').classList.toggle('active', !wall)
  }

  /**
   * What is already projected, read back regularly.
   *
   * It is the wall's social half: without it, dropping a message amounted to
   * speaking into the void. It also shows, without explaining anything, what gets
   * through moderation and what does not.
   */
  async function refreshWall() {
    const container = $('list-wall')
    try {
      const list = await call('wall/recent', { limit: 12 })
      container.innerHTML = ''
      if (list.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'rounded-[10px] border border-dashed border-edge p-4 text-center text-sm text-dim'
        empty.textContent = 'Rien encore. Le premier message de la journée peut être le vôtre.'
        container.appendChild(empty)
        return
      }
      for (const message of list) {
        const card = document.createElement('div')
        card.className = 'rounded-[10px] border border-edge bg-surface p-3'
        const author = document.createElement('div')
        author.className = 'mb-1 text-xs text-dim'
        // The handle when the source has one: it is what tells a post picked up
        // from social media apart from a message dropped here.
        author.textContent = message.authorHandle
          ? message.author + ' · ' + message.authorHandle
          : message.author
        const text = document.createElement('div')
        text.className = 'text-[15px] leading-snug'
        text.textContent = message.text
        card.append(author, text)
        container.appendChild(card)
      }
    } catch {
      // Silent: the wall stays usable without it, and an attendee has no use for
      // a refresh error.
    }
  }

  $('form-message').onsubmit = async (event) => {
    event.preventDefault()
    const button = event.target.querySelector('button')
    button.disabled = true
    try {
      await call('wall/post', {
        // Always null: a message from the audience is addressed to the event, not
        // to the room its author happens to be in. On the hub side, a null room
        // means "every room" — which is already what a social message did.
        roomId: null,
        author: $('author').value.trim(),
        text: $('message').value.trim(),
      })
      $('message').value = ''
      $('count-message').textContent = '0'
      notify('Envoyé — il apparaîtra sur les écrans après relecture.')
    } catch (cause) {
      notify(cause.message, true)
    } finally {
      button.disabled = false
    }
  }

  $('form-question').onsubmit = async (event) => {
    event.preventDefault()
    if (!currentRoom) { notify('Choisissez votre salle pour poser une question.', true); return }
    const button = event.target.querySelector('button')
    button.disabled = true
    try {
      await call('questions/post', {
        roomId: currentRoom,
        // Attached to the running talk: in the control app, a question with no
        // talk does not say what it is answering.
        sessionId: currentSession,
        author: $('author').value.trim() || null,
        text: $('question').value.trim(),
      })
      $('question').value = ''
      $('count-question').textContent = '0'
      notify('Question envoyée.')
      await refreshQuestions()
    } catch (cause) {
      notify(cause.message, true)
    } finally {
      button.disabled = false
    }
  }

  async function vote(id, button) {
    if (votes.has(id)) return
    try {
      const result = await call('questions/vote', { id, deviceId })
      votes.add(id)
      localStorage.setItem('mur-votes', JSON.stringify([...votes]))
      button.querySelector('.n').textContent = result.votes
      button.classList.add('voted')
    } catch (cause) {
      notify(cause.message, true)
    }
  }

  async function refreshQuestions() {
    if (!currentRoom) return
    const container = $('list-questions')
    /**
     * The questions of **this** talk, never those of the day.
     *
     * At 4 pm the list still brought up the questions from the 10 am talk — the
     * best voted ones, so at the top — and the audience voted for questions
     * nobody would ask any more. A question does not outlive its talk.
     */
    // The talk's title set as textContent and not concatenated into HTML: it comes
    // from the upstream export, and the rest of this page already composes in
    // nodes for that reason.
    const empty = (text) => {
      container.innerHTML = ''
      const block = document.createElement('div')
      block.className = 'py-[26px] text-center text-sm text-dim'
      block.textContent = text
      container.appendChild(block)
    }

    if (!currentSession) {
      empty('Aucune conférence annoncée dans cette salle pour le moment.')
      return
    }
    try {
      const list = await call('questions/list', { roomId: currentRoom, sessionId: currentSession })
      if (list.length === 0) {
        empty(currentTitle
          ? 'Aucune question sur \\u00ab\\u00a0' + currentTitle + '\\u00a0\\u00bb pour l\\'instant.'
          : 'Aucune question pour l\\'instant.')
        return
      }
      container.innerHTML = ''
      for (const question of list) {
        const card = document.createElement('div')
        card.className = 'question'
        const button = document.createElement('button')
        button.className = 'vote-button' + (votes.has(question.id) ? ' voted' : '')
        button.innerHTML = '<span class="text-[17px] font-bold">' + question.votes + '</span><span class="text-[10px] tracking-[.08em] uppercase">vote</span>'
        button.onclick = () => vote(question.id, button)
        const text = document.createElement('div')
        text.className = 'text'
        text.textContent = question.text
        if (question.author) {
          const author = document.createElement('div')
          author.className = 'author'
          author.textContent = question.author
          text.appendChild(author)
        }
        card.append(button, text)
        container.appendChild(card)
      }
    } catch {
      // Silent: a failed refresh must not alarm an attendee.
    }
  }

  setInterval(() => { if (!$('view-questions').hidden) refreshQuestions() }, 15_000)
  // The wall lives while it is being watched: a phone left on a table must see the
  // others' messages arrive, otherwise the page looks dead.
  setInterval(() => { if (!$('view-wall').hidden) refreshWall() }, 15_000)
})()
</script>
</body>
</html>`
}
