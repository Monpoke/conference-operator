import { TAILWIND_CSS } from '@conference-operator/ui'

/**
 * The control window in server mode.
 *
 * When an OBS dock drives the room, the machine's own window has nothing left to
 * steer: rendering the whole control app a second time — its state stream, its
 * VU meter that keeps OBS-B sending levels, its repaints every second — is pure
 * waste on a machine that is also recording. The window stays open (it is what
 * keeps the room running, and closing it still means "we switch off"), but it
 * shows this page and nothing more.
 *
 * Nothing here holds the room's state: the page only follows `/display/dock`, a
 * stream that speaks when a dock comes or goes.
 *
 * Two ways back to the console:
 * - the button, at any time — `?console` tells the control app not to offer
 *   server mode again straight away;
 * - by itself, when the dock has been gone for `LEAVE_GRACE_MS`. The delay is a
 *   dock reloading or the room restarting, not a dock that left; the operator
 *   must never be left with no control app at all once OBS is closed.
 *
 * The return only follows a dock seen at least once: server mode chosen from the
 * screens menu, with no dock, stays where it was put.
 */
export interface ServerModePageOptions {
  roomName: string | null
  eventName: string | null
}

/** How long the dock may be gone before the console comes back. */
export const LEAVE_GRACE_MS = 10_000

export function renderServerModePage({ roomName, eventName }: ServerModePageOptions): string {
  const title = roomName == null ? 'Régie de salle' : `Régie — ${roomName}`
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${escapeText(title)} · mode serveur</title>
<style>${TAILWIND_CSS}</style>
<style>html, body { height: 100%; } body { overflow: hidden; }</style>
</head>
<body class="flex h-screen items-center justify-center bg-canvas p-8 font-sans text-text">

<main class="w-full max-w-[520px] rounded-2xl border border-edge bg-surface px-10 py-9">
  <h1 class="mb-1.5 text-[20px] font-semibold">Mode serveur</h1>
  <p class="mb-6 text-sm leading-relaxed text-dim">
    ${escapeText([roomName, eventName].filter((part) => part != null).join(' · ') || 'Régie de salle')}
    — la salle tourne, et se pilote depuis le dock d'OBS. Cette fenêtre reste
    ouverte&nbsp;: la fermer arrête la salle.
  </p>

  <div class="flex items-center gap-2.5 text-[13px] text-dim" id="dock" data-role="dock">
    connexion…
  </div>

  <div class="mt-5 flex items-end justify-between gap-5">
    <span class="text-[12px] leading-snug text-dim">
      La console revient d'elle-même si le dock disparaît.
    </span>
    <a class="cursor-pointer rounded-lg border border-brand bg-brand px-6 py-3.5 text-sm font-semibold text-[#05070d]"
       href="/regie?console" data-role="console">Afficher la console</a>
  </div>
</main>

<script>
  const LEAVE_GRACE_MS = ${LEAVE_GRACE_MS}
  const dock = document.getElementById('dock')

  let seen = false
  let leaving = null

  function show(color, text) {
    dock.className = 'flex items-center gap-2.5 text-[13px] ' + color
    dock.textContent = text
  }

  const stream = new EventSource('/display/dock')
  stream.onmessage = (event) => {
    const { connected } = JSON.parse(event.data)
    if (connected) {
      seen = true
      clearTimeout(leaving)
      leaving = null
      return show('text-ok', '● dock OBS connecté')
    }
    if (!seen) return show('text-dim', '○ aucun dock connecté')
    show('text-warn', '○ dock perdu — retour à la console dans quelques secondes')
    if (leaving == null) leaving = setTimeout(() => location.replace('/regie'), LEAVE_GRACE_MS)
  }
  // The machine restarting: \`EventSource\` comes back by itself, and its first
  // message says where the dock stands. Until then, no return to a console the
  // machine could not serve.
  stream.onerror = () => {
    clearTimeout(leaving)
    leaving = null
    show('text-warn', '○ serveur de salle injoignable — reconnexion…')
  }
</script>

</body>
</html>`
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
