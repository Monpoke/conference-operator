import { TAILWIND_CSS } from '@cloudnord/ui'

import { OBS_ANTENNE_CSS, OBS_ANTENNE_JS } from './obs-browser.js'

/**
 * Bandeau superposé aux scènes live.
 *
 * Deuxième surface transparente, distincte de l'habillage de captation, et
 * pour une raison de fond : celle-ci ne dit rien de la conférence, elle porte
 * ce que la console décide de mettre à l'antenne — « on reprend dans 5
 * minutes », « le son est en cours de réparation ». On la pose donc où on veut
 * qu'un message apparaisse, y compris dans la scène `LIVE` d'OBS-A, où les
 * slides du speaker continuent de tourner dessous.
 *
 * Elle n'interrompt rien : c'est toute la différence avec le mode « message »
 * de l'écran de salle, qui prend l'écran entier. Ici le talk continue.
 *
 * Comme l'habillage : fond réellement transparent, tailles en `vh`/`vw` pour
 * suivre le canevas OBS, et aucune animation coûteuse — la page tourne pendant
 * qu'OBS encode.
 */
export interface OverlayLivePageOptions {
  initialPayload?: unknown
}

export function renderOverlayLivePage(options: OverlayLivePageOptions = {}): string {
  const etatInitial =
    options.initialPayload == null
      ? ''
      : `<script id="etat-initial" type="application/json">${JSON.stringify(options.initialPayload).replace(/</g, '\\u003c')}</script>`

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Bandeau live</title>
<style>${TAILWIND_CSS}  ${OBS_ANTENNE_CSS}
</style>
<style>
  /* Fond réellement transparent : OBS compose cette page par-dessus la vidéo. */
  html, body { height: 100%; background: transparent; overflow: hidden; }

  /*
   * Deux présentations, choisies dans l'adresse de la source OBS.
   *
   * ?style=encart pose une carte en bas à droite, faite pour passer par-dessus
   * des slides sans manger leur contenu ; sans paramètre, un bandeau en haut,
   * plus discret sur un plan de caméra. Le choix appartient à la scène — la
   * même page sert les deux, et rien ne change à l'exécution.
   */
  #place { position: absolute; }
  body[data-style="bandeau"] #place { top: 6vh; left: 50%; transform: translateX(-50%); max-width: 80vw; }
  body[data-style="encart"] #place { right: 4vw; bottom: 9vh; max-width: 42vw; }
  body[data-style="bandeau"] #libelle { display: none; }

  /*
   * Rien à l'écran tant qu'il n'y a rien à dire.
   *
   * L'apparition passe par une transition d'opacité et de position : une
   * arrivée sèche au milieu d'un plan se voit comme un défaut d'incrustation.
   * Le bandeau descend, l'encart monte — chacun vient du bord dont il est
   * proche.
   */
  #cadre { opacity: 0; transition: opacity .3s ease, transform .3s ease; }
  body[data-style="bandeau"] #cadre { transform: translateY(-1.5vh); }
  body[data-style="encart"] #cadre { transform: translateY(1.5vh); }
  body[data-bandeau="visible"] #cadre { opacity: 1; transform: none; }

  /* Teinte par niveau, posée depuis le script sur le body. */
  body[data-niveau="info"] #cadre { --teinte: var(--color-marque); }
  body[data-niveau="warning"] #cadre { --teinte: var(--color-attention); }
  body[data-niveau="urgent"] #cadre { --teinte: var(--color-alerte); }
</style>
</head>
<body class="font-sans text-white" data-bandeau="masque" data-niveau="info" data-style="bandeau">
${etatInitial}
<div id="place">
  <div id="cadre" class="flex items-stretch drop-shadow-[0_.6vh_1.6vh_rgba(0,0,0,.55)]">
    <div class="w-[.9vh] rounded-l-[.45vh] bg-[var(--teinte)]"></div>
    <div class="rounded-r-[.6vh] bg-[rgba(12,14,22,.88)] px-[2.6vh] py-[1.6vh] backdrop-blur-[2px]">
      <div class="mb-[.6vh] text-[1.7vh] font-semibold tracking-[.12em] text-[var(--teinte)] uppercase" id="libelle">Question du public</div>
      <div class="text-[2.8vh] leading-[1.25] font-semibold" id="texte"></div>
    </div>
  </div>
</div>

<script>
(() => {
  /**
   * Présentation, choisie dans l'adresse de la source OBS.
   *
   * ?style=encart pour une carte par-dessus des slides, rien pour le bandeau.
   * Un paramètre plutôt qu'un réglage : c'est une décision de scène, prise une
   * fois en montant la source, pas un geste de régie en pleine conférence.
   */
  const STYLE = new URLSearchParams(location.search).get('style') === 'encart' ? 'encart' : 'bandeau'
  document.body.dataset.style = STYLE

  /** Durée de la transition, alignée sur le CSS ci-dessus. */
  const TRANSITION_MS = 300
  let affiche = null
  let bascule = null

  /**
   * Change de question **en deux temps**.
   *
   * Remplacer le texte en place donnerait un saut : deux questions de longueurs
   * différentes se substituent d'un coup, et le spectateur ne sait pas si elle
   * a changé ou si elle a toujours été là. On sort l'ancienne, on pose la
   * nouvelle, on la fait entrer.
   */
  function rendre(donnees) {
    // Le titre suit l'événement : rien n'est compilé en dur, le nom vient du
    // hub et reste en cache pour survivre à un démarrage réseau coupé.
    const nomEvenement = donnees.eventIdentity?.name
    if (nomEvenement) document.title = nomEvenement + ' — bandeau live'
    /**
     * Deux channels, une seule place à l'écran.
     *
     * Le bandeau de la console passe devant la question : quand il y en a un,
     * c'est qu'il se passe quelque chose — « on reprend dans 5 minutes » — et
     * ça prime sur la question à laquelle le speaker répondait. La question
     * revient d'elle-même dès que le bandeau est retiré.
     *
     * Cette page est posée dans les scènes d'OBS-A : elle est vue par la salle,
     * pas par la VOD. C'est pour ça qu'elle a le droit de montrer les deux, là
     * où l'habillage de captation ne montre que la question.
     */
    const message = donnees.state.liveMessage
    const question = donnees.state.question
    const bandeau = message != null
      ? { text: message.text, level: message.level, libelle: null }
      : question != null
        ? {
            text: question.text,
            level: 'info',
            libelle: question.author ? 'Question — ' + question.author : 'Question du public',
          }
        : null

    const suivant = bandeau == null ? null : bandeau.level + ' | ' + bandeau.libelle + ' | ' + bandeau.text
    // Rien de nouveau : surtout ne pas rejouer l'animation à chaque état reçu.
    if (suivant === affiche) return

    const premier = affiche == null
    affiche = suivant
    clearTimeout(bascule)

    if (bandeau == null) {
      document.body.dataset.bandeau = 'masque'
      return
    }

    const poser = () => {
      document.body.dataset.niveau = bandeau.level
      // Le libellé annonce une question ; un message d'exploitation se passe
      // d'en-tête, il se lit tel quel.
      const libelle = document.getElementById('libelle')
      libelle.textContent = bandeau.libelle ?? ''
      libelle.hidden = bandeau.libelle == null
      document.getElementById('texte').textContent = bandeau.text
      document.body.dataset.bandeau = 'visible'
    }

    // Rien à l'écran : on entre directement, sans sortie à vide.
    if (premier) { poser(); return }
    document.body.dataset.bandeau = 'masque'
    bascule = setTimeout(poser, TRANSITION_MS)
  }

  // Le flux n'envoie que ce qui change : on garde l'etat courant et on fusionne.
  // Un message complet (a l'ouverture, et apres chaque reconnexion) le remplace.
  let etatCourant = {}
  const embarque = document.getElementById('etat-initial')
  if (embarque) { etatCourant = JSON.parse(embarque.textContent); rendre(etatCourant) }

  if (typeof EventSource !== 'undefined' && !window.__APERCU__) {
    const flux = new EventSource('/display/state?vue=bandeau')
    flux.onmessage = (evenement) => { etatCourant = JSON.parse(evenement.data); rendre(etatCourant) }
    flux.addEventListener("delta", (evenement) => {
      etatCourant = Object.assign({}, etatCourant, JSON.parse(evenement.data))
      rendre(etatCourant)
    })
  }
})()
</script>
<script>${OBS_ANTENNE_JS}</script>
</body>
</html>`
}
