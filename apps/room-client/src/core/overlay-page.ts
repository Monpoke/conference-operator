import { TAILWIND_CSS } from '@cloudnord/ui'

/**
 * Habillage transparent superposé à la captation dans OBS-B.
 *
 * **Tout ce qui est ici part dans le master.** Cette page est une source de la
 * scène d'OBS-B : elle est incrustée dans l'enregistrement et dans le direct.
 * Elle ne porte donc que ce qui a sa place dans une VOD — le titrage du talk
 * et le logo de l'événement. Un témoin d'enregistrement y a figuré : utile à
 * l'opérateur, mais gravé dans la vidéo livrée. Ce repère-là vit en régie,
 * dans le panneau « Captation », où il ne coûte rien à personne.
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

  /*
   * Question du public.
   *
   * Elle **a** sa place dans le master, contrairement au bandeau de la console :
   * une VOD où le speaker répond à une question qu'on n'a jamais lue est
   * incompréhensible. Elle monte de son bord, comme le titrage apparaît du sien.
   */
  #question { opacity: 0; transform: translateY(1.5vh); transition: opacity .35s ease, transform .35s ease; }
  body[data-question="visible"] #question { opacity: 1; transform: none; }
</style>
</head>
<body class="font-sans text-white" data-titrage="masque" data-question="masque">
${etatInitial}
<img id="logo" alt="" class="absolute right-[3vw] top-[5vh] h-[7vh] opacity-90" hidden>

<!--
  Coin opposé au titrage : les deux peuvent être à l'écran en même temps — on
  titre le speaker pendant qu'il répond — et ils ne doivent pas se recouvrir.
-->
<div id="question" class="absolute right-[3vw] bottom-[8vh] flex max-w-[34vw] items-stretch drop-shadow-[0_.6vh_1.6vh_rgba(0,0,0,.55)]">
  <div class="w-[.9vh] rounded-l-[.45vh] bg-[var(--couleur)]"></div>
  <div class="rounded-r-[.6vh] bg-[rgba(12,14,22,.88)] px-[2.2vh] py-[1.4vh] backdrop-blur-[2px]">
    <div class="mb-[.6vh] text-[1.6vh] font-semibold tracking-[.12em] text-[var(--couleur)] uppercase">Question du public</div>
    <div class="text-[2.5vh] leading-[1.25] font-semibold" id="question-texte"></div>
    <div class="mt-[.5vh] text-[1.9vh] text-white/70" id="question-auteur" hidden></div>
  </div>
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
  const texte = (id, valeur) => { document.getElementById(id).textContent = valeur ?? '' }

  function rendre(donnees) {
    const session = donnees.state.currentSession
    const racine = document.documentElement.style

    if (donnees.event?.theme?.color) racine.setProperty('--couleur', donnees.event.theme.color)
    const logo = document.getElementById('logo')
    if (donnees.event?.logoUrl) { logo.src = donnees.event.logoUrl; logo.hidden = false }

    /**
     * Question à l'antenne.
     *
     * Rendue **avant** le titrage et hors de sa condition : elle ne dépend pas
     * qu'un talk soit titrable, et surtout le titrage sort par un retour
     * anticipé — la placer après l'aurait laissée figée sur la question
     * précédente entre deux conférences.
     *
     * Lit la question, et jamais le bandeau de la console : ce qui est ici part
     * dans le master, et les consignes d'exploitation de la console n'ont rien
     * à faire dans une VOD.
     */
    const question = donnees.state.question
    document.body.dataset.question = question == null ? 'masque' : 'visible'
    if (question != null) {
      texte('question-texte', question.text)
      const auteur = document.getElementById('question-auteur')
      auteur.hidden = !question.author
      texte('question-auteur', question.author)
    }

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

  // Le flux n'envoie que ce qui change : on garde l'etat courant et on fusionne.
  // Un message complet (a l'ouverture, et apres chaque reconnexion) le remplace.
  let etatCourant = {}
  const embarque = document.getElementById('etat-initial')
  if (embarque) { etatCourant = JSON.parse(embarque.textContent); rendre(etatCourant) }

  if (typeof EventSource !== 'undefined' && !window.__APERCU__) {
    const flux = new EventSource('/display/state?vue=overlay')
    flux.onmessage = (evenement) => {
      etatCourant = JSON.parse(evenement.data); rendre(etatCourant)
    }
    flux.addEventListener("delta", (evenement) => {
      etatCourant = Object.assign({}, etatCourant, JSON.parse(evenement.data))
      rendre(etatCourant)
    })
  }
})()
</script>
</body>
</html>`
}
