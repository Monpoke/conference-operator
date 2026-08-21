import { TAILWIND_CSS } from '@cloudnord/ui'

/**
 * Habillage transparent superposé à la captation dans OBS-B.
 *
 * Contraintes : fond réellement transparent (la Browser Source compose par
 * dessus la caméra et les slides), aucune animation coûteuse — la page tourne
 * pendant qu'OBS encode —, et une zone de titrage placée hors des tiers
 * habituellement occupés par les slides.
 *
 * **Toutes les tailles sont en `vh`/`vw`, y compris via Tailwind.** L'habillage
 * doit suivre la résolution du canevas OBS : une régie en 720p et une autre en
 * 1080p rendent le même cadrage. Des unités `rem` figeraient la taille du
 * titrage en pixels et le feraient déborder ou rétrécir selon la machine.
 */
export interface OverlayPageOptions {
  initialPayload?: unknown
}

export function renderOverlayPage(options: OverlayPageOptions = {}): string {
  const etatInitial =
    options.initialPayload == null
      ? ''
      : `<script id="etat-initial" type="application/json">${JSON.stringify(options.initialPayload).replace(/</g, '\\u003c')}</script>`

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Cloud Nord — habillage captation</title>
<style>${TAILWIND_CSS}</style>
<style>
  :root { --couleur: #1c71d8; --categorie: #1c71d8; }
  /* Fond réellement transparent : OBS compose cette page par-dessus la vidéo. */
  html, body { height: 100%; background: transparent; overflow: hidden; }

  /* Rien ne s'affiche tant qu'aucun talk n'est en cours. */
  #titrage { opacity: 0; transition: opacity .4s ease; }
  body[data-titrage="visible"] #titrage { opacity: 1; }
  #rec { display: none; }
  body[data-rec="true"] #rec { display: flex; }
</style>
</head>
<body class="font-sans text-white" data-titrage="masque" data-rec="false">
${etatInitial}
<img id="logo" alt="" class="absolute right-[3vw] top-[5vh] h-[7vh] opacity-90" hidden>

<div id="rec" class="absolute left-[3vw] top-[5vh] items-center gap-[1vh] rounded-full bg-black/55 px-[1.6vh] py-[.7vh] text-[2vh] font-medium tabular-nums backdrop-blur-sm">
  <span class="block size-[1.6vh] rounded-full bg-alerte"></span>
  <span id="rec-duree">00:00</span>
</div>

<div id="titrage" class="absolute bottom-[8vh] left-[4vw] flex max-w-[60vw] items-stretch drop-shadow-[0_.6vh_1.6vh_rgba(0,0,0,.55)]">
  <div class="w-[.9vh] rounded-l-[.45vh] bg-[var(--categorie)]"></div>
  <div class="rounded-r-[.6vh] bg-[rgba(12,14,22,.88)] px-[2.4vh] py-[1.6vh] backdrop-blur-[2px]">
    <div class="text-[3.4vh] leading-[1.15] font-bold" id="titre"></div>
    <div class="mt-[.7vh] text-[2.4vh] text-white/80" id="personnes"></div>
    <span class="mt-[1vh] inline-block rounded-[.4vh] bg-[var(--categorie)] px-[1.1vh] py-[.35vh] text-[1.7vh] tracking-[.12em] uppercase" id="categorie" hidden></span>
  </div>
</div>

<script>
(() => {
  let dernier = null

  const texte = (id, valeur) => { document.getElementById(id).textContent = valeur ?? '' }

  function rendre(donnees) {
    dernier = donnees
    const session = donnees.state.currentSession
    const racine = document.documentElement.style

    if (donnees.event?.theme?.color) racine.setProperty('--couleur', donnees.event.theme.color)
    const logo = document.getElementById('logo')
    if (donnees.event?.logoUrl) { logo.src = donnees.event.logoUrl; logo.hidden = false }

    // Pas de talk, ou créneau sans intervenant : rien à titrer.
    const titrable = session != null && session.kind === 'talk'
    document.body.dataset.titrage = titrable ? 'visible' : 'masque'
    if (!titrable) return

    racine.setProperty('--categorie', session.category?.color ?? donnees.event?.theme?.color ?? '#1c71d8')
    texte('titre', session.title)
    texte('personnes', session.speakers.map((s) => s.company ? s.name + ' — ' + s.company : s.name).join(' · '))

    const categorie = document.getElementById('categorie')
    categorie.hidden = session.category == null
    if (session.category) categorie.textContent = session.category.name
  }

  function tic() {
    document.body.dataset.rec = String(dernier?.state.recording === true)
  }
  setInterval(tic, 1000)

  // Le flux n'envoie que ce qui change : on garde l'etat courant et on fusionne.
  // Un message complet (a l'ouverture, et apres chaque reconnexion) le remplace.
  let etatCourant = {}
  const embarque = document.getElementById('etat-initial')
  if (embarque) { etatCourant = JSON.parse(embarque.textContent); rendre(etatCourant); tic() }

  if (typeof EventSource !== 'undefined' && !window.__APERCU__) {
    const flux = new EventSource('/display/state?vue=overlay')
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
