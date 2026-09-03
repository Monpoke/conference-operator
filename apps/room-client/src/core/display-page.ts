import { MACHINE_JS } from '@cloudnord/room-state'
import { TAILWIND_CSS } from '@cloudnord/ui'

import { OBS_ANTENNE_CSS, OBS_ANTENNE_JS } from './obs-browser.js'

/**
 * Page projetée en salle.
 *
 * Contraintes qui expliquent la forme : elle est rendue par la Browser Source
 * d'OBS-A (ou une fenêtre Electron de secours), doit tenir sans étape de build,
 * sans réseau, et rester lisible à dix mètres. D'où du HTML autonome, un
 * `EventSource` qui se reconnecte tout seul, et aucune dépendance externe.
 *
 * **Une exception, et une seule** : le bouton de X sur la slide Réseaux, dont
 * le script est servi par X. Il est chargé en `async`, en dernier, et rien
 * n'en dépend — la slide porte le hashtag en grand, qui reste lisible quand le
 * script ne charge pas. La règle « sans réseau » n'est donc pas levée : elle
 * couvre toujours tout ce qui se lit.
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
<title>Écran de salle</title>
<style>${TAILWIND_CSS}</style>
<style>
  :root { --couleur: #5b7cfa; --secondaire: #22d3ee; --or: #d4a24c; }
  html, body { height: 100%; }

  /* Curseur masqué : la page vit sur un vidéoprojecteur, pas sur un bureau. */
  body { overflow: hidden; cursor: none; }

  /*
   * Halos de marque, dérivés des couleurs de l'événement.
   *
   * Hors Tailwind : deux dégradés radiaux composés avec color-mix, que les
   * utilitaires n'expriment pas, et qui doivent suivre --couleur à chaud.
   *
   * Sur leur propre couche, derrière la scène, parce qu'ils dérivent : une
   * couche qui ne porte qu'un dégradé se déplace sur le GPU sans rien
   * remettre en page de ce qui est écrit par-dessus. Le fond opaque reste sur
   * le body, seul endroit où l'écran est garanti peint.
   */
  #halo {
    background:
      radial-gradient(120vmax 90vmax at 12% -10%, color-mix(in srgb, var(--couleur) 38%, transparent), transparent 60%),
      radial-gradient(90vmax 70vmax at 110% 110%, color-mix(in srgb, var(--secondaire) 32%, transparent), transparent 60%);
    animation: derive 44s ease-in-out infinite;
    will-change: transform;
  }

  /*
   * Dérive du fond.
   *
   * Quarante-quatre secondes pour un aller-retour : à cette vitesse le
   * mouvement ne se remarque pas, mais l'écran cesse d'être une image fixe.
   * Une pause dure vingt minutes, et un vidéoprojecteur qui ne bouge pas du
   * tout finit par se lire comme un poste éteint sur une image.
   */
  @keyframes derive {
    0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
    50% { transform: translate3d(2.5vmin, -2vmin, 0) scale(1.07); }
  }

  /*
   * Palier de tête, en doré.
   *
   * Une couleur qui ne vient pas du thème de l'événement, et c'est voulu : la
   * marque habille l'écran, l'or dit le rang. Les deux ne disaient pas la même
   * chose et se confondaient quand le bandeau reprenait --couleur — le palier
   * qui a payé le plus cher se lisait alors comme un encadré de plus.
   *
   * Il habille le **premier** palier, pas celui qui s'appelle « Gold ». Le nom
   * peut changer d'une édition à l'autre, le rang non.
   */
  .palier-tete {
    border-color: color-mix(in srgb, var(--or) 62%, transparent);
    border-width: .28vmin;
    background: linear-gradient(160deg,
      color-mix(in srgb, var(--or) 30%, transparent),
      color-mix(in srgb, var(--or) 10%, transparent) 70%);
    /* Arête haute éclairée, et un halo qui décolle le bandeau du fond. */
    box-shadow:
      inset 0 .2vmin 0 color-mix(in srgb, var(--or) 75%, transparent),
      0 0 4vmin color-mix(in srgb, var(--or) 12%, transparent);
  }
  .palier-tete .intitule {
    color: color-mix(in srgb, var(--or) 92%, #fff);
    text-shadow: 0 0 1.4vmin color-mix(in srgb, var(--or) 45%, transparent);
  }

  /*
   * Couches empilées : la page suivante pousse la précédente.
   *
   * La sortante part vers la gauche pendant que l'entrante arrive par la
   * droite, a la meme vitesse et sur la meme courbe. A tout instant elles sont
   * exactement adjacentes : rien ne se recouvre, jamais. Les deux occupent la
   * meme case, d'ou le positionnement absolu, et le cadre les clippe.
   *
   * C'est un remplacement du fondu enchaine qui etait la avant, et qui laissait
   * lire les deux slides en meme temps : ses deux courbes montaient dans le
   * meme sens au pire moment — une entree en ease-out raide (67 % en un
   * cinquieme de sa duree) pendant que la sortie en ease-in s'attardait encore
   * a 87 %. Au pic, les deux pages etaient visibles a plus de 80 % chacune.
   * Mesure a 0,838 en calcul, 0,836 en relevé.
   *
   * Meme duree ET meme courbe pour les deux : un ecart ouvre un vide entre les
   * couches, ou les fait se chevaucher.
   *
   * Seul transform est anime, la propriete que le compositeur traite sans
   * repasser par la mise en page — et une translation lui coute moins cher que
   * la recomposition de deux couches translucides. C'est ce qui tient dans une
   * Browser Source OBS en 4K.
   */
  .calque { animation: entree .55s cubic-bezier(.4, 0, .2, 1) both; }
  .calque.sortante { animation: sortie .55s cubic-bezier(.4, 0, .2, 1) both; pointer-events: none; }
  @keyframes entree {
    from { transform: translateX(100%); }
    to { transform: none; }
  }
  @keyframes sortie {
    from { transform: none; }
    to { transform: translateX(-100%); }
  }

  /*
   * Entrée en cascade.
   *
   * Une liste qui apparaît d'un bloc se lit comme un rafraîchissement ; la même
   * liste dont les lignes arrivent l'une après l'autre se lit comme quelque
   * chose qu'on est en train de vous montrer. Le pas se règle par élément
   * parent : vingt-sept créneaux de programme ont besoin d'un pas plus court
   * que quatre cartes.
   *
   * Le decalage est lateral, et non vertical comme il l'etait : la page entiere
   * arrive maintenant par la droite, et des lignes qui monteraient pendant que
   * leur cadre glisse feraient deux gestes au lieu d'un. Elles trainent donc
   * derriere la poussee et se posent apres elle.
   */
  .cascade > * {
    animation: poser .5s cubic-bezier(.22, 1, .36, 1) both;
    animation-delay: calc(var(--pas, 55ms) * var(--i, 0));
  }
  @keyframes poser {
    from { opacity: 0; transform: translateX(3vmin); }
    to { opacity: 1; transform: none; }
  }

  /*
   * Cartes : elles se posent au lieu de glisser.
   *
   * Une carte encadree qui arrive en glissant se lit comme une ligne de liste ;
   * la meme avec un soupcon d'echelle se lit comme un objet qui se pose.
   *
   * Reserve aux listes de cartes, et c'est tout l'interet d'un modificateur a
   * poser a la main : sur vingt-sept lignes de programme, vingt-sept changements
   * d'echelle feraient du bruit, pas un effet.
   */
  .cascade.cartes > * {
    animation-name: poser-carte;
  }
  @keyframes poser-carte {
    from { opacity: 0; transform: translateX(2vmin) scale(.965); }
    to { opacity: 1; transform: none; }
  }

  /*
   * Le creneau en cours se pose en dernier, et d'un peu plus loin.
   *
   * Rien de clignotant ni de repetitif : il vient de la meme direction que ses
   * voisins, un peu plus lentement et d'un peu plus loin. L'oeil suit le dernier
   * mouvement, et le dernier mouvement est celui qui dit ou on en est de la
   * journee. La mise en avant permanente — fond teinte, barre d'accroche — reste
   * ce qu'elle etait ; ceci ne joue qu'a l'arrivee de la page.
   */
  .cascade > .en-cours {
    animation-name: poser-en-cours;
    animation-duration: .72s;
  }
  @keyframes poser-en-cours {
    from { opacity: 0; transform: translateX(6vmin); }
    to { opacity: 1; transform: none; }
  }

  /*
   * Défilement du programme.
   *
   * La journée fait deux à trois fois la hauteur de l'écran. Plutôt que de
   * sauter sur le créneau en cours et de s'y arrêter, la liste part de là et
   * glisse vers la suite pendant que la page est affichée. Les deux paliers
   * laissent le temps de lire avant et après le mouvement.
   *
   * En translation, pas en scrollTop : le défilement natif repasse par la mise
   * en page à chaque image, la translation non.
   */
  .defilant { overflow: hidden; }
  .defile {
    animation-name: defile;
    animation-timing-function: cubic-bezier(.4, 0, .2, 1);
    animation-fill-mode: both;
  }
  @keyframes defile {
    0%, 14% { transform: translateY(var(--depart)); }
    86%, 100% { transform: translateY(var(--arrivee)); }
  }

  /*
   * Repère de progression.
   *
   * Le point actif se remplit sur la durée de la page : c'est la seule chose à
   * l'écran qui dise *quand* ça va changer. Le décalage négatif reprend la
   * jauge là où elle en est, pour qu'un état reçu en milieu de page ne la
   * fasse pas repartir de zéro.
   */
  .point {
    display: block;
    height: .7vmin;
    width: .7vmin;
    border-radius: 999px;
    background: rgb(255 255 255 / .25);
    transition: width .45s cubic-bezier(.22, 1, .36, 1);
  }
  .point.actif {
    position: relative;
    width: 4vmin;
    overflow: hidden;
    background: rgb(255 255 255 / .18);
  }
  .point.actif::after {
    content: '';
    position: absolute;
    inset: 0;
    background: var(--couleur);
    transform-origin: left;
    animation: remplir var(--duree, 12000ms) linear both;
    animation-delay: calc(-1 * var(--ecoule, 0ms));
  }
  @keyframes remplir {
    from { transform: scaleX(0); }
    to { transform: scaleX(1); }
  }

  /* Battement du compte à rebours, relancé à chaque seconde. */
  .bat { animation: bat .5s ease-out; }
  @keyframes bat {
    from { transform: scale(1.035); }
    to { transform: scale(1); }
  }

  /* État réseau : discret, informatif, jamais alarmant pour le public. */
  .etat-libelle { display: none; }
  body[data-connectivite="OFFLINE"] .etat-hors-ligne { display: inline; }
  body[data-connectivite="DEGRADED"] .etat-degrade { display: inline; }

  /*
   * En direct, l'écran s'efface : c'est la capture HDMI qui occupe la scène.
   *
   * En fondu, et non d'un coup : la bascule se fait devant la salle, et une
   * disparition instantanée se lit comme une coupure de signal.
   */
  header, footer, main { transition: opacity .45s ease; }
  body[data-mode="live"] { background: #000; }
  body[data-mode="live"] #halo { opacity: 0; }
  body[data-mode="live"] header,
  body[data-mode="live"] footer,
  body[data-mode="live"] main { opacity: 0; }

  /*
   * Poste réglé sur mouvement réduit : on garde les états, pas les trajets.
   * Ne concerne pas le vidéoprojecteur, mais bien les machines d'où l'on
   * relit ces pages.
   */
  ${OBS_ANTENNE_CSS}

  @media (prefers-reduced-motion: reduce) {
    *, *::after {
      animation-duration: .01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: .01ms !important;
    }
  }
</style>
</head>
<body class="bg-fond font-sans text-texte" data-mode="sponsors" data-connectivite="OFFLINE">
${etatInitial}
<div id="halo" class="pointer-events-none absolute inset-0"></div>
<div id="scene" class="absolute inset-0 flex flex-col gap-[3vmin] p-[4.5vmin]">
  <header class="flex flex-none items-center justify-between gap-[2vmin]">
    <img id="logo" alt="" data-logo class="h-[7vmin] max-w-[30vw] object-contain" hidden>
    <div class="flex items-center gap-[1.6vmin]">
      <!--
        Le créneau commun, annoncé sur l'écran de la salle.

        L'habillage bascule en boucle d'attente pendant une pause, ce qui ne dit
        pas *pourquoi* : un participant entré au milieu ne sait pas s'il a raté
        le talk ou si tout le monde déjeune. L'étiquette le dit, et l'annonce un
        quart d'heure avant, pendant que la conférence se termine encore.
      -->
      <span class="rounded-[.6vmin] bg-white/10 px-[1.4vmin] py-[.5vmin] text-[2vmin] tracking-[.14em] uppercase"
            id="etiquette-break" hidden></span>
      <div class="text-[2.6vmin] tracking-[.16em] text-attenue uppercase" id="nom-salle"></div>
    </div>
  </header>

  <!--
    Pile de couches : la page sortante y reste le temps de sortir du cadre.

    overflow-hidden n'est pas decoratif : sans lui, la couche qui glisse
    deborde sur l'en-tete et le pied de page au lieu d'etre coupee au bord.
  -->
  <main id="contenu" class="relative flex min-h-0 flex-1 flex-col overflow-hidden"></main>

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

<!--
  L'automate, inliné comme dans la régie et la console.

  L'écran n'a besoin que de la fin effective d'un créneau, mais il la déduisait
  à sa façon — et sa façon était fausse pour un créneau que l'export ne borne
  que par une durée.
-->
<script>${MACHINE_JS}</script>

<!--
  L'état de la scène OBS, avant tout le reste : la page doit savoir si elle est
  à l'antenne dès sa première image, pas après le premier changement de scène.
-->
<script>${OBS_ANTENNE_JS}</script>

<script>
(() => {
  const contenu = document.getElementById('contenu')
  let dernier = null
  // Ce qui est actuellement à l'écran : sert à décider d'une transition.
  let modeAffiche = null
  let rangAffiche = -1

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
    /*
     * Posé une seule fois par URL.
     *
     * Le détourage remplace ensuite la source par l'image recadrée ; réaffecter
     * l'originale à chaque état reçu la ferait réapparaître non détourée le
     * temps d'une image.
     */
    const logo = document.getElementById('logo')
    if (evenement.logoUrl && logo.dataset.source !== evenement.logoUrl) {
      logo.dataset.source = evenement.logoUrl
      logo.src = evenement.logoUrl
      logo.hidden = false
    }
  }

  /**
   * Détourage automatique des logos.
   *
   * Les logos arrivent tels que les sponsors les ont déposés : certains sont
   * cadrés au plus près, d'autres flottent au milieu d'une grande marge. Posés
   * côte à côte à hauteur égale, les seconds paraissent deux fois plus petits —
   * ce n'est pas une question de taille, c'est du vide qu'on affiche à leur
   * place. On mesure donc l'encre et on recadre dessus.
   *
   * Le calcul n'est possible que parce que les images du cache sont servies par
   * le client lui-même, sur /assets : un logo encore distant — cache pas
   * encore rempli — invalide le canvas, la lecture lève, et on garde l'image
   * telle quelle. C'est aussi ce qui se passe hors navigateur.
   *
   * Une seule fois par URL : le résultat est gardé, et la page repasse toutes
   * les cinquante secondes.
   */
  const detoures = new Map()

  /** Le pixel est-il du fond ? Transparent, ou blanc — et rien d'autre. */
  const estFond = (d, i) => d[i + 3] < 16 || (d[i] > 244 && d[i + 1] > 244 && d[i + 2] > 244)

  /**
   * Recadre sur l'encre, et renvoie une image ou rien.
   *
   * Seuls les fonds transparents ou blancs sont rognés. Un logo posé sur un
   * aplat de couleur — le carré bleu d'AXA, le violet de HoppR — a cet aplat
   * pour marque : le resserrer sur le texte qu'il contient abîmerait le logo
   * au lieu de le servir. Les quatre coins doivent donc être du fond, sinon on
   * ne touche à rien.
   */
  function recadrer(img) {
    const large = img.naturalWidth
    const haut = img.naturalHeight
    if (!large || !haut) return null

    const toile = document.createElement('canvas')
    const pinceau = toile.getContext && toile.getContext('2d')
    if (!pinceau || !pinceau.getImageData) return null
    toile.width = large
    toile.height = haut
    pinceau.drawImage(img, 0, 0)

    // Lève si l'image vient d'une autre origine : c'est le cas nominal quand le
    // cache d'assets n'a pas encore le logo.
    let pixels
    try { pixels = pinceau.getImageData(0, 0, large, haut).data } catch (_) { return null }

    const coins = [0, (large - 1) * 4, (haut - 1) * large * 4, (haut * large - 1) * 4]
    if (!coins.every((i) => estFond(pixels, i))) return null

    let x1 = large, y1 = haut, x2 = -1, y2 = -1
    for (let y = 0; y < haut; y += 1) {
      for (let x = 0; x < large; x += 1) {
        if (estFond(pixels, (y * large + x) * 4)) continue
        if (x < x1) x1 = x
        if (x > x2) x2 = x
        if (y < y1) y1 = y
        if (y > y2) y2 = y
      }
    }
    if (x2 < x1 || y2 < y1) return null

    const l = x2 - x1 + 1
    const h = y2 - y1 + 1
    // Rien à gagner, ou trop à perdre : une encre qui ne couvre presque rien
    // trahit un seuil mal choisi plutôt qu'un logo minuscule.
    if (l > large * 0.97 && h > haut * 0.97) return null
    if (l * h < large * haut * 0.02) return null

    const coupe = document.createElement('canvas')
    coupe.width = l
    coupe.height = h
    coupe.getContext('2d').drawImage(img, x1, y1, l, h, 0, 0, l, h)
    return coupe.toDataURL('image/png')
  }

  /** Détoure les logos d'une couche, une fois chacun, sans jamais lever. */
  function detourerLogos(calque) {
    for (const img of calque ? calque.querySelectorAll('img[data-logo]') : []) {
      const source = img.getAttribute('src')
      if (!source || source.startsWith('data:')) continue

      const connu = detoures.get(source)
      if (connu !== undefined) { if (connu) img.src = connu; continue }

      const mesurer = () => {
        let recadre = null
        try { recadre = recadrer(img) } catch (_) { recadre = null }
        detoures.set(source, recadre)
        if (recadre) img.src = recadre
      }
      if (img.complete && img.naturalWidth > 0) mesurer()
      else img.addEventListener('load', mesurer, { once: true })
    }
  }

  /**
   * Identité d'un sponsor, d'un palier à l'autre.
   *
   * L'export amont donne un identifiant **par palier** : « ape factory », qui a
   * pris trois packs, en porte trois différents. Le site est la seule chose qui
   * ne bouge pas d'une ligne à l'autre ; le nom sert de repli pour les rares
   * sponsors qui n'en déclarent pas.
   */
  // La barre finale passe par une classe de caractères : dans un gabarit
  // littéral, une barre échappée s'évanouit avant d'atteindre le navigateur, et
  // la regex qui reste ne compile plus.
  const cleSponsor = (s) =>
    (s.website || s.name || '').trim().toLowerCase().replace(/[/]+$/, '')

  /**
   * Les partenaires, en podium.
   *
   * Le premier palier est celui qui a payé le plus cher — les paliers arrivent
   * déjà triés par rang. Il prend donc le haut de l'écran, en grand, seul sur
   * sa surface : c'est ce qu'on lui a vendu.
   *
   * Tout le reste est fondu en une rangée où chaque sponsor n'apparaît
   * **qu'une fois**, avec la liste de ce qu'il a pris. Auparavant le même logo
   * revenait à l'identique à trois lignes d'écart : projeté, un logo répété se
   * lit comme un défaut d'affichage, pas comme de la générosité. Ceux qui se
   * sont engagés sur plusieurs fronts y sont plus grands et encadrés de la
   * couleur de marque — c'est la donnée qui le décide, pas une liste de noms
   * écrite ici, qui serait fausse à la première édition suivante.
   */
  function rendreSponsors(donnees) {
    const tiers = donnees.sponsorTiers.filter((t) => t.sponsors.length > 0)
    if (tiers.length === 0) return '<div class="' + TITRE_MODE + '">Merci à nos partenaires</div>'

    const tete = tiers[0]
    const parSponsor = new Map()
    for (const tier of tiers.slice(1)) {
      for (const sponsor of tier.sponsors) {
        const connu = parSponsor.get(cleSponsor(sponsor))
        if (connu) connu.paliers.push(tier.name)
        else parSponsor.set(cleSponsor(sponsor), { sponsor, paliers: [tier.name] })
      }
    }
    // Le plus engagé en premier : c'est celui qu'on met en avant, et le tri de
    // JavaScript est stable, donc les autres gardent l'ordre des paliers.
    const engages = [...parSponsor.values()].sort((a, b) => b.paliers.length - a.paliers.length)
    const surTousLesFronts = engages.some((e) => e.paliers.length > 1)

    // L'écran ne s'étire pas : au-delà d'une poignée de logos, tout rétrécit
    // d'un cran plutôt que de déborder sous le pied de page.
    const dense = tete.sponsors.length > 5 || engages.length > 5

    /**
     * Un logo sur sa pastille blanche.
     *
     * La largeur est bornée par l'appelant, pas ici : dans le bandeau c'est
     * l'écran qui limite, dans une carte c'est la carte. Un logo très allongé —
     * celui d'ape factory fait cinq fois sa hauteur — sortait sinon de son
     * cadre par les deux côtés.
     */
    const pastille = (sponsor, hauteur, largeur, rang) => sponsor.logoUrl
      ? '<img src="' + echapper(sponsor.logoUrl) + '" alt="' + echapper(sponsor.name) + '"' +
        ' data-logo style="--i:' + rang + '" class="' + hauteur + ' ' + largeur + ' rounded-[1.2vmin] bg-white' +
        ' object-contain px-[2vmin] py-[1.4vmin] drop-shadow-[0_.4vmin_1.2vmin_rgba(0,0,0,.45)]">'
      : '<span style="--i:' + rang + '" class="text-[3.2vmin] font-semibold">' +
        echapper(sponsor.name) + '</span>'

    const bande =
      '<section class="palier-tete rounded-[2vmin] border px-[4vmin] py-[3vmin]">' +
      '<div class="intitule mb-[2.2vmin] text-center text-[2.4vmin] tracking-[.2em] uppercase">' +
      echapper(tete.name) + '</div>' +
      '<div class="cascade cartes flex flex-wrap items-center justify-center gap-[3vmin]" style="--pas:70ms">' +
      tete.sponsors.map((s, rang) =>
        pastille(s, dense ? 'h-[10vmin]' : 'h-[13vmin]', 'max-w-[24vw]', rang)).join('') +
      '</div></section>'

    if (engages.length === 0) return '<div class="' + TITRE_MODE + '">Nos partenaires</div>' + bande

    const rangee = engages.map((engage, rang) => {
      const vedette = engage.paliers.length > 1
      /**
       * Même hauteur de logo pour toute la rangée, et même rembourrage vertical.
       *
       * La hiérarchie est portée par le cadre — largeur, liseré de marque,
       * teinte — pas par la taille du logo. Faire maigrir celui qui a pris un
       * seul pack cassait la ligne : les pastilles ne partageaient plus ni haut
       * ni bas, et les légendes flottaient à des hauteurs différentes. Une
       * rangée de partenaires se lit comme une étagère, ou ne se lit pas.
       */
      const cadre = vedette
        ? 'border-[color-mix(in_srgb,var(--couleur)_50%,transparent)] bg-[color-mix(in_srgb,var(--couleur)_14%,transparent)] px-[3vmin] py-[2.2vmin]'
        : 'border-white/10 bg-white/5 px-[2.4vmin] py-[2.2vmin]'
      const hauteur = dense ? 'h-[6.5vmin]' : 'h-[8vmin]'
      // Largeur fixe : les cartes s'alignent, et la rangée cesse de dépendre de
      // la longueur du nom des packs.
      const large = vedette ? 'w-[38vmin]' : 'w-[27vmin]'
      return '<article style="--i:' + rang + '" class="flex ' + large + ' flex-col items-center' +
        ' gap-[1.4vmin] rounded-[1.6vmin] border text-center ' + cadre + '">' +
        pastille(engage.sponsor, hauteur, 'max-w-full', 0) +
        '<div class="text-[2vmin] leading-snug text-attenue">' +
        echapper(engage.paliers.join(' · ')) + '</div></article>'
    }).join('')

    return '<div class="' + TITRE_MODE + '">Nos partenaires</div>' + bande +
      '<section class="mt-[3.5vmin]">' +
      '<div class="mb-[2vmin] text-[2.4vmin] tracking-[.2em] text-attenue uppercase">' +
      (surTousLesFronts ? 'Et sur tous les fronts' : 'Et aussi') + '</div>' +
      '<div class="cascade cartes flex flex-wrap items-stretch justify-center gap-[2.5vmin]" style="--pas:70ms">' +
      rangee + '</div></section>'
  }

  function rendreProgramme(donnees) {
    const maintenant = Date.now() + (donnees.state.serverTimeOffsetMs || 0)
    const encours = donnees.state.currentSession?.id
    /**
     * Ce que la salle doit trouver en premier : ce qui se passe, ou à défaut
     * ce qui arrive. Entre deux talks, currentSession est vide — c'est
     * justement le moment où l'on cherche l'heure du suivant.
     *
     * « repere » est une accroche, pas du style : rendre() s'en sert pour
     * amener la ligne au centre.
     */
    const repere = encours ?? donnees.state.nextSession?.id
    if (donnees.sessions.length === 0) return '<div class="' + TITRE_MODE + '">Programme indisponible</div>'

    /**
     * Le cadre porte le débordement, la liste porte la translation.
     *
     * Deux niveaux et non un : c'est la liste entière qui glisse, et elle ne
     * peut le faire que si quelque chose au-dessus d'elle coupe ce qui sort.
     */
    return '<div class="' + TITRE_MODE + '">Programme de la salle</div>' +
      '<div class="defilant min-h-0 flex-1">' +
      '<div class="cascade flex flex-col gap-[1.1vmin]" style="--pas:25ms">' +
      donnees.sessions.map((session, rang) => {
        /**
         * La fin effective, pas l'heure de fin brute.
         *
         * Sans repli sur la durée ni sur le créneau suivant, un talk que
         * l'export ne borne que par sa durée était grisé dès son heure de
         * début : la salle lisait « passé » sur la conférence en train de se
         * jouer. Rend null pour un créneau que rien ne ferme, qu'on préfère ne
         * pas griser du tout.
         */
        const fin = RoomState.effectiveEndAt(donnees.sessions, rang)
        // Une seule mise en avant possible : en cours, sinon passée, sinon à venir.
        const etat = session.id === encours
          ? "en-cours bg-[color-mix(in_srgb,var(--couleur)_26%,transparent)] shadow-[inset_.5vmin_0_0_var(--couleur)]"
          : fin != null && fin < maintenant ? "opacity-35" : ""
        const pause = session.kind === 'break' ? "opacity-55" : ""
        const heureTeinte = session.id === encours ? "text-texte" : "text-attenue"
        const intervenants = session.speakers.map((s) =>
          s.company ? \`\${s.name} — \${s.company}\` : s.name).join(' · ')
        const accroche = session.id === repere ? 'repere' : ''
        return \`<article style="--i:\${rang}" class="\${accroche} grid grid-cols-[15vmin_1fr] items-baseline gap-[2.5vmin] rounded-[1.2vmin] px-[2vmin] py-[1.4vmin] \${etat} \${pause}">
          <div class="text-[2.8vmin] tabular-nums \${heureTeinte}">\${heure(session.startsAt, donnees.timezone)}</div>
          <div>
            <div class="text-[3vmin] font-semibold">\${echapper(session.title)}</div>
            \${intervenants ? \`<div class="mt-[.4vmin] text-[2.2vmin] text-attenue">\${echapper(intervenants)}</div>\` : ''}
          </div>
        </article>\`
      }).join('') + '</div></div>'
  }

  /**
   * Compte à rebours : le squelette seulement.
   *
   * Les chiffres sont laissés vides et remplis par majCompte(). C'est ce qui
   * permet à l'écran de vivre : tant que ce html ne change pas, le mémo de
   * rendre() ne reconstruit rien, et une animation posée sur les chiffres
   * survit d'une seconde à l'autre. L'ancienne version réécrivait tout le bloc
   * à chaque seconde, ce qui interdisait toute animation par construction.
   */
  function rendreCompte(donnees) {
    const suivante = donnees.state.nextSession
    if (!suivante) return '<div class="text-center"><div class="text-[3.4vmin] text-attenue">Fin des interventions</div></div>'
    return '<div class="text-center">' +
      '<div class="cd-chiffres text-[22vmin] leading-none font-bold tabular-nums">' +
      '<span class="cd-min">--</span>:<span class="cd-sec">--</span></div>' +
      // Balayage d'une minute : sans instant de début de pause, c'est le seul
      // repère honnête — et il suffit à montrer que le temps passe.
      '<div class="mx-auto mt-[3vmin] h-[.8vmin] w-[40vmin] overflow-hidden rounded-full bg-white/15">' +
      '<div class="cd-arc h-full w-full origin-left rounded-full bg-[var(--couleur)] transition-transform duration-1000 ease-linear"></div></div>' +
      '<div class="mt-[2.5vmin] text-[3.4vmin] text-attenue">Reprise — ' + echapper(suivante.title) + '</div></div>'
  }

  /** Les valeurs du compte à rebours, écrites sans toucher à la structure. */
  let derniereSeconde = null
  function majCompte(donnees) {
    const calque = contenu.querySelector('.calque:not(.sortante)')
    const min = calque?.querySelector('.cd-min')
    const suivante = donnees.state.nextSession
    if (!min || !suivante) return

    const maintenant = Date.now() + (donnees.state.serverTimeOffsetMs || 0)
    const reste = Math.max(0, suivante.startsAtMs - maintenant)
    const secondes = Math.floor((reste % 60000) / 1000)
    min.textContent = String(Math.floor(reste / 60000)).padStart(2, '0')
    calque.querySelector('.cd-sec').textContent = String(secondes).padStart(2, '0')

    /**
     * La barre se vide sur la minute en cours.
     *
     * Un compte à rebours qui se remplit dit le contraire de ce qu'il compte.
     * Au passage à zéro elle remonte d'un coup : sans couper la transition, ce
     * retour se lirait comme une seconde qui recule.
     */
    const arc = calque.querySelector('.cd-arc')
    if (arc) {
      arc.style.transitionDuration = derniereSeconde !== null && secondes > derniereSeconde ? '0s' : ''
      arc.style.transform = 'scaleX(' + secondes / 60 + ')'
    }

    // Battement relancé à la main : réassigner la classe ne suffit pas, il faut
    // que le navigateur ait recalculé entre le retrait et la repose.
    if (secondes !== derniereSeconde) {
      derniereSeconde = secondes
      const chiffres = calque.querySelector('.cd-chiffres')
      chiffres.classList.remove('bat')
      void chiffres.offsetWidth
      chiffres.classList.add('bat')
    }
  }

  /**
   * QR OpenFeedback du talk en cours.
   *
   * Affiché en fin de conférence, pendant que le public est encore assis :
   * c'est le seul moment où l'on obtient des retours, et un lien dicté à voix
   * haute n'est jamais scanné.
   */
  function rendreFeedback(donnees) {
    const session = donnees.state.currentSession
    const feedback = donnees.feedback
    if (feedback == null || !feedback.qrSvg) {
      return '<div class="' + TITRE_MODE + '">Aucune conférence à noter</div>'
    }

    return '<div class="' + TITRE_MODE + '">Votre avis sur cette conférence</div>' +
      '<div class="flex items-center justify-center gap-[6vmin]">' +
      '<div class="rounded-[1.4vmin] bg-white p-[1.4vmin] [&>svg]:h-[34vmin] [&>svg]:w-[34vmin]">' +
      feedback.qrSvg + '</div>' +
      '<div class="max-w-[46vmin]">' +
      (session ? '<div class="text-[3.6vmin] leading-snug font-semibold">' + echapper(session.title) + '</div>' : '') +
      '<div class="mt-[2vmin] text-[2.8vmin] leading-relaxed text-attenue">' +
      'Scannez pour noter la conférence et laisser un commentaire aux speakers.</div></div></div>'
  }

  /**
   * Question du public, choisie en régie.
   *
   * Même donnée que sur les deux overlays — une seule sélection, trois
   * surfaces : incrustée dans la captation, petite par-dessus la vidéo de
   * salle, ou en grand devant le public. Elles ne servent pas au même moment,
   * et l'opérateur choisit lesquelles.
   *
   * Lit la question, jamais le bandeau de la console : celui-ci a son propre
   * mode d'écran, et les confondre projetait « on reprend dans 5
   * minutes » sous le titre « Question du public ».
   */
  function rendreQuestion(donnees) {
    const question = donnees.state.question
    if (question == null) {
      return '<div class="' + TITRE_MODE + '">Aucune question affichée</div>'
    }
    // Aucune animation posée ici : la couche entière entre à chaque réécriture,
    // et le rendu n'est réécrit que s'il diffère. Une question qui change est
    // donc déjà annoncée — en poser une seconde par-dessus faisait bouger le
    // texte deux fois pour un seul événement.
    return '<div class="' + TITRE_MODE + '">Question du public</div>' +
      '<div class="max-w-[80vmin] text-[6vmin] leading-snug font-semibold">' +
      echapper(question.text) + '</div>' +
      (question.author
        ? '<div class="mt-[2vmin] text-[3vmin] text-attenue">' + echapper(question.author) + '</div>'
        : '')
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
      : messages.map((message, rang) =>
          '<div class="' + carte + '" style="--i:' + rang + '">' +
          '<div class="mb-[.6vmin] text-[2.1vmin] text-attenue">' + echapper(message.author) + '</div>' +
          '<div class="text-[2.9vmin] leading-snug">' + echapper(message.text) + '</div></div>').join('')

    return '<div class="' + TITRE_MODE + '">Vos messages</div>' +
      '<div class="grid h-full grid-cols-[1fr_26vmin] items-start gap-[4vmin]">' +
      '<div class="cascade flex flex-col gap-[1.6vmin] overflow-hidden">' + corps + '</div>' + colonne + '</div>'
  }

  /**
   * Ce qui se joue à côté.
   *
   * La seule information qu'un participant assis dans cette salle ne peut pas
   * deviner : les deux autres tracks tournent en même temps, et changer de
   * salle entre deux talks se décide en trente secondes, pendant la pause.
   */
  function rendreAutresSalles(donnees) {
    const salles = (donnees.otherRooms ?? []).filter((salle) => salle.session != null)
    if (salles.length === 0) return '<div class="' + TITRE_MODE + '">Pendant ce temps…</div>'

    return '<div class="' + TITRE_MODE + '">Pendant ce temps, à côté</div>' +
      '<div class="cascade cartes grid gap-[2.5vmin] ' +
      (salles.length > 2 ? 'grid-cols-2' : 'grid-cols-1') + '">' +
      salles.map((salle, rang) => \`<article style="--i:\${rang}" class="rounded-[1.6vmin] border border-white/10 bg-white/5 px-[3vmin] py-[2.4vmin]">
        <div class="flex items-baseline justify-between gap-[2vmin]">
          <div class="text-[2.6vmin] tracking-[.14em] text-attenue uppercase">\${echapper(salle.name)}</div>
          <div class="text-[2.4vmin] tabular-nums \${salle.enCours ? 'text-[var(--couleur)]' : 'text-attenue'}">\${
            salle.enCours ? 'en ce moment' : heure(salle.session.startsAt, donnees.timezone)}</div>
        </div>
        <div class="mt-[1.2vmin] text-[3.2vmin] leading-snug font-semibold">\${echapper(salle.session.title)}</div>
        \${salle.session.speakers.length > 0
          ? \`<div class="mt-[.8vmin] text-[2.4vmin] text-attenue">\${echapper(salle.session.speakers.join(' · '))}</div>\`
          : ''}
      </article>\`).join('') + '</div>'
  }

  /**
   * Les comptes de l'événement, et le hashtag.
   *
   * Réglés sur le hub et descendus au sync : l'export amont ne porte que les
   * réseaux des speakers. Le handle est écrit en grand parce que c'est ce qu'on
   * retape sur son téléphone depuis le fond de la salle — l'URL, elle, ne se
   * recopie pas.
   *
   * **La carte du hashtag est écrite en dur**, contrairement aux comptes : elle
   * porte le bouton officiel de X, dont le script vit chez
   * \`platform.x.com\` (voir la note en bas de page). Le hashtag en grand est ce
   * qui reste quand ce script ne charge pas — c'est-à-dire hors ligne, c'est-à-
   * dire tous les cas pour lesquels cette page est bâtie. Le bouton se pose
   * dessus quand il peut ; il ne porte jamais la lisibilité de la slide.
   */
  function rendreReseaux(donnees) {
    const liens = donnees.socialLinks ?? []
    const nom = nomCourt(donnees)
    const cartes = liens.map((lien, rang) => \`<article style="--i:\${rang}" class="rounded-[1.6vmin] border border-white/10 bg-white/5 px-[4vmin] py-[3vmin] text-center">
        <div class="text-[2.4vmin] tracking-[.16em] text-attenue uppercase">\${echapper(lien.network)}</div>
        <div class="mt-[1.2vmin] text-[4.2vmin] leading-none font-bold">\${echapper(lien.handle)}</div>
      </article>\`).join('')

    const hashtag = \`<article style="--i:\${liens.length}" class="rounded-[1.6vmin] border border-white/10 bg-white/5 px-[4vmin] py-[3vmin] text-center">
        <div class="text-[2.4vmin] tracking-[.16em] text-attenue uppercase">X</div>
        <div class="mt-[1.2vmin] text-[4.2vmin] leading-none font-bold">#CloudNord</div>
        <div class="mt-[1.8vmin] flex min-h-[3.6vmin] items-center justify-center">
          <a href="https://x.com/intent/tweet?button_hashtag=CloudNord&amp;ref_src=twsrc%5Etfw" class="twitter-hashtag-button" data-related="@Cloud_Nord" data-dnt="true" data-show-count="false">Post #CloudNord</a>
        </div>
      </article>\`

    const titre = liens.length === 0 ? echapper(nom) : 'Suivez ' + echapper(nom)
    return '<div class="' + TITRE_MODE + '">' + titre + '</div>' +
      '<div class="cascade cartes flex flex-wrap items-stretch justify-center gap-[3vmin]">' +
      cartes + hashtag + '</div>'
  }

  /**
   * Boucle d'attente.
   *
   * Ce qu'on laisse tourner pendant les pauses : chaque page a sa durée, et
   * celles qui n'ont rien à montrer sont **sautées** plutôt qu'affichées vides —
   * dix secondes de cadre désert devant la salle se lisent comme une panne.
   *
   * Les durées ne sont pas égales : un programme de vingt-sept lignes se lit,
   * une rangée de logos se regarde. Elles sont volontairement longues — un
   * écran qui change toutes les trois secondes attire l'œil pendant une pause
   * où les gens se parlent.
   */
  const PAGES_BOUCLE = [
    { duree: 12_000, dispo: (d) => (d.sponsorTiers ?? []).some((t) => t.sponsors.length > 0), rendre: rendreSponsors },
    { duree: 15_000, dispo: (d) => (d.sessions ?? []).length > 0, rendre: rendreProgramme },
    { duree: 12_000, dispo: (d) => (d.otherRooms ?? []).some((s) => s.session != null), rendre: rendreAutresSalles },
    { duree: 10_000, dispo: (d) => (d.socialLinks ?? []).length > 0, rendre: rendreReseaux },
  ]
  /**
   * Rang dans PAGES_BOUCLE, et non dans la liste des pages disponibles.
   *
   * C'est la correction d'un défaut discret : quand une page perdait son
   * contenu — le dernier talk des autres salles se termine — ou en gagnait un
   * au sync, la liste filtrée changeait de longueur et le même indice désignait
   * soudain une autre page. L'écran changeait alors en plein milieu, en gardant
   * l'échéance de la page précédente, et sans transition puisque l'indice,
   * lui, n'avait pas bougé. Un rang qui désigne toujours la même page ne peut pas
   * glisser sous nos pieds.
   */
  let boucleRang = 0
  let boucleJusqua = 0
  // Rang et durée réellement affichés : c'est sur eux que se décide une
  // transition, et sur eux que se calent la jauge et le défilement du programme.
  let boucleRangAffiche = 0
  let boucleDuree = 0

  const pagesBoucle = (donnees) => PAGES_BOUCLE.filter((page) => page.dispo(donnees))

  /**
   * La première page qui a quelque chose à montrer, en partant de ce rang.
   *
   * Renvoie -1 quand aucune n'a rien — salle jamais synchronisée.
   */
  function pageDepuis(donnees, depart) {
    for (let pas = 0; pas < PAGES_BOUCLE.length; pas += 1) {
      const rang = (depart + pas) % PAGES_BOUCLE.length
      if (PAGES_BOUCLE[rang].dispo(donnees)) return rang
    }
    return -1
  }

  function rendreBoucle(donnees) {
    // Rien à montrer nulle part — salle jamais synchronisée : les sponsors
    // disent au moins de quel événement il s'agit.
    if (pageDepuis(donnees, boucleRang) === -1) return rendreSponsors(donnees)
    const pages = pagesBoucle(donnees)

    const rang = pageDepuis(donnees, boucleRang)
    // La page visée a pu se vider depuis la dernière bascule : on adopte celle
    // qu'on affiche réellement, et on lui donne sa propre durée — sinon elle
    // hériterait de l'échéance d'une page qui n'est plus à l'écran.
    if (rang !== boucleRang) { boucleRang = rang; boucleJusqua = 0 }
    const page = PAGES_BOUCLE[rang]
    if (boucleJusqua === 0) boucleJusqua = Date.now() + page.duree
    boucleRangAffiche = rang
    boucleDuree = page.duree

    /**
     * Repère de progression.
     *
     * Trois points en bas disent qu'il y a une suite, et qu'elle tourne : sans
     * eux, un écran qui change tout seul se lit comme un écran instable. Le
     * point actif se remplit sur la durée de la page, ce qui dit en plus
     * *quand* elle va tourner.
     *
     * La durée est écrite ici parce qu'elle ne bouge pas de toute la page ; le
     * temps déjà écoulé, lui, est posé après coup depuis le script — l'inscrire
     * dans le html le ferait changer à chaque seconde, et le moindre état reçu
     * relancerait une transition en plein milieu.
     */
    const position = pages.indexOf(page)
    const points = pages.map((_, index) => index === position
      ? '<span class="point actif" style="--duree:' + page.duree + 'ms"></span>'
      : '<span class="point"></span>').join('')

    return '<div class="flex min-h-0 flex-1 flex-col justify-center">' + page.rendre(donnees) + '</div>' +
      '<div class="mt-[2.5vmin] flex flex-none items-center justify-center gap-[1.2vmin]">' + points + '</div>'
  }

  /** Passe à la page suivante, en sautant celles qui n'ont rien à dire. */
  function avancerBoucle(donnees) {
    const rang = pageDepuis(donnees, (boucleRang + 1) % PAGES_BOUCLE.length)
    if (rang === -1) { boucleJusqua = Date.now() + 5_000; return }
    boucleRang = rang
    boucleJusqua = Date.now() + PAGES_BOUCLE[rang].duree
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

  /**
   * Écrit une page, en poussant l'ancienne hors du cadre si demandé.
   *
   * innerHTML détruit tout ce qui était là : la couche sortante est donc mise
   * de côté avant, puis regreffée le temps de son animation de sortie. Elle
   * s'enlève sur animationend, et de toute façon à la réécriture suivante — il
   * ne peut jamais y en avoir deux.
   *
   * Regreffée en tête, donc peinte *sous* la nouvelle. Sans importance depuis
   * le passage au latéral, où les deux couches sont adjacentes et ne se
   * recouvrent jamais ; ça comptait du temps du fondu.
   */
  function ecrire(html, croiser) {
    if (html === contenu.__html) return
    const sortante = croiser ? contenu.querySelector('.calque:not(.sortante)') : null
    contenu.__html = html
    contenu.innerHTML = html
    if (!sortante) return
    sortante.classList.add('sortante')
    contenu.insertBefore(sortante, contenu.firstChild)

    // Deux façons de s'en aller, parce qu'une seule ne suffit pas : un moteur
    // qui n'anime pas — Browser Source en arrière-plan, mouvement réduit — ne
    // dit jamais animationend, et la couche resterait là, transparente, jusqu'à
    // la réécriture suivante.
    const enlever = () => sortante.remove()
    sortante.addEventListener('animationend', enlever, { once: true })
    setTimeout(enlever, 1_200)
  }

  /**
   * Cale la jauge du point actif sur le temps déjà écoulé.
   *
   * Posé ici et non dans le html : la valeur change à chaque seconde, et la
   * mettre dans le gabarit ferait différer le rendu en permanence.
   */
  function poserJauge(calque) {
    const jauge = calque?.querySelector('.point.actif')
    if (!jauge) return
    jauge.style.setProperty('--ecoule', Math.max(0, boucleDuree - (boucleJusqua - Date.now())) + 'ms')
  }

  /**
   * Fait glisser le programme, du créneau en cours vers la suite de la journée.
   *
   * Les deux bornes se mesurent après insertion : elles dépendent de la hauteur
   * réelle de l'écran, qui va du 1024x768 au 4K. Hors d'un vrai navigateur
   * toutes ces mesures valent zéro, la classe n'est pas posée, et la liste
   * reste simplement là où elle est.
   */
  function poserDefilement(calque) {
    const cadre = calque?.querySelector('.defilant')
    const liste = cadre?.firstElementChild
    if (!cadre || !liste || liste.classList.contains('defile')) return

    const haut = cadre.clientHeight
    const course = liste.scrollHeight - haut
    if (!(course > 0)) return

    const repere = calque.querySelector('.repere')
    const vise = repere ? repere.offsetTop - (haut - repere.offsetHeight) / 2 : 0
    const depart = Math.max(0, Math.min(vise, course))
    // Environ un écran plus bas, sans jamais dépasser le bas de la journée.
    const arrivee = Math.min(depart + haut * 0.85, course)

    liste.style.setProperty('--depart', -depart + 'px')
    liste.style.setProperty('--arrivee', -arrivee + 'px')
    liste.style.animationDuration = boucleDuree + 'ms'
    liste.classList.add('defile')
  }

  /**
   * Nom court de l'événement, poussé par le hub et gardé en cache par la salle.
   *
   * Pas le nom du programme (donnees.event.name) : le hub peut le contredire par
   * réglage, et il le connaît avant même qu'un programme soit importé.
   */
  function nomCourt(donnees) {
    return donnees.eventIdentity?.shortName || ''
  }

  function rendre(donnees) {
    dernier = donnees
    // Le titre suit l'événement : la fenêtre de secours et l'onglet de la
    // Browser Source doivent dire de quel événement il s'agit, sans qu'un nom
    // soit compilé dans le binaire installé sur la machine.
    const titre = donnees.eventIdentity?.name
    if (titre) document.title = titre + ' — écran de salle'
    document.body.dataset.mode = donnees.state.mode
    document.body.dataset.connectivite = donnees.state.connectivity
    appliquerTheme(donnees.event)

    document.getElementById('nom-salle').textContent = donnees.roomName ?? donnees.state.roomId ?? ''

    const pause = donnees.state.breakBadge
    const etiquette = document.getElementById('etiquette-break')
    etiquette.hidden = pause == null
    if (pause != null) {
      etiquette.textContent = pause.state === 'en-cours' ? 'Break' : 'Break à venir'
      // « À venir » attire l'œil, « en cours » se contente d'exister : à ce
      // moment-là, l'écran entier dit déjà que rien ne se joue.
      etiquette.style.color = pause.state === 'en-cours' ? '' : 'var(--color-attention)'
    }
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
      feedback: rendreFeedback,
      question: rendreQuestion,
      wall: rendreMur,
      loop: rendreBoucle,
      live: () => '',
    }
    /**
     * La boucle repart du début à chaque fois qu'on y revient.
     *
     * Sortir sur un message puis revenir doit reprendre aux sponsors, pas
     * atterrir au milieu du programme avec deux secondes avant la bascule
     * suivante.
     */
    if (donnees.state.mode !== 'loop') { boucleRang = 0; boucleJusqua = 0 }
    /**
     * Redessiné seulement quand le rendu change.
     *
     * Un état arrive à chaque bascule de scène, chaque profondeur de file : tout
     * réécrire à chaque fois relançait les animations et faisait clignoter
     * l'écran devant la salle, pour un contenu identique.
     */
    const corps = (modes[donnees.state.mode] ?? rendreSponsors)(donnees)
    const html = corps === ''
      ? ''
      : '<div class="calque absolute inset-0 flex flex-col justify-center overflow-hidden">' + corps + '</div>'

    /**
     * La transition, seulement là où elle veut dire quelque chose.
     *
     * On croise à un vrai changement de page — un autre mode, ou la page
     * suivante de la boucle. Pas sur un message de plus au mur ni sur une
     * question réécrite : là, superposer deux textes différents ne se lirait
     * pas, alors que l'entrée de la nouvelle couche suffit à dire que ça a
     * bougé.
     */
    const croise = donnees.state.mode !== modeAffiche
      || (donnees.state.mode === 'loop' && boucleRangAffiche !== rangAffiche)
    ecrire(html, croise)
    modeAffiche = donnees.state.mode
    rangAffiche = boucleRangAffiche

    /**
     * Amène au centre ce qui se passe maintenant.
     *
     * Une journée de conférence fait deux à trois fois la hauteur de l'écran,
     * et personne ne peut faire défiler un vidéoprojecteur : sans cela, la
     * salle regarderait le petit-déjeuner à seize heures. Le conteneur est en
     * overflow caché, donc il ne montre aucune barre, mais il se positionne
     * très bien depuis le script.
     *
     * Dans la boucle, la même question a une meilleure réponse : la liste part
     * du créneau en cours et glisse vers la suite pendant les quinze secondes
     * de la page. Le mode « programme » de la régie, lui, est un écran qu'on
     * pose et qu'on laisse : il se contente d'être au bon endroit.
     *
     * Toujours sur la couche vivante, jamais sur celle qui s'efface.
     */
    const vivante = contenu.querySelector('.calque:not(.sortante)')
    /**
     * Le bouton de X, à chaque fois que la slide Réseaux revient.
     *
     * \`widgets.js\` remplace l'ancre par une iframe **au chargement du script**,
     * une fois. Or la couche est réécrite entièrement à chaque retour de la
     * boucle : sans ce rappel, le bouton n'apparaîtrait qu'au tout premier
     * passage et la slide retomberait ensuite sur son lien nu.
     *
     * Optionnel de bout en bout : \`twttr\` n'existe pas si le script n'a pas pu
     * être chargé, ce qui est le cas normal d'une salle hors ligne.
     */
    if (vivante?.querySelector('.twitter-hashtag-button')) {
      try { window.twttr?.widgets?.load(vivante) } catch { /* le hashtag reste lisible */ }
    }
    // Le document entier, et non la seule couche : le logo de l'événement vit
    // dans l'en-tête. Le résultat étant gardé par URL, le balayage ne coûte
    // rien de plus.
    detourerLogos(document)
    if (donnees.state.mode === 'loop') {
      poserJauge(vivante)
      poserDefilement(vivante)
    } else {
      vivante?.querySelector('.repere')?.scrollIntoView({ block: 'center' })
    }
  }

  function tic() {
    const tz = dernier?.timezone ?? 'Europe/Paris'
    const decalage = dernier?.state.serverTimeOffsetMs ?? 0
    document.getElementById('horloge').textContent = new Intl.DateTimeFormat('fr-FR', {
      hour: '2-digit', minute: '2-digit', timeZone: tz,
    }).format(new Date(Date.now() + decalage))
    // Le compte à rebours change de valeurs à la seconde, le reste attend un
    // état. Seuls les chiffres bougent : la structure, elle, tient.
    if (dernier?.state.mode === 'countdown') majCompte(dernier)

    /**
     * La boucle avance sur ce même tic.
     *
     * Elle repasse par la fonction de rendu plutôt que d'écrire directement
     * dans le conteneur : c'est elle
     * qui recentre le programme sur le créneau en cours, et qui ne réécrit que
     * si le html change — donc l'animation d'entrée ne se rejoue qu'au vrai
     * changement de page.
     */
    if (dernier?.state.mode === 'loop' && Date.now() >= boucleJusqua) {
      avancerBoucle(dernier)
      rendre(dernier)
    }
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

<!--
  La seule dépendance externe de cette page, et elle est facultative.

  Le reste du fichier tient sans réseau, par construction — c'est la raison
  d'être de l'état embarqué et des assets mis en cache. Ce script-ci ne peut
  pas : le bouton officiel de X est servi par X. Il est donc chargé en
  \`async\`, en dernier, et **rien n'en dépend** : sans lui la slide Réseaux
  affiche le hashtag en grand, ce qui est de toute façon ce qui se retape
  depuis le fond de la salle. Une salle coupée d'Internet perd un bouton sur
  lequel personne ne peut cliquer — un écran projeté n'a pas de souris — et
  garde tout ce qui se lit.
-->
<script async src="https://platform.x.com/widgets.js" charset="utf-8"></script>
</body>
</html>`
}
