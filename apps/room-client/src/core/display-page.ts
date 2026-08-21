import { TAILWIND_CSS } from '@cloudnord/ui'

/**
 * Page projetée en salle.
 *
 * Contraintes qui expliquent la forme : elle est rendue par la Browser Source
 * d'OBS-A (ou une fenêtre Electron de secours), doit tenir sans étape de build,
 * sans réseau, et rester lisible à dix mètres. D'où du HTML autonome, un
 * `EventSource` qui se reconnecte tout seul, et aucune dépendance externe.
 *
 * **Tout est dimensionné en `vmin`**, y compris via Tailwind. L'écran passe
 * d'un vidéoprojecteur 1024×768 à un 4K selon les salles : des tailles en `rem`
 * donneraient un texte minuscule sur l'un et débordant sur l'autre.
 */
export interface ProjectorPageOptions {
  /**
   * État embarqué dans la page, rendu avant toute connexion.
   *
   * Évite l'écran vide entre le chargement et le premier message SSE — visible
   * en salle à chaque rechargement de la Browser Source. Sert aussi à produire
   * un aperçu hors ligne strictement identique à la page réelle.
   */
  initialPayload?: unknown
}

export function renderProjectorPage(options: ProjectorPageOptions = {}): string {
  const etatInitial =
    options.initialPayload == null
      ? ''
      : `<script id="etat-initial" type="application/json">${JSON.stringify(options.initialPayload).replace(/</g, '\\u003c')}</script>`

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cloud Nord — écran de salle</title>
<style>${TAILWIND_CSS}</style>
<style>
  :root { --couleur: #5b7cfa; --secondaire: #22d3ee; }
  html, body { height: 100%; }
  /* Curseur masqué : la page vit sur un vidéoprojecteur, pas sur un bureau. */
  body { overflow: hidden; cursor: none; }

  /*
   * Halos de marque, dérivés des couleurs de l'événement.
   *
   * Hors Tailwind : deux dégradés radiaux composés avec color-mix, que les
   * utilitaires n'expriment pas, et qui doivent suivre --couleur à chaud.
   */
  #scene {
    background:
      radial-gradient(120vmax 90vmax at 12% -10%, color-mix(in srgb, var(--couleur) 38%, transparent), transparent 60%),
      radial-gradient(90vmax 70vmax at 110% 110%, color-mix(in srgb, var(--secondaire) 32%, transparent), transparent 60%),
      var(--color-fond);
  }

  /* État réseau : discret, informatif, jamais alarmant pour le public. */
  .etat-libelle { display: none; }
  body[data-connectivite="OFFLINE"] .etat-hors-ligne { display: inline; }
  body[data-connectivite="DEGRADED"] .etat-degrade { display: inline; }

  /* En direct, l'écran s'efface : c'est la capture HDMI qui occupe la scène. */
  body[data-mode="live"] #scene { background: #000; }
  body[data-mode="live"] header,
  body[data-mode="live"] footer,
  body[data-mode="live"] main { opacity: 0; }
</style>
</head>
<body class="bg-fond font-sans text-texte" data-mode="sponsors" data-connectivite="OFFLINE">
${etatInitial}
<div id="scene" class="absolute inset-0 flex flex-col gap-[3vmin] p-[4.5vmin]">
  <header class="flex flex-none items-center justify-between gap-[2vmin]">
    <img id="logo" alt="" class="h-[7vmin] max-w-[30vw] object-contain" hidden>
    <div class="text-[2.6vmin] tracking-[.16em] text-attenue uppercase" id="nom-salle"></div>
  </header>

  <main id="contenu" class="flex min-h-0 flex-1 flex-col justify-center"></main>

  <footer class="flex flex-none items-center justify-between gap-[2vmin] border-t border-white/10 pt-[2vmin] text-[2.2vmin] text-attenue">
    <div id="prochain"></div>
    <div class="flex items-center gap-[1vmin]">
      <span class="block size-[1.4vmin] rounded-full bg-ok" id="pastille"></span>
      <span class="etat-libelle etat-hors-ligne">hors ligne</span>
      <span class="etat-libelle etat-degrade">temps réel interrompu</span>
      <span class="tabular-nums" id="horloge"></span>
    </div>
  </footer>
</div>

<script>
(() => {
  const contenu = document.getElementById('contenu')
  let dernier = null

  const echapper = (valeur) => String(valeur ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  const heure = (iso, tz) => new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit', minute: '2-digit', timeZone: tz,
  }).format(new Date(iso))

  // Intitulé de section, commun à tous les modes.
  const TITRE_MODE = "mb-[2.5vmin] text-[3vmin] tracking-[.18em] text-attenue uppercase"

  function appliquerTheme(evenement) {
    if (!evenement) return
    const racine = document.documentElement.style
    if (evenement.theme?.color) racine.setProperty('--couleur', evenement.theme.color)
    if (evenement.theme?.colorSecondary) racine.setProperty('--secondaire', evenement.theme.colorSecondary)
    const logo = document.getElementById('logo')
    if (evenement.logoUrl) { logo.src = evenement.logoUrl; logo.hidden = false }
  }

  function rendreSponsors(donnees) {
    const tiers = donnees.sponsorTiers.filter((t) => t.sponsors.length > 0)
    if (tiers.length === 0) return '<div class="' + TITRE_MODE + '">Merci à nos partenaires</div>'
    return '<div class="' + TITRE_MODE + '">Nos partenaires</div>' +
      '<div class="flex flex-col gap-[4vmin]">' +
      tiers.map((tier, index) => \`
        <section>
          <div class="mb-[1.5vmin] text-[2.4vmin] tracking-[.2em] text-attenue uppercase">\${echapper(tier.name)}</div>
          <div class="flex flex-wrap items-center gap-[3.5vmin]">\${tier.sponsors.map((s) =>
            s.logoUrl
              ? \`<img src="\${echapper(s.logoUrl)}" alt="\${echapper(s.name)}"
                   class="\${index > 0 ? 'h-[7.5vmin]' : 'h-[11vmin]'} max-w-[26vw] rounded-[1.2vmin] bg-white object-contain px-[2vmin] py-[1.4vmin] drop-shadow-[0_.4vmin_1.2vmin_rgba(0,0,0,.45)]">\`
              : \`<span class="text-[3vmin] font-semibold">\${echapper(s.name)}</span>\`).join('')}</div>
        </section>\`).join('') + '</div>'
  }

  function rendreProgramme(donnees) {
    const maintenant = Date.now() + (donnees.state.serverTimeOffsetMs || 0)
    const encours = donnees.state.currentSession?.id
    if (donnees.sessions.length === 0) return '<div class="' + TITRE_MODE + '">Programme indisponible</div>'

    return '<div class="' + TITRE_MODE + '">Programme de la salle</div>' +
      '<div class="flex flex-col gap-[1.1vmin] overflow-hidden">' +
      donnees.sessions.map((session) => {
        const fin = session.endsAtMs ?? session.startsAtMs
        // Une seule mise en avant possible : en cours, sinon passée, sinon à venir.
        const etat = session.id === encours
          ? "bg-[color-mix(in_srgb,var(--couleur)_26%,transparent)] shadow-[inset_.5vmin_0_0_var(--couleur)]"
          : fin < maintenant ? "opacity-35" : ""
        const pause = session.kind === 'break' ? "opacity-55" : ""
        const heureTeinte = session.id === encours ? "text-texte" : "text-attenue"
        const intervenants = session.speakers.map((s) =>
          s.company ? \`\${s.name} — \${s.company}\` : s.name).join(' · ')
        return \`<article class="grid grid-cols-[15vmin_1fr] items-baseline gap-[2.5vmin] rounded-[1.2vmin] px-[2vmin] py-[1.4vmin] \${etat} \${pause}">
          <div class="text-[2.8vmin] tabular-nums \${heureTeinte}">\${heure(session.startsAt, donnees.timezone)}</div>
          <div>
            <div class="text-[3vmin] font-semibold">\${echapper(session.title)}</div>
            \${intervenants ? \`<div class="mt-[.4vmin] text-[2.2vmin] text-attenue">\${echapper(intervenants)}</div>\` : ''}
          </div>
        </article>\`
      }).join('') + '</div>'
  }

  function rendreCompte(donnees) {
    const suivante = donnees.state.nextSession
    if (!suivante) return '<div class="text-center"><div class="text-[3.4vmin] text-attenue">Fin des interventions</div></div>'
    const maintenant = Date.now() + (donnees.state.serverTimeOffsetMs || 0)
    const reste = Math.max(0, suivante.startsAtMs - maintenant)
    const minutes = String(Math.floor(reste / 60000)).padStart(2, '0')
    const secondes = String(Math.floor((reste % 60000) / 1000)).padStart(2, '0')
    return \`<div class="text-center">
      <div class="text-[22vmin] leading-none font-bold tabular-nums">\${minutes}:\${secondes}</div>
      <div class="mt-[2vmin] text-[3.4vmin] text-attenue">Reprise — \${echapper(suivante.title)}</div>
    </div>\`
  }

  function rendreMur(donnees) {
    const messages = donnees.state.comments ?? []
    const qr = donnees.wall
    const colonne = qr
      ? '<div class="text-center">' +
        '<div class="rounded-[1.4vmin] bg-white p-[1vmin] [&>svg]:h-auto [&>svg]:w-full">' + qr.qrSvg + '</div>' +
        '<div class="mt-[1.4vmin] text-[2.2vmin] leading-relaxed text-attenue">Scannez pour laisser un message<br>ou poser une question</div></div>'
      : ''

    const carte = "rounded-[1.4vmin] bg-white/8 px-[2.4vmin] py-[1.8vmin]"
    const corps = messages.length === 0
      // Le mur peut être vide en début de journée : mieux vaut inviter que
      // laisser un cadre désert.
      ? '<div class="' + carte + '"><div class="text-[2.9vmin] leading-snug">Les premiers messages apparaîtront ici.</div></div>'
      : messages.map((message) =>
          '<div class="' + carte + '">' +
          '<div class="mb-[.6vmin] text-[2.1vmin] text-attenue">' + echapper(message.author) + '</div>' +
          '<div class="text-[2.9vmin] leading-snug">' + echapper(message.text) + '</div></div>').join('')

    return '<div class="' + TITRE_MODE + '">Vos messages</div>' +
      '<div class="grid h-full grid-cols-[1fr_26vmin] items-start gap-[4vmin]">' +
      '<div class="flex flex-col gap-[1.6vmin] overflow-hidden">' + corps + '</div>' + colonne + '</div>'
  }

  function rendreMessage(donnees) {
    const message = donnees.state.message
    if (!message) return '<div class="' + TITRE_MODE + '">—</div>'
    const fond = message.level === 'urgent' ? "bg-[#7a1420]" : ""
    const teinte = message.level === 'warning' ? "text-attention" : ""
    return \`<div class="flex h-full flex-col justify-center gap-[3vmin] rounded-[2vmin] text-center \${fond}">
      <div class="text-[7vmin] leading-[1.15] font-bold \${teinte}">\${echapper(message.text)}</div>
    </div>\`
  }

  function rendre(donnees) {
    dernier = donnees
    document.body.dataset.mode = donnees.state.mode
    document.body.dataset.connectivite = donnees.state.connectivity
    appliquerTheme(donnees.event)

    document.getElementById('nom-salle').textContent = donnees.roomName ?? donnees.state.roomId ?? ''
    const pastille = document.getElementById('pastille')
    pastille.className = "block size-[1.4vmin] rounded-full " + (
      donnees.state.connectivity === 'OFFLINE' ? "bg-alerte"
      : donnees.state.connectivity === 'DEGRADED' ? "bg-attention" : "bg-ok")

    const suivante = donnees.state.nextSession
    document.getElementById('prochain').textContent = suivante
      ? \`À suivre \${heure(suivante.startsAt, donnees.timezone)} — \${suivante.title}\`
      : ''

    const modes = {
      sponsors: rendreSponsors,
      programme: rendreProgramme,
      countdown: rendreCompte,
      message: rendreMessage,
      wall: rendreMur,
      live: () => '',
    }
    contenu.innerHTML = (modes[donnees.state.mode] ?? rendreSponsors)(donnees)
  }

  function tic() {
    const tz = dernier?.timezone ?? 'Europe/Paris'
    const decalage = dernier?.state.serverTimeOffsetMs ?? 0
    document.getElementById('horloge').textContent = new Intl.DateTimeFormat('fr-FR', {
      hour: '2-digit', minute: '2-digit', timeZone: tz,
    }).format(new Date(Date.now() + decalage))
    // Le compte à rebours se redessine à la seconde, le reste attend un état.
    if (dernier?.state.mode === 'countdown') contenu.innerHTML = rendreCompte(dernier)
  }
  setInterval(tic, 1000)

  // État embarqué : la page affiche quelque chose dès le chargement, sans
  // attendre le premier message du flux.
  // Le flux n'envoie que ce qui change : on garde l'etat courant et on fusionne.
  // Un message complet (a l'ouverture, et apres chaque reconnexion) le remplace.
  let etatCourant = {}
  const embarque = document.getElementById('etat-initial')
  if (embarque) { etatCourant = JSON.parse(embarque.textContent); rendre(etatCourant); tic() }

  // EventSource se reconnecte seul : l'écran ne peut pas rester figé après
  // un redémarrage de l'application locale, sans une ligne de code de reprise.
  if (typeof EventSource !== 'undefined' && !window.__APERCU__) {
    const flux = new EventSource('/display/state?vue=projecteur')
    flux.onmessage = (evenement) => {
      etatCourant = JSON.parse(evenement.data); rendre(etatCourant); tic()
    }
    flux.addEventListener("delta", (evenement) => {
      etatCourant = Object.assign({}, etatCourant, JSON.parse(evenement.data))
      rendre(etatCourant); tic()
    })
  }
})()
</script>
</body>
</html>`
}
