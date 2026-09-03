import { TAILWIND_CSS } from '@cloudnord/ui'

/**
 * The window for entering the hub's address, on the very first launch.
 *
 * It comes before everything else: the hub is what gives the list of rooms, so
 * the pairing code, so the program. Until we know who to talk to, there is
 * nothing to display.
 *
 * The reachability probe **forbids nothing**: it informs. "The hub can be started
 * after the rooms" is a property of the product, not a tolerance — a control
 * machine must be able to start the day before, with the hub switched off, and
 * join by itself the next morning. Blocking "Continuer" on an HTTP response would
 * turn that property into a failure one event morning.
 */
export interface HubAddressPageOptions {
  /** The field's prefill: the last known address, or the development default. */
  initialValue: string
}

export function renderHubAddressPage({ initialValue }: HubAddressPageOptions): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Adresse du hub</title>
<style>${TAILWIND_CSS}</style>
<style>html, body { height: 100%; } body { overflow: hidden; }</style>
</head>
<body class="flex h-screen items-center justify-center bg-canvas p-8 font-sans text-text">

<form class="w-full max-w-[520px] rounded-2xl border border-edge bg-surface px-10 py-9" id="form">
  <h1 class="mb-1.5 text-[20px] font-semibold">Régie de salle</h1>
  <p class="mb-6 text-sm leading-relaxed text-dim">
    Adresse du hub auquel ce poste se connecte. Celle du dernier lancement est
    proposée&nbsp;: valider repart sur le même hub.
  </p>

  <label for="address">Adresse du hub</label>
  <input class="w-full min-w-0 rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-text focus:border-brand focus:outline-none"
         id="address" type="text" spellcheck="false" autocomplete="off"
         placeholder="http://192.168.1.10:8787" value="${escapeAttribute(initialValue)}">

  <div class="mt-2.5 min-h-5 text-[13px] text-dim" id="status"></div>
  <div class="min-h-5 text-[13px] text-alert" id="error"></div>

  <div class="mt-5 flex items-end justify-between gap-5">
    <span class="text-[12px] leading-snug text-dim">
      Le hub peut être lancé après les salles&nbsp;: continuer sans réponse ne bloque rien.
    </span>
    <button class="cursor-pointer rounded-lg border border-brand bg-brand px-6 py-3.5 text-sm font-semibold text-[#05070d]"
            type="submit">Continuer</button>
  </div>
</form>

<script>
  const field = document.getElementById('address')
  const status = document.getElementById('status')
  const error = document.getElementById('error')

  /*
   * Probe number.
   *
   * Fast typing launches several of them: without this counter, the answer for a
   * half-typed address overwrote that of the complete one, and the field showed
   * "no answer" on a perfectly reachable hub.
   */
  let probe = 0
  let timer = null

  function show(color, text) {
    status.className = 'mt-2.5 min-h-5 text-[13px] ' + color
    status.textContent = text
  }

  async function probeAddress() {
    const value = field.value.trim()
    const number = ++probe
    if (value === '') return show('text-dim', '')
    show('text-dim', 'vérification…')
    const reachable = await window.hub.test(value)
    if (number !== probe) return
    show(
      reachable ? 'text-ok' : 'text-warn',
      reachable ? '✓ hub joignable' : '✗ pas de réponse — on peut continuer quand même',
    )
  }

  field.addEventListener('input', () => {
    error.textContent = ''
    clearTimeout(timer)
    timer = setTimeout(probeAddress, 400)
  })

  document.getElementById('form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const response = await window.hub.validate(field.value)
    if (!response.ok) error.textContent = response.message
  })

  field.focus()
  field.select()
  void probeAddress()
</script>

</body>
</html>`
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
