import { MACHINE_JS } from '@cloudnord/etat-salle'
import { TAILWIND_CSS } from '@cloudnord/ui'
import { DUREE_SIGNALEMENT_MS } from './runtime.js'

/**
 * Fenêtre de régie.
 *
 * Conçue pour être utilisée dans une salle sombre, pendant un talk, sans
 * hésitation : cibles larges, état lisible d'un coup d'œil, raccourcis clavier
 * pour les gestes fréquents. Comme l'écran projeté, la page est autonome et
 * sans étape de build — elle doit s'ouvrir même quand tout le reste va mal.
 *
 * Règle de composition : **rien qui commande ne défile**. L'écran de régie
 * n'est pas toujours un grand moniteur, et un bouton sous la ligne de flottaison
 * est un bouton qu'on ne trouve pas au moment où on en a besoin. Les commandes
 * tiennent donc toutes dans la hauteur de fenêtre, et ce qui se consulte — les
 * programmes entiers, l'état détaillé des autres salles — passe en modale.
 * Reste en permanence sous les yeux ce qui déclenche une décision : le temps
 * restant, la conférence suivante, et l'avancement des autres salles.
 */
export interface RegiePageOptions {
  initialPayload?: unknown
}

export function renderRegiePage(options: RegiePageOptions = {}): string {
  const etatInitial =
    options.initialPayload == null
      ? ''
      : `<script id="etat-initial" type="application/json">${JSON.stringify(options.initialPayload).replace(/</g, '\\u003c')}</script>`

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Régie de salle</title>
<style>${TAILWIND_CSS}</style>
<style>
  /*
   * Ce qui reste hors Tailwind : des règles pilotées par des attributs data-
   * sur le body, que les utilitaires n'expriment pas — la page bascule d'un état
   * à l'autre en écrivant un seul attribut, pas en réécrivant des listes de
   * classes un peu partout.
   */
  html, body { height: 100%; }
  body { overflow: hidden; }

  /* Heure simulée : signalée sans ambiguïté, sinon l'écart déroute. */
  body[data-horloge="simulee"] .horloge { color: var(--color-attention); }
  body[data-horloge="simulee"] .horloge::after {
    content: 'simulée'; margin-left: 6px; font-size: 10px; font-weight: 600;
    letter-spacing: .1em; text-transform: uppercase; opacity: .8;
  }

  /* Menu déroulant des écrans. */
  .menu-liste { display: none; }
  .menu.ouvert .menu-liste { display: block; }

  /*
   * Indicateurs de l'en-tête, et leur info-bulle.
   *
   * Le « title » natif disait la même chose, mais après une seconde d'attente,
   * dans la police du système, et sans pouvoir colorer le chiffre — qui est
   * justement toute l'information. Écrite à la main plutôt qu'en utilitaires :
   * elle tient à trois choses qu'aucune classe n'exprime — l'apparition au
   * survol *et* au clavier, la flèche en ::before, et une couleur pilotée par
   * un seul attribut sur le bloc, data-niveau, comme le reste de la page.
   */
  .indicateur { cursor: help; }
  .indicateur .bulle {
    position: absolute; top: calc(100% + 9px); left: -10px; z-index: 30;
    width: 270px; padding: 11px 13px;
    border: 1px solid var(--color-bord); border-radius: 10px;
    background: var(--color-surface2); color: var(--color-texte);
    box-shadow: 0 12px 30px rgba(0, 0, 0, .5);
    opacity: 0; transform: translateY(-4px); pointer-events: none;
    transition: opacity .12s ease, transform .12s ease;
  }
  /* La flèche prolonge le coin : même fond, et les deux bords qu'elle croise. */
  .indicateur .bulle::before {
    content: ''; position: absolute; top: -5px; left: 15px; width: 8px; height: 8px;
    background: var(--color-surface2); transform: rotate(45deg);
    border-left: 1px solid var(--color-bord); border-top: 1px solid var(--color-bord);
  }
  .indicateur:hover .bulle, .indicateur:focus-visible .bulle { opacity: 1; transform: translateY(0); }
  .indicateur:focus-visible { outline: none; }

  /* La jauge dit la même chose que la pastille, en longueur. */
  .indicateur .jauge { height: 5px; border-radius: 999px; background: var(--color-bord); overflow: hidden; }
  .indicateur .jauge > span {
    display: block; height: 100%; border-radius: inherit;
    background: var(--color-ok); transition: width .3s ease;
  }

  /*
   * Un seul vocabulaire de couleurs, du chiffre à la jauge.
   *
   * Chaque mesure porte la sienne — le poste peut avoir un processeur au repos
   * et une mémoire pleine — tandis que la pastille du bandeau prend la pire des
   * deux. Le niveau posé sur le bloc reste celui de la pastille : c'est lui qui
   * doit être lisible de l'autre bout de la salle.
   */
  .indicateur .niveau-ok { color: var(--color-ok); }
  .indicateur .niveau-attention { color: var(--color-attention); }
  .indicateur .niveau-alerte { color: var(--color-alerte); }
  .indicateur .niveau-inconnu { color: var(--color-attenue); }
  .indicateur .jauge > span.niveau-ok { background: var(--color-ok); }
  .indicateur .jauge > span.niveau-attention { background: var(--color-attention); }
  .indicateur .jauge > span.niveau-alerte { background: var(--color-alerte); }
  .indicateur .jauge > span.niveau-inconnu { background: var(--color-attenue); }

  /*
   * Écran court : la densité s'ajuste plutôt que les commandes ne sortent.
   *
   * Hors couche, donc prioritaire sur les utilitaires comme sur .btn : c'est
   * exactement ce qu'on veut ici, un dernier mot sur la densité quand la
   * hauteur manque. Mesuré sur un 1024 × 640, où la colonne des commandes
   * dépassait de soixante-dix pixels — invisibles, puisque rognés.
   */
  @media (max-height: 700px) {
    .panneau { padding: 10px; }
    .btn { padding-block: 9px; }
    #restant { font-size: 34px; }
  }

  /* Bandeaux qui disparaissent complètement quand ils sont vides. */
  #signalements:empty, #flux-salles:empty { display: none; }

  /* Modale de consultation : programmes et état des salles. */
  #modale { display: none; }
  body[data-modale="ouverte"] #modale { display: flex; }

  /* Modale de configuration : réglages de la salle. Attribut distinct — les
     deux ne s'ouvrent jamais ensemble, mais chacune sait se fermer seule. */
  #modale-config { display: none; }
  body[data-config="ouverte"] #modale-config { display: flex; }

  /* Contrôle des rushes : plein cadre, et indépendante des deux autres. */
  #modale-vod { display: none; }
  body[data-vod="ouverte"] #modale-vod { display: flex; }

  /* Avertissement de démarrage : même mécanique que les deux modales ci-dessus. */
  #modale-rec { display: none; }
  body[data-rec="ouverte"] #modale-rec { display: flex; }

  /* Confirmation d'une fin anticipée : même mécanique, même raison. */
  #modale-fin { display: none; }
  body[data-fin="ouverte"] #modale-fin { display: flex; }

  /* Confirmation d'un démarrage très en avance : idem. */
  #modale-tot { display: none; }
  body[data-tot="ouverte"] #modale-tot { display: flex; }

  /* Voile d'appairage : occupe tout l'écran tant que la machine n'est pas liée. */
  #appairage { display: none; }
  body[data-appairage="requis"] #appairage { display: flex; }

  #toast { opacity: 0; transform: translateX(-50%) translateY(20px); }
  #toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
  #toast.erreur { border-color: var(--color-alerte); background: #3a1519; }
</style>
</head>
<body class="grid h-screen grid-rows-[auto_auto_auto_1fr] bg-fond font-sans text-texte" data-appairage="ok" data-modale="fermee" data-config="fermee" data-rec="fermee" data-fin="fermee" data-tot="fermee" data-vod="fermee">
${etatInitial}
<header class="flex items-center gap-3 border-b border-bord bg-surface px-3 py-2">
  <div class="truncate text-[15px] font-semibold" id="salle">—</div>
  <span class="shrink-0" id="badge-mode"></span>
  <div class="indicateur relative flex shrink-0 items-center gap-1.5 text-xs text-attenue" id="hub"
       data-niveau="alerte" tabindex="0" aria-label="Lien avec le hub : hors ligne">
    <span class="pastille" id="pastille-hub"></span>
    <span id="etat-libelle">hors ligne</span>
    <div class="bulle" id="bulle-hub" aria-hidden="true"></div>
  </div>
  <!--
    Charge du poste, en pastille.

    La machine qui encode est le point faible invisible de la salle : quand elle
    sature, OBS perd des images sans rien dire et le rush est mauvais sans que
    personne s'en aperçoive avant le montage. Une couleur suffit à le voir de
    loin ; le détail — processeur, mémoire, fenêtre de mesure — tient dans
    l'info-bulle, parce qu'un chiffre de plus dans le bandeau se lirait tout le
    temps pour ne servir que trois fois dans la journée.

    « Poste » et non « CPU » : la pastille prend la pire des deux mesures, et
    une pastille rouge sous un mot qui ne parle que du processeur enverrait
    chercher la panne au mauvais endroit.
  -->
  <div class="indicateur relative flex shrink-0 items-center gap-1.5 text-xs text-attenue" id="cpu"
       data-niveau="inconnu" tabindex="0" aria-label="Charge du poste : première mesure en cours">
    <span class="pastille hors" id="pastille-cpu"></span>
    <span>Poste</span>
    <!--
      Le lecteur d'écran lit aria-label sur le bloc : la bulle redirait mot
      pour mot la même chose, en la découpant en cinq bribes sans ordre.
    -->
    <div class="bulle" id="bulle-cpu" aria-hidden="true"></div>
  </div>
  <div class="shrink-0 text-xs text-attention" id="file"></div>
  <!--
    Le flux de la page est mort : ce qui est affiché ne bouge plus.

    Sans ce mot, une page figée passe pour une page vivante — l'horloge, le
    compte à rebours et le flux des salles se redessinent chaque seconde depuis
    la dernière charge utile reçue, et continuent donc d'avancer. Seul l'état
    de la conférence reste bloqué, sur ce qu'il disait à la coupure. C'est
    exactement ce qu'on ne peut pas diagnostiquer depuis une salle.
  -->
  <div class="shrink-0 text-xs font-semibold text-alerte" id="flux-mort" hidden>écran figé — flux interrompu</div>
  <div class="horloge ml-auto shrink-0 text-[19px] font-semibold tabular-nums" id="horloge">--:--</div>
  <div class="flex shrink-0 items-center gap-1.5">
    <button class="btn btn-petit" id="btn-programme">Programme<span class="touche">P</span></button>
    <button class="btn btn-petit" id="btn-salles">Salles<span class="touche">S</span></button>
    <button class="btn btn-petit" id="btn-config" title="Configuration de la salle">⚙</button>
    <div class="menu relative" id="menu-ecrans">
      <button class="btn btn-petit" id="btn-ecrans">Écrans ▾</button>
      <div class="menu-liste absolute top-[calc(100%+6px)] right-0 z-20 min-w-[260px] rounded-[9px] border border-bord bg-surface p-[5px] shadow-[0_10px_30px_rgba(0,0,0,.45)]" id="liste-ecrans"></div>
    </div>
  </div>
</header>

<!--
  Flux des autres salles.

  Une ligne, toujours visible : c'est l'information qui décide d'un décalage
  ("l'autre salle finit dans 3 minutes, on ne lance pas le talk maintenant").
  Le détail — le programme complet d'une salle — est à un clic, en modale.
-->
<div class="flex items-center gap-1.5 overflow-x-auto border-b border-bord bg-surface px-3 py-1.5" id="flux-salles"></div>

<div class="flex max-h-[22vh] flex-col gap-1 overflow-y-auto px-3 pt-2" id="signalements"></div>

<!--
  Les commandes. Trois colonnes qui ne défilent pas : au-dessous de 1024 px de
  large la grille retombe sur une colonne défilante, faute de mieux, mais la
  cible est bien l'écran entier sans ascenseur.
-->
<main class="grid min-h-0 grid-cols-1 gap-2.5 overflow-y-auto p-2.5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)] lg:overflow-hidden">

  <div class="flex min-h-0 flex-col gap-2.5 lg:overflow-y-auto">
    <section class="panneau p-3">
      <div class="mb-2 flex items-center gap-2">
        <h2 class="titre-panneau mb-0 flex-1">Conférence</h2>
        <span class="badge" id="badge-conf">à venir</span>
      </div>
      <div class="mb-2 line-clamp-2 text-sm leading-snug" id="titre-conf">—</div>
      <!--
        Les intervenants du créneau piloté.

        Au micro, ce qu'on cherche est un prénom, et le titre ne le donne pas.
        Il fallait ouvrir la modale programme pour le lire — deux clics, au
        moment précis où l'on parle à la salle. Masqué sur un créneau sans
        speaker : une ligne vide sous « Pause déjeuner » ferait douter.
      -->
      <div class="mb-2 line-clamp-1 text-xs text-attenue" id="qui-conf" hidden></div>
      <!--
        Le temps restant est la donnée qu'on regarde en boucle : elle a la
        taille qui va avec.

        Le badge à côté dit *ce que* le nombre décompte. Sans lui, « 12:34 » se
        lit comme du temps de conférence restant — y compris quand il s'agit du
        temps qui reste **avant** de commencer, ce qui est l'inverse.
      -->
      <div class="flex items-center gap-2.5">
        <div class="text-[40px] leading-none font-bold tabular-nums" id="restant">--:--</div>
        <span class="badge" id="badge-restant" hidden>à venir</span>
      </div>
      <div class="mt-1 text-xs text-attenue" id="conf-detail"></div>
      <div class="mt-2 border-t border-bord pt-2 text-xs text-attenue" id="suivant"></div>
      <div class="mt-2 grid grid-cols-2 gap-2">
        <button class="btn" id="btn-conf-demarrer">Commencer</button>
        <button class="btn" id="btn-conf-terminer">Terminer</button>
      </div>
    </section>

    <section class="panneau min-h-0 flex-1 p-3">
      <h2 class="titre-panneau">Diagnostic</h2>
      <div class="flex flex-col gap-1 text-xs" id="diag"></div>
      <div class="mt-1.5 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto text-[11px] text-attenue" id="journal"></div>
    </section>
  </div>

  <div class="flex min-h-0 flex-col gap-2.5 lg:overflow-y-auto">
    <section class="panneau p-3">
      <h2 class="titre-panneau">Écran de salle</h2>
      <div class="grid grid-cols-2 gap-1.5" id="modes"></div>
    </section>

    <section class="panneau p-3">
      <h2 class="titre-panneau">Projection — OBS&nbsp;A<span id="simule-A"></span></h2>
      <div class="grid grid-cols-2 gap-1.5" id="scenes"></div>
    </section>

    <section class="panneau p-3">
      <h2 class="titre-panneau">Message à la console</h2>
      <!-- Repasse sur deux lignes quand la colonne se resserre : un champ de
           message réduit à six caractères ne se relit pas avant d'envoyer. -->
      <div class="flex flex-wrap gap-1.5">
        <input type="text" class="champ min-w-[150px] flex-1 py-2" id="message-texte" placeholder="Besoin d'aide, question…" maxlength="500">
        <div class="flex flex-1 gap-1.5">
          <select class="champ w-auto shrink-0 py-2" id="message-niveau">
            <option value="info">Info</option>
            <option value="warning">Important</option>
            <option value="urgent">Urgent</option>
          </select>
          <button class="btn flex-1 py-2" id="btn-message">Envoyer</button>
        </div>
      </div>
      <div class="mt-1.5 text-[11px] text-attenue">
        Part par la file de remontée : un message envoyé hors ligne arrivera quand même.
      </div>
    </section>
  </div>

  <div class="flex min-h-0 flex-col gap-2.5 lg:overflow-y-auto">
    <section class="panneau p-3">
      <div class="mb-1.5 flex items-center gap-2">
        <h2 class="titre-panneau mb-0 flex-1">Captation — OBS&nbsp;B<span id="simule-B"></span></h2>
        <!-- Vérifier les rushes se fait pendant l'événement ou jamais : la salle
             est démontée bien avant que quiconque ouvre les fichiers. Discret
             pour autant : ce n'est pas une commande de la conférence en cours,
             et rien ne doit le faire confondre avec « Enregistrer ». -->
        <button class="shrink-0 rounded border border-transparent px-1.5 py-0.5 text-[13px] leading-none opacity-60 hover:border-bord hover:opacity-100"
                id="btn-vod" aria-label="Vérifier les enregistrements"
                title="Lister, contrôler et prévisualiser les enregistrements déjà produits">🎞</button>
      </div>
      <div class="mb-2 flex items-baseline gap-2.5">
        <span class="inactif text-[22px] font-bold tabular-nums" id="duree">00:00</span>
        <span class="text-[11px] text-attenue" id="marqueurs">aucun marqueur</span>
      </div>
      <div class="grid grid-cols-2 gap-1.5">
        <button class="btn danger" id="btn-rec">Enregistrer<span class="touche">R</span></button>
        <button class="btn" id="btn-stream">Diffuser</button>
      </div>
      <div class="mt-1.5 flex gap-1.5">
        <input type="text" class="champ flex-1 py-2" id="label-marqueur" placeholder="Libellé du marqueur" maxlength="80">
        <button class="btn shrink-0 py-2" id="btn-marqueur">Marquer<span class="touche">M</span></button>
      </div>
    </section>

    <section class="panneau min-h-0 flex-1 p-3">
      <h2 class="titre-panneau">Niveaux audio — OBS&nbsp;B</h2>
      <div class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto" id="niveaux">
        <div class="text-xs text-attenue">En attente d'OBS…</div>
      </div>
      <div class="mt-1.5 text-[11px] text-attenue">
        Vert jusqu'à &minus;20 dB, jaune ensuite, rouge au-delà de &minus;9 dB.
      </div>
    </section>
  </div>
</main>

<!--
  Configuration de la salle.

  Les adresses des deux OBS et les noms de scènes se constatent devant les
  machines : les saisir ici évite l'aller-retour vers la console du hub, qui
  reste malgré tout la source de vérité — l'enregistrement part chez lui, la
  salle se resynchronise, puis rouvre ses connexions OBS.
-->
<div class="fixed inset-0 z-40 items-center justify-center bg-black/65 p-4" id="modale-config">
  <div class="flex max-h-[88vh] min-h-0 w-full max-w-[820px] flex-col rounded-xl border border-bord bg-surface">
    <div class="flex items-center gap-2 border-b border-bord px-4 py-2.5">
      <h2 class="titre-panneau mb-0 flex-1">⚙ Configuration de la salle</h2>
      <button class="btn btn-petit" id="btn-relire-scenes">Relire les scènes d'OBS</button>
      <button class="btn btn-petit" id="btn-fermer-config">Fermer<span class="touche">Échap</span></button>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto p-4" id="config-contenu"></div>
    <div class="flex items-center gap-3 border-t border-bord px-4 py-3">
      <div class="flex-1 text-xs text-attenue" id="config-avis"></div>
      <button class="btn shrink-0" id="btn-config-enregistrer">Enregistrer</button>
    </div>
  </div>
</div>

<!--
  Modale de consultation.

  Trois vues qui se lisent, jamais qui commandent : le programme de la salle,
  celui d'une autre salle, et l'état des salles tel que le hub le connaît.
  Elles occupaient une colonne entière de l'écran ; elles n'y gagnaient rien et
  repoussaient les commandes hors de vue.
-->
<div class="fixed inset-0 z-40 items-center justify-center bg-black/65 p-4" id="modale">
  <div class="flex max-h-[86vh] min-h-0 w-full max-w-[900px] flex-col rounded-xl border border-bord bg-surface">
    <div class="flex flex-wrap items-center gap-1.5 border-b border-bord px-3 py-2">
      <button class="btn btn-onglet actif" id="encart-programme">Programme</button>
      <button class="btn btn-onglet" id="encart-autre">Autre salle</button>
      <button class="btn btn-onglet" id="encart-salles">Salles</button>
      <button class="btn btn-onglet" id="encart-questions">Questions</button>
      <select class="champ max-w-[220px] py-2 text-[13px]" id="choix-autre-salle" hidden></select>
      <button class="btn btn-petit ml-auto" id="btn-fermer-modale">Fermer<span class="touche">Échap</span></button>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto p-3" id="encart-contenu"></div>
  </div>
</div>

<!--
  Contrôle des enregistrements produits.

  Plein cadre, et volontairement : ce qu'on y cherche est une liste de fichiers
  avec des noms longs, des durées et des raisons en clair. Vue dans une
  colonne, elle se lit à coups de trois mots par ligne et on referme sans avoir
  rien vérifié.

  Elle ne commande rien dans la salle — elle relit le disque. On peut donc
  contrôler la matinée pendant que l'après-midi enregistre, ce qui est tout
  l'intérêt : le soir, la salle est démontée.
-->
<div class="fixed inset-0 z-40 items-center justify-center bg-black/70 p-3" id="modale-vod">
  <div class="flex h-full w-full min-h-0 flex-col rounded-xl border border-bord bg-surface">
    <div class="flex flex-wrap items-center gap-2 border-b border-bord px-4 py-2.5">
      <h2 class="titre-panneau mb-0 shrink-0">🎞 Enregistrements</h2>
      <div class="min-w-0 flex-1 truncate font-mono text-[11px] text-attenue" id="vod-racine"></div>
      <div class="shrink-0 text-xs text-attenue" id="vod-avancement"></div>
      <button class="btn btn-petit shrink-0" id="btn-vod-tout">Tout vérifier</button>
      <button class="btn btn-petit shrink-0" id="btn-vod-monter-tout">Tout téléverser</button>
      <button class="btn btn-petit shrink-0" id="btn-vod-relire">Relire le dossier</button>
      <button class="btn btn-petit shrink-0" id="btn-fermer-vod">Fermer<span class="touche">Échap</span></button>
    </div>
    <!--
      Pourquoi rien ne monte.

      Une attente muette se lit comme un bouton mort : on reclique, puis on
      cherche la panne. « conférence dans 6 min » se lit comme une décision.
    -->
    <div class="hidden border-b border-bord px-4 py-1.5 text-[11px]" id="vod-regulateur"></div>
    <div class="min-h-0 flex-1 overflow-y-auto p-3" id="vod-contenu"></div>
    <div class="border-t border-bord px-4 py-2 text-[11px] text-attenue">
      « Vérifier » ouvre le conteneur avec ffprobe : pistes présentes, durée réelle
      contre durée chronométrée, débit. Ce qu'aucune sonde ne dit — le mauvais plan,
      le micro dans la poche — reste à l'œil : ✓ et ✕ posent ce verdict-là.
    </div>
  </div>
</div>

<!--
  Avertissement au démarrage d'une conférence.

  Trois issues, pas deux : « Annuler » existe parce que la question peut arriver
  au mauvais moment — on visait Terminer, ou l'intervenant n'est pas prêt — et
  qu'un avertissement sans porte de sortie se clique sans être lu.
-->
<div class="fixed inset-0 z-50 items-center justify-center bg-black/65 p-4" id="modale-rec">
  <div class="w-full max-w-[440px] rounded-xl border border-bord bg-surface p-5">
    <h2 class="mb-1.5 text-[17px] font-semibold text-attention">Rien n'enregistre</h2>
    <div class="mb-4 text-sm leading-relaxed text-attenue" id="modale-rec-detail">
      La conférence va commencer et OBS-B n'enregistre pas. Une VOD manquante ne
      se rattrape pas le soir.
    </div>
    <div class="flex flex-wrap justify-end gap-1.5">
      <button class="btn" id="rec-annuler">Annuler</button>
      <button class="btn" id="rec-sans">Commencer sans enregistrer</button>
      <button class="btn actif" id="rec-avec">Enregistrer et commencer</button>
    </div>
  </div>
</div>

<!--
  Confirmation d'une fin anticipée.

  Terminer n'est pas un geste anodin : la salle passe à « rien dans la salle »,
  les autres régies le voient, le compte à rebours saute à la conférence
  suivante. Le bouton est à côté de « Commencer », et c'est le genre de voisinage
  qui se paie une fois par événement.

  Seulement en avance : terminer à l'heure ou en dépassement est le geste normal
  de la journée, et le confirmer à chaque fois en ferait un réflexe — ce qui
  reviendrait à ne plus le lire du tout.

  Deux touches plutôt qu'une souris : on a le micro dans une main.
-->
<div class="fixed inset-0 z-50 items-center justify-center bg-black/65 p-4" id="modale-fin">
  <div class="w-full max-w-[440px] rounded-xl border border-bord bg-surface p-5">
    <h2 class="mb-1.5 text-[17px] font-semibold text-attention">Terminer en avance ?</h2>
    <div class="mb-4 text-sm leading-relaxed text-attenue" id="modale-fin-detail"></div>
    <div class="flex flex-wrap justify-end gap-1.5">
      <button class="btn" id="fin-non">Non<span class="touche">N</span></button>
      <button class="btn actif" id="fin-oui">Terminer<span class="touche">Y</span></button>
    </div>
  </div>
</div>

<!--
  Confirmation d'un démarrage très en avance.

  Entre deux créneaux, ou pendant une pause, la régie pilote la conférence qui
  arrive : c'est ce qu'on veut à 09:48 pour un talk de 09:50, et c'est un piège
  à 08:45 pour un talk de 09:50. Rien à l'écran ne distinguait les deux, et un
  « Commencer » de trop y écrivait un talk tenu de 08:45 à 08:45 — un créneau
  marqué comme s'étant déroulé alors que la salle était vide.

  Seulement très en avance : lancer cinq minutes avant l'heure est le geste
  normal du matin, et le confirmer à chaque fois en ferait un réflexe.

  L'écart est dit en toutes lettres, parce que c'est le seul chiffre qui permet
  de répondre — et l'heure du créneau avec lui, pour reconnaître qu'on ne vise
  pas celui qu'on croyait.
-->
<div class="fixed inset-0 z-50 items-center justify-center bg-black/65 p-4" id="modale-tot">
  <div class="w-full max-w-[440px] rounded-xl border border-bord bg-surface p-5">
    <h2 class="mb-1.5 text-[17px] font-semibold text-attention">Commencer très en avance ?</h2>
    <div class="mb-4 text-sm leading-relaxed text-attenue" id="modale-tot-detail"></div>
    <div class="flex flex-wrap justify-end gap-1.5">
      <button class="btn" id="tot-non">Non<span class="touche">N</span></button>
      <button class="btn actif" id="tot-oui">Commencer<span class="touche">Y</span></button>
    </div>
  </div>
</div>

<div class="fixed inset-0 z-50 items-center justify-center bg-fond p-6" id="appairage">
  <div class="max-w-[620px] rounded-2xl border border-bord bg-surface px-10 py-[34px] text-center">
    <h1 class="mb-2 text-[22px] font-semibold" id="appairage-titre">Appairage de la salle</h1>
    <div class="mb-6 text-[15px] leading-relaxed text-attenue" id="appairage-intro">Préparation…</div>
    <div class="mb-2 flex flex-col gap-3" id="appairage-choix"></div>
    <div class="mb-3.5 text-sm text-attenue [&>strong]:text-texte" id="appairage-demandee"></div>
    <div class="mb-5 rounded-xl border border-bord bg-fond px-[26px] py-5 text-[52px] font-bold tracking-[.16em] tabular-nums select-all" id="appairage-code">········</div>
    <div class="text-sm leading-relaxed text-attenue" id="appairage-consigne">
      Saisissez ce code dans la console du hub, onglet « Machines en attente »,
      puis choisissez la salle desservie par ce poste.<br>
      <a class="text-marque underline" id="appairage-lien" href="#" target="_blank" rel="noopener"></a>
    </div>
    <div class="mt-[18px] text-sm text-alerte" id="appairage-erreur"></div>
    <div class="mt-[22px] text-[13px] text-attenue">Cet écran disparaît dès l'approbation.</div>
  </div>
</div>

<div class="fixed bottom-6 left-1/2 z-50 max-w-[70vw] rounded-[9px] border border-bord bg-surface2 px-5 py-3 text-sm transition-[opacity,transform] duration-200 pointer-events-none" id="toast"></div>

<!--
  L'automate d'une salle, inliné.

  La régie n'a pas d'étape de build : elle ne peut pas importer. Le même module
  sert au hub, qui calcule l'état de toutes les salles, et à cette page, qui le
  recalcule chaque seconde sur son cache — voir @cloudnord/etat-salle. Les deux
  en tenaient chacune une copie, et les seuils comme les libellés avaient déjà
  commencé à diverger.
-->
<script>${MACHINE_JS}</script>

<script>
(() => {
  let donnees = null
  let debutRec = null
  /** Le chronomètre compte sur l'horloge du hub plutôt qu'en temps réel. */
  let recSuitHorloge = false

  const $ = (id) => document.getElementById(id)
  const echapper = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  const MODES = [
    // La boucle en premier : c'est l'écran d'attente par défaut, celui vers
    // lequel on revient. Les pages qu'elle enchaîne restent disponibles seules,
    // pour figer l'écran sur l'une d'elles quand quelque chose se passe.
    ['loop', 'Boucle'],
    ['sponsors', 'Sponsors'], ['programme', 'Programme'],
    ['countdown', 'Compte à rebours'], ['message', 'Message'],
    // Fin de talk : le public est encore assis, c'est le seul moment où l'on
    // obtient des retours.
    ['feedback', 'Notez le talk'], ['wall', 'Mur & questions'],
    ['question', 'Question choisie'],
  ]
  const SCENES_BASE = [['LIVE', 'Direct', 'L'], ['HOLD', 'Habillage', 'H']]

  /**
   * Péremption d'un signalement, reprise du runtime.
   *
   * Le runtime les retire aussi, mais sur son tic d'horloge — toutes les cinq
   * secondes. La page applique la même règle à la seconde, pour que le bandeau
   * disparaisse quand il le doit et pas au tic d'après.
   *
   * Sauf en aperçu : l'heure y est figée à la génération du fichier, et le
   * bandeau s'effacerait quelques secondes après l'ouverture — un aperçu ne
   * montrerait alors jamais de signalement.
   */
  const PEREMPTION_MS = window.__APERCU__ ? Infinity : ${DUREE_SIGNALEMENT_MS}

  /**
   * Écrans servis localement.
   *
   * Les ouvrir depuis la régie évite de retenir des URLs : le jour J, personne
   * ne tape http://127.0.0.1:7788/display/overlay de mémoire.
   */
  const ECRANS = [
    ['/display/projector', 'Projection', "Ce que voit la salle — Browser Source d'OBS-A"],
    ['/display/overlay', 'Habillage captation', 'Superposé à la vidéo dans OBS-B'],
    ['/display/overlay-live', 'Bandeau live', 'Question en haut — sobre sur un plan caméra'],
    ['/display/overlay-live?style=encart', 'Encart live', 'Question en carte, en bas à droite — par-dessus des slides'],
    ['/regie', 'Régie', 'Cette page, dans une autre fenêtre'],
  ]

  function toast(message, erreur) {
    const el = $('toast')
    el.textContent = message
    el.classList.toggle('erreur', Boolean(erreur))
    el.classList.add('visible')
    clearTimeout(el.__timer)
    el.__timer = setTimeout(() => el.classList.remove('visible'), 3200)
  }

  async function agir(payload) {
    try {
      const reponse = await fetch('/control/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const resultat = await reponse.json()
      toast(resultat.message ?? (resultat.ok ? 'Fait' : 'Échec'), !resultat.ok)
      return resultat
    } catch (cause) {
      // La régie tourne en local : un échec ici veut dire que le cœur applicatif
      // ne répond plus, ce que l'opérateur doit voir immédiatement.
      toast('Le service local ne répond pas', true)
      return { ok: false, message: 'Le service local ne répond pas' }
    }
  }

  function boutons(conteneur, entrees, actif, construire) {
    conteneur.innerHTML = ''
    for (const [valeur, libelle, touche] of entrees) {
      const bouton = document.createElement('button')
      // Tailwind remet <button> à plat : sans classe, le bouton n'aurait aucun
      // style. Les boutons statiques la portent dans le markup, ceux-ci en JS.
      bouton.className = 'btn whitespace-normal leading-tight'
      bouton.innerHTML = echapper(libelle) +
        (touche ? '<span class="touche">' + touche + '</span>' : '')
      bouton.classList.toggle('actif', valeur === actif)
      bouton.onclick = () => agir(construire(valeur))
      conteneur.appendChild(bouton)
    }
  }

  /**
   * Badge « simulé ».
   *
   * Rien ne distingue à l'écran un enregistrement simulé d'un vrai : mêmes
   * boutons, même chronomètre, même sidecar écrit. La seule différence est
   * qu'aucune caméra n'est branchée derrière — d'où ce rappel partout où l'on
   * croit piloter OBS.
   */
  const BADGE_SIMULE = '<span class="ml-1.5 rounded border border-attention/40 px-1 py-px ' +
    'text-[10px] font-semibold tracking-[.08em] text-attention uppercase">simulé</span>'

  /**
   * Mode d'exécution, celui de la salle et celui du hub.
   *
   * Rien en production des deux côtés : un badge permanent qui ne dit jamais
   * rien cesse d'être lu. C'est le **désaccord** qui compte le plus — une
   * salle de développement branchée sur le hub de l'événement enverrait de
   * vraies commandes depuis un poste qui simule tout.
   */
  function rendreMode() {
    const cible = $('badge-mode')
    const mode = donnees.diagnostics?.mode
    const hub = mode?.hub ?? 'production'
    if (mode == null || (mode.salle === 'production' && hub === 'production')) {
      cible.innerHTML = ''
      return
    }

    const divergent = mode.hub != null && mode.hub !== mode.salle
    const texte = !divergent
      ? 'mode dev'
      : mode.salle === 'dev'
        ? 'dev · hub en production'
        : 'hub en dev'
    cible.innerHTML = '<span class="rounded border px-1.5 py-px text-[10px] font-semibold ' +
      'tracking-[.08em] uppercase ' +
      (divergent ? 'border-alerte/50 text-alerte' : 'border-attention/40 text-attention') +
      '">' + texte + '</span>'
  }

  function badgeSimule(instance) {
    return donnees.diagnostics?.obs?.[instance]?.simulated === true ? BADGE_SIMULE : ''
  }

  function heure(iso, tz) {
    return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: tz })
      .format(new Date(iso))
  }

  /** Heure de la salle, décalage du hub compris. */
  function maintenant() {
    return Date.now() + (donnees.state.serverTimeOffsetMs || 0)
  }

  /**
   * Tout ce qui suit vient d'EtatSalle, inliné plus haut.
   *
   * La page en tenait sa propre copie : fin effective, créneau courant, seuils,
   * table des couleurs. Elle avait dérivé — le même état s'appelait « hors
   * créneau » ici et « rien au programme » dans la console du hub, et le
   * créneau sans heure de fin n'était pas courant ici alors qu'il l'était pour
   * le hub. Ne restent en propre que les adaptations d'affichage.
   */

  /** Ce que la page attend d'un état : une classe de pastille et un mot. */
  function etatDe(nom) {
    const dit = EtatSalle.apparenceDe(nom)
    return { classe: dit.teinte, libelle: dit.mot, texte: dit.texte }
  }

  /**
   * État d'une autre salle : le programme local, sauf pour ce qu'il ignore.
   *
   * L'arbitrage lui-même — quels états le hub est seul à connaître, et jusqu'à
   * quelle fraîcheur sa vue fait foi — vit dans la lib, avec le calcul qu'il
   * arbitre. La page n'apporte ici que ce qu'elle est seule à avoir : la date du
   * dernier rafraîchissement.
   */
  function etatSalle(roomId, sessions, instant) {
    const local = etatConference(sessions, instant)
    const vue = vueDuHub(roomId)
    const date = donnees.diagnostics?.roomsRefreshedAt
    const fraiche = date != null && Date.now() - Date.parse(date) < EtatSalle.VUE_PERIMEE_MS
    const nom = EtatSalle.etatFaisantFoi(local, vue?.conference, fraiche)
    /**
     * Programme absent du cache : le dire.
     *
     * « hors créneau » se lirait comme une salle sans rien de prévu, alors
     * qu'on ignore tout de la sienne.
     */
    if (nom === 'aucune' && sessions.length === 0) {
      return { classe: 'hors', libelle: 'programme inconnu', texte: 'text-attenue' }
    }
    return etatDe(nom)
  }

  /**
   * Repli local : ce que dit le programme, à l'heure du hub.
   *
   * Sans le cycle de vie, on ne distingue pas un talk lancé d'un créneau que
   * personne n'a démarré — on décrit donc le créneau, pas la salle.
   */
  function etatConference(sessions, instant) {
    return EtatSalle.etatDuProgramme(sessions, instant)
  }

  /**
   * Ce que le contour de la pastille ajoute : la confiance, jamais la couleur.
   *
   * Une salle muette garde le remplissage que dit son programme, mais creux —
   * on ne sait plus si elle le suit.
   */
  /** Ce que le hub sait d'une salle, ou null si sa vue ne l'a pas encore. */
  function vueDuHub(roomId) {
    return (donnees.diagnostics?.rooms ?? []).find((salle) => salle.roomId === roomId) ?? null
  }

  function sessionDe(sessions, sessionId) {
    return sessionId == null ? null : sessions.find((s) => s.id === sessionId) ?? null
  }

  function confiance(connectivity) {
    if (connectivity === 'DEGRADED') return ' doute'
    return connectivity == null || connectivity === 'ONLINE' ? '' : ' muette'
  }

  /** Onglet affiché dans la modale de consultation. */
  let encart = 'programme'
  let autreSalle = null
  let sessionsAutreSalle = []
  let sallesDisponibles = []

  /**
   * Intervenants d'un créneau, dans l'ordre du programme.
   *
   * Le point médian sépare mieux que la virgule des noms qui en contiennent
   * parfois une (« Dupont, Jean »).
   */
  function intervenants(session) {
    return (session?.speakers ?? []).map((p) => p.name).join(' · ')
  }

  /**
   * Rend une timeline de créneaux, celui en cours surligné.
   *
   * @param idActuel Créneau à surligner, ou null. La salle passe l'état réel
   *   qu'elle pilote — un talk lancé en retard reste le talk en cours —, une
   *   autre salle passe ce que dit le programme à l'heure du hub : on ne
   *   connaît pas son état, mais on connaît son horaire.
   */
  function creneaux(sessions, idActuel) {
    if (sessions.length === 0) return '<div class="text-xs text-attenue">Aucune session.</div>'
    const instant = maintenant()
    const actuel = idActuel ?? null

    const CRENEAU = 'grid grid-cols-[52px_1fr] items-baseline gap-2.5 rounded-md px-2.5 py-2'
    // "timeline" et "actuel" sont des accroches, pas du style : la première
    // sert aux tests, la seconde au défilement automatique vers la conférence.
    return '<div class="timeline flex flex-col gap-1">' + sessions.map((s, i) => {
      // "actuel" reste un nom de classe : rendreEncart s'en sert pour faire
      // défiler la timeline jusqu'à la conférence en cours.
      const fin = EtatSalle.finEffectiveA(sessions, i)
      const etat = s.id === actuel
        ? 'actuel bg-[color-mix(in_srgb,var(--color-marque)_22%,transparent)] shadow-[inset_3px_0_0_var(--color-marque)]'
        : fin != null && fin < instant ? 'opacity-35' : ''
      const pause = s.kind === 'break' ? 'opacity-50' : ''
      const qui = intervenants(s)
      return '<div class="' + CRENEAU + ' ' + etat + ' ' + pause + '">' +
        '<div class="text-[13px] text-attenue tabular-nums">' + heure(s.startsAt, donnees.timezone) + '</div>' +
        '<div><div class="text-sm">' + echapper(s.title) + '</div>' +
        (qui ? '<div class="mt-0.5 text-xs text-attenue">' + echapper(qui) + '</div>' : '') + '</div></div>'
    }).join('') + '</div>'
  }

  function rendreEncart() {
    const conteneur = $('encart-contenu')
    $('choix-autre-salle').hidden = encart !== 'autre'

    if (encart === 'salles') {
      conteneur.innerHTML = rendreSalles()
      return
    }
    if (encart === 'questions') {
      rendreQuestions(conteneur)
      return
    }
    if (encart === 'autre') {
      /**
       * Ce qui se joue à côté, déduit du programme et de l'heure du hub.
       *
       * On ne reçoit pas l'état de l'autre salle ici — et on n'en veut pas :
       * le programme mis en cache répond même pendant une coupure, et l'heure
       * du hub porte le décalage, heure simulée comprise. Sans ce calcul, la
       * modale déroulait une liste sans dire où on en était.
       */
      conteneur.innerHTML = autreSalle == null
        ? '<div class="text-xs text-attenue">Choisissez une salle à suivre.</div>'
        : creneaux(sessionsAutreSalle, EtatSalle.timelinePosition(sessionsAutreSalle, maintenant()).current?.id ?? null)
      defilerVersActuel(conteneur)
      return
    }

    conteneur.innerHTML = creneaux(donnees.sessions, donnees.state.currentSession?.id ?? null)
    defilerVersActuel(conteneur)
  }

  /** Amène la conférence en cours sous les yeux : la timeline fait une journée. */
  function defilerVersActuel(conteneur) {
    const actuel = conteneur.querySelector('.actuel')
    if (actuel) actuel.scrollIntoView({ block: 'center' })
  }

  /** Programme d'une autre salle : chargé à la demande, pas dans le flux d'état. */
  async function chargerAutreSalle(roomId) {
    autreSalle = roomId
    try {
      const reponse = await fetch('/display/sessions?salle=' + encodeURIComponent(roomId))
      const corps = await reponse.json()
      sessionsAutreSalle = corps.sessions ?? []
    } catch {
      sessionsAutreSalle = []
    }
    rendreEncart()
  }

  /**
   * Programmes des autres salles, pour le flux d'en-tête.
   *
   * Tirés du programme mis en cache localement, pas de l'état des salles remonté
   * par le hub : le flux doit continuer à dire « l'autre salle finit dans 3 min »
   * pendant une coupure, puisque c'est le programme qui le détermine, pas le
   * réseau. Rechargés seulement quand le contenu du programme change.
   */
  const programmesSalles = new Map()
  let sallesProgramme = []
  let cleProgrammes = null

  async function chargerProgrammes() {
    const cle = String(donnees.state.contentHash)
    if (cle === cleProgrammes) return
    cleProgrammes = cle

    // Aperçu hors ligne : sans programmes figés, le flux se relirait
    // « programme inconnu » et personne ne le regarderait avant le jour J.
    if (window.__PROGRAMMES__) {
      sallesProgramme = window.__PROGRAMMES__.rooms ?? []
      for (const salle of sallesProgramme) {
        programmesSalles.set(salle.id, window.__PROGRAMMES__.sessions[salle.id] ?? [])
      }
      rendreFluxSalles()
      return
    }

    try {
      const reponse = await fetch('/display/sessions')
      const corps = await reponse.json()
      sallesProgramme = corps.rooms ?? []
    } catch {
      sallesProgramme = []
    }
    await Promise.all(sallesProgramme
      .filter((salle) => salle.id !== donnees.state.roomId)
      .map(async (salle) => {
        try {
          const reponse = await fetch('/display/sessions?salle=' + encodeURIComponent(salle.id))
          const corps = await reponse.json()
          programmesSalles.set(salle.id, corps.sessions ?? [])
        } catch {
          // Sans programme, le flux dira « programme inconnu » plutôt que de mentir.
        }
      }))
    rendreFluxSalles()
  }

  /**
   * Les autres salles, vues des deux sources qui en parlent.
   *
   * Le programme donne la liste et les créneaux même hub coupé ; l'état remonté
   * par le hub ajoute la connectivité et l'enregistrement quand il est joignable.
   */
  function autresSalles() {
    const parId = new Map()
    for (const salle of sallesProgramme) parId.set(salle.id, { id: salle.id, name: salle.name })
    for (const salle of donnees.diagnostics?.rooms ?? []) {
      const connue = parId.get(salle.roomId) ?? { id: salle.roomId, name: salle.name }
      connue.connectivity = salle.connectivity
      connue.recording = salle.recording
      parId.set(salle.roomId, connue)
    }
    parId.delete(donnees.state.roomId)
    return [...parId.values()]
  }

  function rendreFluxSalles() {
    const zone = $('flux-salles')
    const salles = autresSalles()
    if (salles.length === 0) {
      zone.innerHTML = ''
      return
    }
    const instant = maintenant()

    const html = salles.map((salle) => {
      const sessions = programmesSalles.get(salle.id) ?? []
      const vue = vueDuHub(salle.id)
      const { current: courante, next: suivante } = EtatSalle.timelinePosition(sessions, instant)
      const etat = etatSalle(salle.id, sessions, instant)

      let libelle = ''
      let detail = 'programme inconnu'
      let teinte = 'text-attenue'

      if (etat.classe === 'depassement') {
        // Le programme est passé au créneau suivant ; la salle, non. C'est
        // elle qui a raison, et c'est ce qui décale toute la journée.
        libelle = sessionDe(sessions, vue?.currentSessionId)?.title ?? courante?.title ?? ''
        detail = etat.libelle
        teinte = 'text-alerte'
      } else if (etat.classe === 'retard' || etat.classe === 'pas-commencee' || etat.classe === 'terminee') {
        libelle = courante?.title ?? ''
        detail = etat.libelle
        teinte = etat.classe === 'retard' ? 'text-attention' : 'text-attenue'
      } else if (courante != null && courante.kind === 'break') {
        // Pas de libellé : l'étiquette BREAK le dit déjà, et « Déjeuner » à la
        // place d'un titre de conférence se lisait comme une salle occupée. Ce
        // qui décide ici, c'est l'heure de reprise.
        detail = suivante == null ? 'pause' : 'reprise ' + heure(suivante.startsAt, donnees.timezone)
      } else if (courante != null) {
        libelle = courante.title
        const fin = EtatSalle.finEffectiveA(sessions, sessions.indexOf(courante))
        const restant = fin == null ? null : Math.round((fin - instant) / 60000)
        if (etat.classe === 'fin-proche') {
          detail = 'vers la fin · ' + duree(restant ?? 0)
          teinte = 'text-attention'
        } else {
          detail = courante.endsAt ? 'en cours · fin ' + heure(courante.endsAt, donnees.timezone) : 'en cours'
        }
      } else if (suivante != null) {
        libelle = suivante.title
        detail = 'à ' + heure(suivante.startsAt, donnees.timezone)
      } else if (sessions.length > 0) {
        detail = 'programme terminé'
      }

      const classe = etat.classe + confiance(vue?.connectivity ?? salle.connectivity)
      /**
       * L'étiquette du break, à côté du nom de la salle.
       *
       * Elle cohabite avec ce que fait la salle : « BREAK à venir » s'affiche
       * pendant qu'une conférence court encore, et c'est là qu'elle sert.
       */
      const pause = EtatSalle.pauseDesCreneaux(sessions, instant)
      const etiquette = pause == null
        ? ''
        : '<span class="shrink-0 rounded bg-fond px-1.5 py-0.5 text-[11px] ' +
          (pause.state === 'en-cours' ? 'text-attenue' : 'text-attention') + '">' +
          (pause.state === 'en-cours' ? 'BREAK' : 'BREAK à venir') + '</span>'

      return '<button data-salle="' + echapper(salle.id) + '" ' +
        'class="flex shrink-0 items-center gap-2 rounded-md border border-bord bg-surface2 px-2.5 py-1 text-xs font-normal">' +
        '<span class="pastille ' + classe + '"></span>' +
        '<span class="font-semibold">' + echapper(salle.name) + '</span>' +
        etiquette +
        (libelle ? '<span class="max-w-[26ch] truncate text-attenue">' + echapper(libelle) + '</span>' : '') +
        '<span class="' + teinte + ' tabular-nums">' + echapper(detail) + '</span>' +
        '</button>'
    }).join('')

    // Réécrit seulement quand le texte change : la fonction est appelée chaque
    // seconde, et remplacer le markup en continu ferait clignoter la ligne.
    if (zone.__html === html) return
    zone.__html = html
    zone.innerHTML = html
  }


  /**
   * Configuration de la salle.
   *
   * Le formulaire est construit **à l'ouverture**, jamais à chaque état reçu :
   * la régie en reçoit un toutes les quelques secondes, et reconstruire les
   * champs sous les doigts effacerait la saisie en cours. Ne suivent en direct
   * que l'état des deux OBS et la liste de leurs scènes.
   */
  const ROLES_PAR_INSTANCE = {
    A: [['LIVE', 'Direct'], ['HOLD', 'Habillage'], ['RELAY', 'Relais']],
    B: [['TALK', 'Talk complet'], ['CAM_ONLY', 'Caméra seule'], ['SLIDES_ONLY', 'Slides seules']],
  }

  /** Vrai si la configuration doit être reconstruite au prochain état reçu. */
  let refaireConfig = false
  let scenesRendues = ''

  function champ(id, libelle, valeur, aide) {
    return '<label class="mb-0.5 block text-xs text-attenue">' + echapper(libelle) + '</label>' +
      '<input class="champ py-2" id="' + id + '" value="' + echapper(valeur == null ? '' : valeur) + '">' +
      (aide ? '<div class="mt-0.5 text-[11px] text-attenue">' + echapper(aide) + '</div>' : '')
  }

  function optionsScenes(instance, valeur) {
    const scenes = donnees.diagnostics?.obs?.[instance]?.scenes ?? []
    const options = ['<option value="">— non configuré —</option>']
    for (const nom of scenes) {
      options.push('<option value="' + echapper(nom) + '">' + echapper(nom) + '</option>')
    }
    // La scène configurée peut ne pas exister dans OBS — c'est même le défaut
    // qu'on vient réparer ici. On la garde dans la liste, dite pour ce qu'elle est.
    if (valeur && scenes.indexOf(valeur) === -1) {
      options.push('<option value="' + echapper(valeur) + '">' + echapper(valeur) + " — absente d'OBS</option>")
    }
    return options.join('')
  }

  function blocObs(instance, titre, config) {
    const point = config.obs[instance]
    const roles = ROLES_PAR_INSTANCE[instance].map(([role, libelle]) =>
      '<div><label class="mb-0.5 block text-xs text-attenue">' + role + ' · ' + libelle + '</label>' +
      '<select class="champ py-2" id="cfg-role-' + instance + '-' + role + '">' +
      optionsScenes(instance, config.sceneRoles[instance]?.[role]) + '</select></div>').join('')

    return '<section class="panneau mb-3 p-3">' +
      '<div class="mb-2 flex items-center gap-2">' +
        '<h3 class="titre-panneau mb-0">' + echapper(titre) +
          '<span id="config-simule-' + instance + '"></span></h3>' +
        '<span class="flex-1 truncate text-xs text-attenue" id="config-etat-' + instance + '"></span>' +
        '<button class="btn btn-petit shrink-0" id="cfg-connect-' + instance + '">Connecter</button>' +
      '</div>' +
      '<div class="grid grid-cols-2 gap-2">' +
        '<div>' + champ('cfg-url-' + instance, 'Adresse WebSocket', point.url) + '</div>' +
        '<div><label class="mb-0.5 block text-xs text-attenue">Mot de passe</label>' +
          '<input type="password" class="champ py-2" id="cfg-pass-' + instance + '" placeholder="' +
            (point.hasPassword ? 'inchangé' : 'aucun') + '">' +
          (point.hasPassword
            ? '<label class="mt-1 flex items-center gap-1.5 text-[11px] text-attenue">' +
              '<input type="checkbox" id="cfg-pass-vide-' + instance + '"> retirer le mot de passe</label>'
            : '') +
        '</div>' +
      '</div>' +
      '<div class="mt-2 grid grid-cols-3 gap-2">' + roles + '</div>' +
      '</section>'
  }

  function rendreConfig() {
    const zone = $('config-contenu')
    const config = donnees.diagnostics?.config
    if (config == null) {
      zone.innerHTML = '<div class="text-sm text-attenue">Rien à configurer tant que le hub ' +
        "n'a pas répondu : c'est lui qui détient la configuration de la salle.</div>"
      return
    }

    const autres = (donnees.diagnostics?.rooms ?? []).filter((salle) => salle.roomId !== donnees.state.roomId)
    const relais = '<div><label class="mb-0.5 block text-xs text-attenue">Salle relayée</label>' +
      '<select class="champ py-2" id="cfg-relay">' +
      '<option value="">— aucune —</option>' +
      autres.map((salle) => '<option value="' + echapper(salle.roomId) + '">' + echapper(salle.name) + '</option>').join('') +
      '</select>' +
      '<div class="mt-0.5 text-[11px] text-attenue">Active le bouton « Relais » en projection. ' +
      "L'acheminement du flux reste une affaire de configuration OBS.</div></div>"

    zone.innerHTML =
      blocObs('A', 'OBS-A — projection', config) +
      blocObs('B', 'OBS-B — captation', config) +
      '<section class="panneau p-3">' +
        '<h3 class="titre-panneau">Salle</h3>' +
        '<div class="grid grid-cols-2 gap-2">' +
          '<div>' + champ('cfg-port', "Port de l'écran local", config.displayPort,
            'Prend effet au prochain démarrage du client.') + '</div>' +
          '<div>' + champ('cfg-slug', 'Préfixe des fichiers', config.fileSlug,
            "Utilisé dans les noms d'enregistrements. Vide : dérivé du nom de la salle.") + '</div>' +
          '<div>' + champ('cfg-root', 'Dossier des VOD', config.recordingRoot,
            'Où la régie relit les enregistrements (🎞 dans le panneau Captation). ' +
            'Vide : le dossier d\u2019OBS-B, qu\u2019elle lui demande. Ce champ ne déplace rien : ' +
            'c\u2019est OBS-B qui décide où il écrit.') + '</div>' +
          relais +
        '</div>' +
        /*
         * Ce que « Commencer » entraîne.
         *
         * Deux gestes que la régie faisait de mémoire, et qu'elle oubliait aux
         * moments les plus coûteux : lancer l'enregistrement, et passer à
         * l'antenne. Les rattacher au démarrage de la conférence les met là où
         * l'information existe — c'est le seul instant où l'on sait qu'un talk
         * commence.
         */
        '<h3 class="titre-panneau mt-3.5">Au d\u00e9marrage d\u2019une conf\u00e9rence</h3>' +
        '<label class="flex items-start gap-2 text-sm">' +
          '<input type="checkbox" id="cfg-prompt-rec" class="mt-0.5">' +
          '<span>Avertir si l\u2019enregistrement n\u2019est pas lanc\u00e9' +
          '<span class="block text-[11px] text-attenue">Une VOD manquante ne se rattrape pas le soir.</span>' +
          '</span></label>' +
        '<div class="mt-2"><label class="mb-0.5 block text-xs text-attenue" for="cfg-scene-demarrage">' +
          'Scène prise automatiquement</label>' +
          '<select class="champ py-2" id="cfg-scene-demarrage">' +
            '<option value="">— aucune bascule —</option>' +
            ROLES_PAR_INSTANCE.A.map(function (r) {
              return '<option value="' + r[0] + '">' + echapper(r[1]) + '</option>'
            }).join('') +
          '</select>' +
          '<div class="mt-0.5 text-[11px] text-attenue">Sans elle, l\u2019habillage reste \u00e0 l\u2019\u00e9cran pendant les premi\u00e8res phrases.</div>' +
        '</div>' +
      '</section>'

    // Les <select> portent leur valeur après insertion : la poser dans le
    // markup obligerait à recopier la logique de « scène absente d'OBS ».
    for (const instance of ['A', 'B']) {
      for (const [role] of ROLES_PAR_INSTANCE[instance]) {
        $('cfg-role-' + instance + '-' + role).value = config.sceneRoles[instance]?.[role] ?? ''
      }
    }
    $('cfg-relay').value = config.relaySourceRoomId ?? ''
    $('cfg-prompt-rec').checked = config.promptRecordingOnStart !== false
    $('cfg-scene-demarrage').value = config.sceneOnStart ?? ''

    for (const instance of ['A', 'B']) {
      $('cfg-connect-' + instance).onclick = () => void connecterInstance(instance)
    }

    scenesRendues = cleScenes()
    majEtatConfig()
  }

  function cleScenes() {
    return JSON.stringify([
      donnees.diagnostics?.obs?.A?.scenes ?? [],
      donnees.diagnostics?.obs?.B?.scenes ?? [],
    ])
  }

  /**
   * Ce qui suit l'état en direct, formulaire ouvert : la connexion des deux
   * OBS, leurs scènes, et la possibilité même d'enregistrer.
   */
  function majEtatConfig() {
    if (document.body.dataset.config !== 'ouverte') return

    for (const instance of ['A', 'B']) {
      const cible = $('config-etat-' + instance)
      if (cible == null) continue
      const obs = donnees.diagnostics?.obs?.[instance]
      const connecte = obs?.connected === true
      const manquants = connecte ? (obs.unresolvedRoles ?? []) : []
      const enAttente = donnees.diagnostics?.config?.obs?.[instance]?.pending === true

      cible.className = 'flex-1 truncate text-xs ' +
        (!connecte ? 'text-alerte' : manquants.length > 0 || enAttente ? 'text-attention' : 'text-ok')
      cible.textContent = (!connecte
        ? 'déconnecté'
        : manquants.length > 0
          ? 'connecté · rôles absents : ' + manquants.join(', ')
          : 'connecté · ' + (obs.currentSceneName ?? 'scène inconnue')) +
        // L'écart entre ce qui est enregistré et ce qui est branché : sans le
        // dire, un réglage juste resterait sans effet sans que personne ne voie
        // pourquoi.
        (enAttente ? ' · réglages non appliqués' : '')

      $('config-simule-' + instance).innerHTML = badgeSimule(instance)

      const bouton = $('cfg-connect-' + instance)
      if (bouton == null) continue
      bouton.textContent = connecte ? 'Reconnecter' : 'Connecter'
      // Reconnecter, c'est couper : jamais sous une prise en cours. Une
      // instance déconnectée reste reconnectable, même si son dernier état
      // connu disait « enregistre » — il est justement périmé.
      const prise = connecte && obs.recording === true
      bouton.disabled = prise
      bouton.title = prise
        ? "Enregistrement en cours sur cette instance : l'arrêter avant de reconnecter"
        : 'Applique les réglages ci-dessus à cette instance'
    }

    // Scènes relues : on remplace les options sans perdre le choix en cours.
    const cle = cleScenes()
    if (cle !== scenesRendues) {
      scenesRendues = cle
      for (const instance of ['A', 'B']) {
        for (const [role] of ROLES_PAR_INSTANCE[instance]) {
          const select = $('cfg-role-' + instance + '-' + role)
          if (select == null) continue
          const valeur = select.value
          select.innerHTML = optionsScenes(instance, valeur)
          select.value = valeur
        }
      }
    }

    // Le hub est la source de vérité : hors ligne, enregistrer serait une
    // promesse en l'air, la saisie repartirait au premier sync réussi.
    const enLigne = donnees.state.connectivity === 'ONLINE'
    const avis = $('config-avis')
    $('btn-config-enregistrer').disabled = !enLigne
    if (!enLigne) {
      avis.dataset.raison = 'hors-ligne'
      avis.className = 'flex-1 text-xs text-attention'
      avis.textContent = "Hub injoignable : la configuration s'enregistre sur le hub, " +
        'elle serait perdue au prochain sync.'
    } else if (avis.dataset.raison === 'hors-ligne') {
      avis.dataset.raison = ''
      avis.className = 'flex-1 text-xs text-attenue'
      avis.textContent = ''
    }
  }

  /** Ce que le formulaire dit, sous la forme attendue par le hub. */
  function lireConfig() {
    const config = donnees.diagnostics.config

    const point = (instance) => {
      const valeur = { url: $('cfg-url-' + instance).value.trim() }
      const vider = $('cfg-pass-vide-' + instance)
      const saisi = $('cfg-pass-' + instance).value
      // Champ vide = inchangé : la page n'a jamais eu le mot de passe, elle ne
      // peut pas le renvoyer pour le conserver.
      if (vider != null && vider.checked) valeur.password = null
      else if (saisi.length > 0) valeur.password = saisi
      return valeur
    }

    const roles = (instance) => {
      // On repart de l'existant : un rôle mappé hors des trois proposés ici
      // — cas rare mais légitime — ne doit pas disparaître à l'enregistrement.
      const suivant = Object.assign({}, config.sceneRoles[instance])
      for (const [role] of ROLES_PAR_INSTANCE[instance]) {
        const valeur = $('cfg-role-' + instance + '-' + role).value
        if (valeur) suivant[role] = valeur
        else delete suivant[role]
      }
      return suivant
    }

    const texte = (id) => {
      const valeur = $(id).value.trim()
      return valeur.length === 0 ? null : valeur
    }

    return {
      obs: { A: point('A'), B: point('B') },
      sceneRoles: { A: roles('A'), B: roles('B') },
      displayPort: Number($('cfg-port').value) || config.displayPort,
      recordingRoot: texte('cfg-root'),
      fileSlug: texte('cfg-slug'),
      relaySourceRoomId: $('cfg-relay').value || null,
      promptRecordingOnStart: $('cfg-prompt-rec').checked,
      sceneOnStart: $('cfg-scene-demarrage').value || null,
    }
  }

  function ouvrirConfig() {
    fermerModale()
    fermerVod()
    document.body.dataset.config = 'ouverte'
    if (donnees) rendreConfig()
  }

  function fermerConfig() {
    document.body.dataset.config = 'fermee'
  }

  /**
   * Contrôle des rushes.
   *
   * La question à laquelle cette modale répond est celle qu'on se pose au
   * démontage : « est-ce qu'on a bien tout ? » Le chronomètre de la régie a dit
   * qu'on enregistrait ; il ne dit pas qu'OBS écrivait vraiment quelque chose
   * d'exploitable. Entre les deux, il y a un disque plein, un encodeur qui a
   * lâché, une carte d'acquisition débranchée — et personne ne s'en aperçoit
   * avant le montage, quand la salle n'existe plus.
   *
   * Rien n'est chargé tant qu'on n'ouvre pas : lire le dossier des captations à
   * chaque tic d'horloge coûterait un accès disque par seconde pour une liste
   * qu'on consulte trois fois dans la journée.
   */
  let vod = null
  let vodEnCours = false
  /** Rush déplié pour aperçu, et l'endroit du fichier qu'on regarde. */
  let vodApercu = null
  /** Téléversements, sondés tant que la modale est ouverte. */
  let vodMontees = null
  let vodMonteesTimer = null

  /** Vingt secondes : assez pour entendre le son et voir le cadrage, pas plus. */
  const EXTRAIT_MS = 20_000

  const BADGES_VOD = {
    ok: ['Exploitable', 'border-ok/50 text-ok'],
    suspect: ['À revoir', 'border-attention/50 text-attention'],
    illisible: ['Illisible', 'border-alerte/60 text-alerte'],
  }

  function tailleFichier(octets) {
    if (octets >= 1e9) return (octets / 1e9).toFixed(1).replace('.', ',') + ' Go'
    if (octets >= 1e6) return Math.round(octets / 1e6) + ' Mo'
    return Math.max(1, Math.round(octets / 1e3)) + ' ko'
  }

  function dureeCourte(ms) {
    const total = Math.round(ms / 1000)
    const deux = (valeur) => String(valeur).padStart(2, '0')
    const heures = Math.floor(total / 3600)
    const restant = deux(Math.floor((total % 3600) / 60)) + ':' + deux(total % 60)
    return heures > 0 ? heures + ':' + restant : restant
  }

  async function chargerVod() {
    try {
      const reponse = await fetch('/control/recordings')
      const corps = await reponse.json()
      vod = { root: corps.root ?? null, entries: corps.entries ?? [], outils: corps.outils ?? null }
      if (corps.ok === false && corps.message) toast(corps.message, true)
    } catch (cause) {
      vod = { root: null, entries: [], outils: null }
      toast('Le service local ne répond pas', true)
    }
    rendreVod()
  }

  /**
   * Téléversements en cours, sondés plutôt que poussés.
   *
   * Même choix que la charge du poste : un pourcentage qui avance placé dans le
   * flux d'état republierait tout le diagnostic à chaque part. Ici, seule une
   * modale ouverte interroge, et une salle dont personne ne regarde les rushes
   * ne paie rien.
   */
  async function chargerMontees() {
    try {
      const reponse = await fetch('/control/uploads')
      const corps = await reponse.json()
      vodMontees = corps.ok === false ? null : corps
    } catch (cause) {
      vodMontees = null
    }
    rendreRegulateur()
    rendreVod()
  }

  function rendreRegulateur() {
    const zone = $('vod-regulateur')
    const verdict = vodMontees?.verdict
    /**
     * Rien à dire quand tout va, ni quand il n'y a rien à faire aller.
     *
     * « desactive » n'est pas une attente : c'est un hub sans stockage, donc
     * une fonctionnalité que personne n'a demandée. L'annoncer en ambre à
     * chaque ouverture de la modale, toute la journée, la ferait passer pour
     * une panne — et userait le bandeau avant le jour où il dit vrai.
     */
    if (verdict == null || verdict.autorise || verdict.raison === 'desactive') {
      zone.className = 'hidden border-b border-bord px-4 py-1.5 text-[11px]'
      zone.textContent = ''
      return
    }
    zone.className = 'border-b border-bord px-4 py-1.5 text-[11px] text-attention'
    zone.textContent = 'Téléversement en attente — ' + verdict.texte + '.'
  }

  /** État de montée d'un fichier, ou nul s'il n'a jamais été mis en file. */
  function monteeDe(fichier) {
    return (vodMontees?.entrees ?? []).find((entree) => entree.file === fichier) ?? null
  }

  function ligneVod(entree) {
    const controle = entree.check
    const badge = controle == null
      ? ['Non vérifié', 'border-bord text-attenue']
      : (BADGES_VOD[controle.status] ?? ['Non vérifié', 'border-bord text-attenue'])

    const sidecar = entree.sidecar
    const duree = controle?.probe?.durationMs ?? sidecar?.durationMs ?? null
    const qui = (sidecar?.speakers ?? []).map((personne) => personne.name).filter(Boolean).join(', ')

    // Ce qui se lit d'un coup d'œil : quand, combien, et ce qui manque déjà.
    const details = []
    if (sidecar == null) details.push('sidecar absent')
    else {
      details.push(heure(sidecar.startedAt, donnees.timezone))
      const marqueurs = (sidecar.markers ?? []).length
      if (marqueurs > 0) details.push(marqueurs + ' marqueur' + (marqueurs > 1 ? 's' : ''))
    }
    if (duree != null) details.push(dureeCourte(duree))
    details.push(tailleFichier(entree.sizeBytes))
    if (entree.enEcriture) details.push('encore en écriture')
    if (controle != null && controle.by === 'operateur') details.push('verdict de la régie')

    // L'état de montée se lit dans la même ligne que le reste : c'est la même
    // question — « ce rush est-il en sécurité ? » — et la séparer en deux
    // colonnes obligerait à croiser deux listes des yeux.
    const montee = monteeDe(entree.file)
    const LIBELLES_MONTEE = {
      attente: 'téléversement en attente',
      'en-cours': 'téléversement en cours',
      termine: 'téléversé',
      abandonne: 'téléversement abandonné',
      echoue: 'téléversement en échec',
    }
    if (montee != null) {
      const libelle = LIBELLES_MONTEE[montee.state] ?? montee.state
      details.push(
        montee.state === 'en-cours' ? libelle + ' — ' + montee.pourcent + ' %' : libelle,
      )
    }

    const raisons = controle == null || controle.reasons.length === 0
      ? ''
      : '<div class="mt-1 text-[11px] ' +
        (controle.status === 'ok' ? 'text-attenue' : 'text-attention') + '">' +
        echapper(controle.reasons.join(' · ')) + '</div>'

    // L'erreur du stockage est reprise telle quelle : « AccessDenied » est le
    // seul mot qu'on puisse porter à qui tient le bucket.
    const echecMontee = montee?.erreur == null
      ? ''
      : '<div class="mt-1 text-[11px] text-alerte">Téléversement : ' +
        echapper(montee.erreur) + '</div>'

    const bouton = (verdict, libelle, titre, classes) =>
      '<button class="btn btn-petit ' + classes + '" title="' + echapper(titre) + '" ' +
      'data-vod-action="' + verdict + '" data-vod-fichier="' + echapper(entree.file) + '">' +
      libelle + '</button>'

    // « Actif » sur le verdict déjà posé : le même bouton l'enlève, sinon une
    // fausse manœuvre resterait à l'écran sans moyen de la reprendre.
    const pose = (verdict) =>
      controle != null && controle.by === 'operateur' && controle.status === verdict ? ' actif' : ''

    return '<div class="grid grid-cols-[1fr_auto] items-start gap-3 rounded-lg border border-bord p-2.5">' +
      '<div class="min-w-0">' +
        '<div class="flex flex-wrap items-center gap-2">' +
          '<span class="rounded border px-1.5 py-px text-[10px] font-semibold tracking-[.08em] uppercase ' +
            badge[1] + '">' + badge[0] + '</span>' +
          '<span class="truncate font-mono text-[12px] text-attenue">' + echapper(entree.file) + '</span>' +
        '</div>' +
        '<div class="mt-1 truncate text-sm">' + echapper(sidecar?.title ?? 'Titre inconnu') +
          (qui ? '<span class="text-attenue"> — ' + echapper(qui) + '</span>' : '') + '</div>' +
        '<div class="mt-0.5 text-[11px] text-attenue">' + echapper(details.join(' · ')) + '</div>' +
        raisons +
        echecMontee +
      '</div>' +
      '<div class="flex shrink-0 items-center gap-1">' +
        '<button class="btn btn-petit' + (vodApercu?.file === entree.file ? ' actif' : '') + '" ' +
          'title="Voir et entendre un extrait" data-vod-apercu="' + echapper(entree.file) + '">👁</button>' +
        bouton('inspect', 'Vérifier', 'Relit le conteneur : pistes, durée réelle, débit', '') +
        boutonMontee(entree, montee) +
        bouton('ok', '✓', 'Fichier ouvert et relu : exploitable', pose('ok')) +
        bouton('illisible', '✕', 'Fichier inexploitable : à refaire ou à signaler', pose('illisible')) +
      '</div>' +
      panneauApercu(entree) +
    '</div>'
  }

  /**
   * Le bouton de téléversement d'une ligne.
   *
   * Trois états, et un seul bouton : rien (⬆), en cours (Annuler), terminé
   * (rien à proposer). Un rush déjà chez le stockage ne doit pas offrir de
   * bouton qui repaierait trois gigaoctets sur le réseau de l'événement au
   * premier clic distrait.
   *
   * Absent tant que le hub n'a pas de destination : un bouton qui échoue à
   * chaque clic est pire qu'un bouton absent, et l'en-tête dit déjà pourquoi.
   */
  function boutonMontee(entree, montee) {
    if (vodMontees == null || vodMontees.verdict?.raison === 'desactive') return ''

    if (montee?.state === 'en-cours' || montee?.state === 'attente') {
      return '<button class="btn btn-petit" title="Renoncer à ce téléversement" ' +
        'data-vod-annuler="' + echapper(entree.file) + '">Annuler</button>'
    }
    if (montee?.state === 'termine') {
      return '<span class="px-1.5 text-[13px] text-attenue" title="Déjà chez le stockage">☁</span>'
    }
    const titre = entree.enEcriture
      ? 'Prise encore en cours : le fichier partira une fois arrêtée'
      : 'Envoyer ce rush et son sidecar au stockage'
    return '<button class="btn btn-petit" title="' + echapper(titre) + '" ' +
      'data-vod-monter="' + echapper(entree.file) + '">⬆</button>'
  }

  /**
   * Aperçu d'un rush, déplié sous sa ligne.
   *
   * Les rushes d'OBS sont des Matroska, qu'aucun navigateur ne sait ouvrir, et
   * ils pèsent plusieurs gigaoctets : le lecteur reçoit un extrait de vingt
   * secondes remballé en MP4 par ffmpeg, produit à la demande et jamais écrit
   * sur le disque. Les points de départ sautent aux endroits où une prise se
   * casse d'habitude — le tout début, et la fin.
   */
  function panneauApercu(entree) {
    if (vodApercu == null || vodApercu.file !== entree.file) return ''

    const encode = encodeURIComponent(entree.file)
    const duree = entree.check?.probe?.durationMs ?? entree.sidecar?.durationMs ?? null
    const points = duree == null || duree < 60_000
      ? [['Début', 0]]
      : [
          ['Début', 0],
          ['25 %', Math.round(duree * 0.25)],
          ['Milieu', Math.round(duree * 0.5)],
          ['75 %', Math.round(duree * 0.75)],
          ['Fin', Math.max(0, duree - EXTRAIT_MS)],
        ]

    const ffmpeg = vod?.outils?.ffmpeg === true
    const positions = !ffmpeg ? '' : points.map(([libelle, position]) =>
      '<button class="btn btn-petit px-2 py-1 text-[11px]' +
      (position === vodApercu.at ? ' actif' : '') + '" data-vod-position="' + position +
      '" data-vod-fichier="' + echapper(entree.file) + '">' + libelle + '</button>').join('')

    // Sans ffmpeg, on sert le fichier tel quel : le navigateur lira un MP4 et
    // butera sur un Matroska. Le dire d’avance vaut mieux qu’un lecteur noir.
    const source = ffmpeg
      ? '/control/recordings/extrait?file=' + encode + '&at=' + vodApercu.at + '&duree=' + EXTRAIT_MS
      : '/control/recordings/fichier?file=' + encode

    const avis = ffmpeg
      ? 'Extrait de ' + Math.round(EXTRAIT_MS / 1000) + ' s, remballé à la volée — le fichier n’est pas modifié.'
      : 'ffmpeg introuvable : lecture directe du fichier. Un Matroska ne s’ouvrira pas dans le navigateur — passez par « Fichier brut ».'

    return '<div class="col-span-2 mt-2 border-t border-bord pt-2">' +
      '<div class="mb-1.5 flex flex-wrap items-center gap-1.5">' +
        (ffmpeg ? '<span class="text-[11px] text-attenue">Extrait à partir de</span>' : '') +
        positions +
        '<a class="btn btn-petit ml-auto px-2 py-1 text-[11px]" target="_blank" rel="noreferrer" ' +
        'href="/control/recordings/fichier?file=' + encode + '">Fichier brut</a>' +
      '</div>' +
      '<video class="max-h-[46vh] w-full rounded-lg bg-black" controls autoplay playsinline ' +
      'src="' + echapper(source) + '"></video>' +
      '<div class="mt-1 text-[11px] text-attenue" data-vod-avis>' + echapper(avis) + '</div>' +
    '</div>'
  }

  function rendreVod() {
    const conteneur = $('vod-contenu')
    $('vod-racine').textContent = vod?.root ?? ''

    if (vod == null) {
      conteneur.innerHTML = '<div class="text-xs text-attenue">Lecture du dossier…</div>'
      return
    }
    if (vod.root == null) {
      // Une liste vide se lirait comme une journée perdue : dire pourquoi.
      conteneur.innerHTML = '<div class="text-sm text-attention">Aucun dossier d’enregistrement connu. ' +
        'Renseignez-le dans la configuration de la salle, ou connectez OBS-B — ' +
        'c’est lui qui dit où il écrit.</div>'
      return
    }
    if (vod.entries.length === 0) {
      conteneur.innerHTML = '<div class="text-sm text-attenue">Aucun fichier vidéo dans ce dossier.</div>'
      return
    }

    // Ce dont la machine ne dispose pas, dit une fois en haut plutôt que
    // découvert bouton par bouton.
    const manquants = []
    if (vod.outils?.ffprobe === false) manquants.push('« Vérifier » se limite à la taille et au sidecar')
    if (vod.outils?.ffmpeg === false) manquants.push('les aperçus ne peuvent pas être produits')
    const avertissement = manquants.length === 0
      ? ''
      : '<div class="mb-2 rounded-lg border border-attention/40 px-2.5 py-1.5 text-[11px] text-attention">' +
        (vod.outils?.ffprobe === false && vod.outils?.ffmpeg === false
          ? 'ffmpeg et ffprobe introuvables sur cette machine : '
          : (vod.outils?.ffprobe === false ? 'ffprobe introuvable : ' : 'ffmpeg introuvable : ')) +
        manquants.join(', ') + '.</div>'

    conteneur.innerHTML = avertissement + '<div class="flex flex-col gap-1.5">' +
      vod.entries.map(ligneVod).join('') + '</div>'
    for (const bouton of conteneur.querySelectorAll('[data-vod-action]')) {
      bouton.onclick = () => actionVod(bouton, bouton.dataset.vodFichier, bouton.dataset.vodAction)
    }
    for (const bouton of conteneur.querySelectorAll('[data-vod-apercu]')) {
      bouton.onclick = () => basculerApercu(bouton.dataset.vodApercu)
    }
    for (const bouton of conteneur.querySelectorAll('[data-vod-monter]')) {
      bouton.onclick = () => void monterVod(bouton.dataset.vodMonter)
    }
    for (const bouton of conteneur.querySelectorAll('[data-vod-annuler]')) {
      bouton.onclick = () => void annulerVod(bouton.dataset.vodAnnuler)
    }
    for (const bouton of conteneur.querySelectorAll('[data-vod-position]')) {
      bouton.onclick = () => {
        vodApercu = { file: bouton.dataset.vodFichier, at: Number(bouton.dataset.vodPosition) }
        rendreVod()
      }
    }
    for (const lecteur of conteneur.querySelectorAll('video')) {
      // Le clic sur 👁 vaut geste utilisateur : la lecture peut partir seule.
      // Refusée — politique du navigateur —, les commandes restent là.
      try {
        const lancee = lecteur.play?.()
        if (lancee != null && typeof lancee.catch === 'function') lancee.catch(() => {})
      } catch (cause) {
        // Un lecteur qui refuse de démarrer ne doit pas emporter le rendu de la
        // liste avec lui.
      }
      lecteur.onerror = () => {
        const avis = lecteur.parentElement?.querySelector('[data-vod-avis]')
        if (avis == null) return
        avis.className = 'mt-1 text-[11px] text-alerte'
        avis.textContent = 'Extrait illisible : ce fichier ne s’ouvre pas. ' +
          'C’est en soi une réponse — lancez « Vérifier » pour savoir ce qui manque.'
      }
    }
  }

  /** Déplie l'aperçu d'un rush, ou le referme si c'est déjà le sien. */
  function basculerApercu(fichier) {
    vodApercu = vodApercu != null && vodApercu.file === fichier ? null : { file: fichier, at: 0 }
    rendreVod()
  }

  async function actionVod(bouton, fichier, action) {
    const entree = (vod?.entries ?? []).find((candidat) => candidat.file === fichier)
    // Lire un rush de deux heures prend quelques secondes : sans ce retour, on
    // reclique, et le disque se retrouve à répondre trois fois à la question.
    const libelle = bouton.innerHTML
    bouton.disabled = true
    if (action === 'inspect') bouton.textContent = '…'
    try {
      if (action === 'inspect') {
        await agir({ action: 'vod.inspect', file: fichier })
      } else {
        const controle = entree?.check
        const deja = controle != null && controle.by === 'operateur' && controle.status === action
        await agir({ action: 'vod.verdict', file: fichier, status: deja ? null : action })
      }
    } finally {
      bouton.disabled = false
      bouton.innerHTML = libelle
    }
    await chargerVod()
  }

  /**
   * Contrôle de tout le dossier, un fichier après l'autre.
   *
   * En série, et pas en parallèle : ffprobe lit réellement les fichiers, et
   * lancer six lectures de rushes de deux heures sur le disque qui enregistre
   * est exactement ce qu'on ne veut pas pendant une conférence. Sans toast par
   * fichier non plus — douze messages à la suite ne disent rien de plus que le
   * compte affiché en haut.
   */
  async function verifierToutVod() {
    if (vod == null || vodEnCours) return
    const cibles = vod.entries.map((entree) => entree.file)
    if (cibles.length === 0) return

    vodEnCours = true
    $('btn-vod-tout').disabled = true
    try {
      for (let index = 0; index < cibles.length; index += 1) {
        $('vod-avancement').textContent = 'contrôle ' + (index + 1) + ' / ' + cibles.length
        try {
          await fetch('/control/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'vod.inspect', file: cibles[index] }),
          })
        } catch (cause) {
          toast('Le service local ne répond pas', true)
          break
        }
      }
    } finally {
      vodEnCours = false
      $('btn-vod-tout').disabled = false
      $('vod-avancement').textContent = ''
    }

    await chargerVod()
    const douteux = (vod?.entries ?? []).filter((entree) => entree.check != null && entree.check.status !== 'ok')
    toast(
      douteux.length === 0
        ? cibles.length + ' enregistrement(s) contrôlé(s), rien à signaler'
        : douteux.length + ' enregistrement(s) à revoir',
      douteux.length > 0,
    )
  }

  /**
   * Met un rush en file, ou tout ce qui reste.
   *
   * Aucune fenêtre de confirmation, et surtout pas une native : elle bloque la
   * boucle de rendu de la page, donc le chronomètre et le flux des salles, en
   * pleine conférence. Le geste n'est de toute façon pas destructif — il met en
   * file, il ne lit rien tout de suite.
   *
   * Le seul cas qui mérite un mot est la captation en cours : c'est le seul où
   * le régulateur refusera *malgré* la demande manuelle, parce qu'on ne lit pas
   * le disque sur lequel un master s'écrit. On le dit en passant, le bandeau
   * d'en-tête le répète tant que ça dure, et le fichier part dès l'arrêt.
   */
  async function monterVod(fichier) {
    const resultat = await agir({ action: 'vod.upload', file: fichier ?? null })
    if (resultat.ok && donnees.state?.recording === true) {
      toast('Mis en file — départ à l’arrêt de la captation en cours')
    }
    await chargerMontees()
  }

  async function annulerVod(fichier) {
    await agir({ action: 'vod.upload.cancel', file: fichier })
    await chargerMontees()
  }

  function ouvrirVod() {
    fermerModale()
    fermerConfig()
    document.body.dataset.vod = 'ouverte'
    // Relu à chaque ouverture : le dossier s'est rempli depuis la dernière fois.
    vod = null
    vodApercu = null
    vodMontees = null
    rendreVod()
    void chargerVod()
    void chargerMontees()
    /**
     * Sondage tant que la modale est ouverte, et lui seul.
     *
     * Trois secondes : assez pour qu'un pourcentage avance sous les yeux, assez
     * peu pour qu'une salle dont la modale est fermée — c'est-à-dire toute la
     * journée — ne génère aucun trafic. L'intervalle est coupé à la fermeture,
     * sans quoi il survivrait à toutes les ouvertures de la journée.
     */
    if (vodMonteesTimer == null) vodMonteesTimer = setInterval(() => void chargerMontees(), 3000)
  }

  function fermerVod() {
    document.body.dataset.vod = 'fermee'
    if (vodMonteesTimer != null) clearInterval(vodMonteesTimer)
    vodMonteesTimer = null
  }

  function rendreAppairage() {
    const appairage = donnees.pairing
    const requis = appairage != null && appairage.status !== 'paired'
    document.body.dataset.appairage = requis ? 'requis' : 'ok'
    if (!requis) return

    const titres = {
      idle: 'Appairage de la salle',
      waiting: 'Appairage de la salle',
      // Un jeton refusé n'est pas un premier démarrage : le dire évite de
      // croire à une machine neuve alors qu'elle a été révoquée, ou que la
      // base du hub a été recréée.
      expired: 'Cette machine doit être réappairée',
      failed: 'Appairage impossible',
    }
    const salles = appairage.rooms ?? []
    const enChoix = appairage.userCode == null

    $('appairage-titre').textContent = enChoix
      ? 'Quelle salle dessert ce poste ?'
      : (titres[appairage.status] ?? 'Appairage de la salle')
    $('appairage-intro').textContent = enChoix
      ? 'Ce choix accompagne la demande : la console le retrouvera pré-sélectionné.'
      : "Cette machine n'est pas encore liée à une salle."

    // Choix des salles, tant qu'aucun code n'a été demandé.
    const choix = $('appairage-choix')
    choix.hidden = !enChoix
    if (enChoix) {
      if (salles.length === 0) {
        choix.innerHTML = '<div class="py-3.5 text-sm text-attenue">Hub injoignable — la liste des salles ' +
          "apparaîtra dès qu'il répondra.</div>"
      } else if (choix.dataset.rendu !== String(salles.length)) {
        choix.dataset.rendu = String(salles.length)
        choix.innerHTML = ''
        for (const salle of salles) {
          const bouton = document.createElement('button')
          bouton.className = 'btn flex items-center justify-between px-5 py-4 text-left text-[17px]'
          bouton.innerHTML = echapper(salle.name) + '<span class="opacity-50">→</span>'
          bouton.onclick = () => agir({ action: 'pairing.chooseRoom', roomId: salle.id })
          choix.appendChild(bouton)
        }
      }
    }

    const demandee = salles.find((s) => s.id === appairage.requestedRoomId)
    $('appairage-demandee').innerHTML =
      !enChoix && demandee ? 'Salle demandée : <strong>' + echapper(demandee.name) + '</strong>' : ''

    $('appairage-code').hidden = enChoix
    $('appairage-consigne').hidden = enChoix
    $('appairage-code').textContent = appairage.userCode ?? '········'
    $('appairage-erreur').textContent = appairage.message ?? ''

    const lien = $('appairage-lien')
    if (appairage.verificationUri) {
      lien.href = appairage.verificationUri
      lien.textContent = appairage.verificationUri
    } else {
      lien.textContent = ''
    }
  }

  const LIEN_ECRAN = 'block rounded-md px-3 py-2.5 text-sm text-texte no-underline hover:bg-bord'

  function rendreEcrans() {
    const liste = $('liste-ecrans')
    if (liste.childElementCount > 0) return
    for (const [chemin, titre, description] of ECRANS) {
      const lien = document.createElement('a')
      lien.href = chemin
      // Nouvel onglet : ouvrir la projection dans la fenêtre de régie
      // remplacerait les commandes par l'écran de salle, en pleine intervention.
      lien.target = '_blank'
      lien.rel = 'noopener'
      lien.className = LIEN_ECRAN
      lien.innerHTML = echapper(titre) + '<small class="mt-0.5 block text-xs text-attenue">' + echapper(description) + '</small>'
      liste.appendChild(lien)
    }
    // Le mur public dépend du hub, pas du serveur local : ajouté seulement
    // quand la salle le connaît.
    const mur = donnees?.wall?.url
    if (mur) {
      const lien = document.createElement('a')
      lien.href = mur
      lien.target = '_blank'
      lien.rel = 'noopener'
      lien.className = LIEN_ECRAN
      lien.innerHTML = 'Mur public<small class="mt-0.5 block text-xs text-attenue">' + echapper(mur) + '</small>'
      liste.appendChild(lien)
    }
  }

  /**
   * Questions du public, et mise à l'antenne.
   *
   * Le bandeau live sert de support : il se superpose à la vidéo sans
   * interrompre le talk, ce qui est exactement ce qu'on veut d'une question
   * lue à voix haute — le speaker répond, la salle lit.
   */
  function rendreQuestions(conteneur) {
    const questions = donnees.diagnostics?.questions ?? []
    const vu = donnees.diagnostics?.questionsRefreshedAt
    const talk = donnees.diagnostics?.questionsSession ?? null
    const aLAntenne = donnees.state.question ?? null

    /**
     * Le talk dont on lit les questions, écrit en clair.
     *
     * La liste ne porte que celles de la conférence pilotée : sans ce rappel,
     * une liste vide se lit « personne n'a rien demandé » alors qu'elle veut
     * parfois dire « aucun talk n'est piloté ».
     */
    const entete = '<div class="mb-2.5 flex flex-wrap items-center gap-2">' +
      '<button class="btn btn-petit" id="btn-relire-questions">Relire</button>' +
      '<button class="btn btn-petit" id="btn-cacher-question">Retirer de l\u2019antenne</button>' +
      '<span class="flex-1 text-xs text-attenue">' +
      (vu == null ? 'Jamais relues' : 'Relues ' + heure(vu, donnees.timezone)) + '</span></div>' +
      '<div class="mb-2.5 text-xs text-attenue">' +
      (talk == null
        ? 'Aucune conférence pilotée : rien à mettre à l\u2019antenne.'
        : 'Questions posées sur <strong class="text-texte">' + echapper(talk.title) + '</strong>') +
      '</div>'

    if (questions.length === 0) {
      conteneur.innerHTML = entete +
        '<div class="text-xs text-attenue">' +
        (talk == null ? '' : 'Aucune question sur cette conférence pour le moment.') + '</div>'
    } else {
      conteneur.innerHTML = entete + '<div class="flex flex-col gap-1.5">' + questions.map((question) => {
        // La question déjà à l'antenne se reconnaît : sinon on la remet, ou on
        // cherche laquelle est projetée en relisant les trois premières.
        const active = aLAntenne != null && aLAntenne.text === question.text
        return '<div class="grid grid-cols-[auto_1fr_auto] items-center gap-2.5 rounded-md border px-2.5 py-2 ' +
          (active ? 'border-marque bg-surface2' : 'border-bord') + '">' +
          '<span class="rounded bg-surface2 px-1.5 py-0.5 text-xs tabular-nums">' + question.votes + '</span>' +
          '<div><div class="text-sm leading-snug">' + echapper(question.text) + '</div>' +
          (question.author ? '<div class="mt-0.5 text-xs text-attenue">' + echapper(question.author) + '</div>' : '') +
          '</div>' +
          '<button class="btn btn-petit afficher' + (active ? ' actif' : '') + '" data-texte="' +
          echapper(question.text) + '" data-auteur="' + echapper(question.author ?? '') + '">' +
          (active ? 'À l\u2019antenne' : 'Afficher') + '</button>' +
          '</div>'
      }).join('') + '</div>'
    }

    // Ce que « Afficher » fait, et ce qu'il ne fait pas : sans le dire, on
    // clique et on cherche la question sur le vidéoprojecteur.
    conteneur.insertAdjacentHTML('beforeend',
      '<div class="mt-2.5 text-[11px] leading-relaxed text-attenue">' +
      'Afficher met la question sur l\u2019habillage de captation — elle part donc ' +
      'dans la VOD — et sur le bandeau vidéo de la salle. Pour la projeter en grand ' +
      'devant le public, choisir « Question choisie » dans Écran de salle.</div>')

    $('btn-relire-questions').onclick = () => agir({ action: 'questions.refresh' })
    $('btn-cacher-question').onclick = () => agir({ action: 'question.set', text: null })
    conteneur.onclick = (evenement) => {
      const bouton = evenement.target.closest?.('.afficher')
      if (bouton == null) return
      agir({
        action: 'question.set',
        text: bouton.dataset.texte,
        author: bouton.dataset.auteur === '' ? null : bouton.dataset.auteur,
      })
    }
  }

  function rendreSalles() {
    const salles = donnees.diagnostics?.rooms ?? []
    if (salles.length === 0) return '<div class="text-xs text-attenue">Aucune salle connue du hub.</div>'

    const instant = maintenant()
    const lignes = salles.map((salle) => {
      const sessions = programmesSalles.get(salle.roomId) ?? []
      const etat = etatSalle(salle.roomId, sessions, instant)
      const classe = etat.classe + confiance(salle.connectivity)
      const attente = salle.outboxDepth > 0 ? salle.outboxDepth + ' en attente' : ''
      // Le libellé accompagne la pastille : une couleur seule ne se lit pas
      // quand on ne les distingue pas, et rien ne dit ici ce qui se joue.
      const coupee = salle.connectivity !== 'ONLINE'
      return '<div class="grid grid-cols-[1fr_auto_auto] items-center gap-2.5 border-t border-bord py-2 text-[13px] first:border-t-0">' +
        '<div><div class="font-semibold">' + echapper(salle.name) + '</div>' +
        '<div class="text-xs text-attenue">' + echapper(salle.sceneRole ?? 'scène inconnue') +
        (attente ? ' · ' + attente : '') + '</div></div>' +
        '<div>' + (salle.recording ? '<span class="badge running">rec</span>' : '') + '</div>' +
        '<div class="flex items-center gap-1.5 text-xs ' +
        etat.texte +
        '"><span>' + echapper(coupee ? 'salle muette' : etat.libelle) + '</span>' +
        '<span class="pastille ' + classe + '"></span></div>' +
        '</div>'
    }).join('')

    // Vue datée plutôt que vidée : une liste vide se lirait « aucune salle ».
    const vu = donnees.diagnostics?.roomsRefreshedAt
    const age = vu == null ? null : Math.round((Date.now() - Date.parse(vu)) / 1000)
    const perime = age != null && age > 60
      ? '<div class="mt-2 text-xs text-attention">Vue datée de ' + Math.round(age / 60) + ' min — hub injoignable ?</div>'
      : ''
    return lignes + perime
  }

  function rendreSignalements() {
    const zone = $('signalements')
    const limite = maintenant() - PEREMPTION_MS
    const liste = (donnees.state.notifications ?? [])
      .filter((signalement) => Date.parse(signalement.at) > limite)

    // Reconstruit seulement quand la liste change : la fonction est rappelée
    // chaque seconde pour faire tomber les signalements périmés, et réécrire le
    // bandeau en continu ferait disparaître la croix sous le curseur. C'est
    // aussi ce qui garde écarté un signalement que l'état pousse encore, le
    // temps que la demande de retrait arrive au runtime.
    const cle = liste.map((signalement) => signalement.id).join(',')
    if (zone.__cle === cle) return
    zone.__cle = cle

    zone.innerHTML = ''
    for (const signalement of liste) {
      const bloc = document.createElement('div')
      const teinte = signalement.level === 'warning'
        ? 'border-[#6b5220] bg-[#2f2412]' : 'border-bord bg-[#1b2536]'
      bloc.className = 'flex shrink-0 items-center gap-2.5 rounded-lg border px-3 py-1.5 text-[13px] ' + teinte
      bloc.innerHTML =
        '<span class="text-xs text-attenue tabular-nums">' + heure(signalement.at, donnees.timezone) + '</span>' +
        '<span>' + echapper(signalement.text) + '</span>'
      const fermer = document.createElement('button')
      fermer.className = 'fermer ml-auto cursor-pointer px-1.5 py-0.5 text-attenue'
      fermer.textContent = '×'
      fermer.onclick = () => {
        bloc.remove()
        void fetch('/control/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'notification.dismiss', id: signalement.id }),
        })
      }
      bloc.appendChild(fermer)
      zone.appendChild(bloc)
    }
  }

  /**
   * Temps qu'il devrait rester d'après le programme.
   *
   * Pas le temps écoulé depuis le début réel : c'est l'écart au créneau prévu
   * qui compte, parce que c'est lui qui décale la suite de la journée.
   */
  function resteMs() {
    const session = donnees.state.targetSession
    if (session?.endsAtMs == null) return null
    return session.endsAtMs - maintenant()
  }

  function resteAuProgramme() {
    const ms = resteMs()
    if (ms == null) return ''
    const minutes = Math.round(ms / 60000)
    if (minutes >= 0) return duree(minutes) + ' restantes au programme'
    return 'dépassement de ' + duree(-minutes)
  }

  /**
   * Met une durée en minutes sous forme lisible.
   *
   * Au-delà de l'heure, un compte en minutes cesse d'être exploitable : entre
   * deux journées, l'écart au programme s'exprimait en cinq chiffres.
   */
  function duree(minutes) {
    if (minutes < 60) return minutes + ' min'
    const heures = Math.floor(minutes / 60)
    if (heures < 24) return heures + ' h ' + String(minutes % 60).padStart(2, '0')
    return Math.floor(heures / 24) + ' j ' + (heures % 24) + ' h'
  }

  /**
   * Compte à rebours du créneau, à la seconde.
   *
   * Les minutes suffisent pour décider, les secondes pour tenir la fin d'un
   * talk : c'est dans les deux dernières minutes qu'on regarde cet affichage
   * en continu. Au-delà de l'heure, l'heure passe devant.
   */
  function chrono(ms) {
    const total = Math.floor(Math.abs(ms) / 1000)
    const heures = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const secondes = total % 60
    const tete = heures > 0 ? heures + ':' + String(minutes).padStart(2, '0') : String(minutes)
    return (ms < 0 ? '−' : '') + tete + ':' + String(secondes).padStart(2, '0')
  }

  function rendreConference() {
    // La cible, pas la session « en cours » : entre deux talks ou pendant une
    // pause, c'est la conférence qui arrive qu'on pilote.
    const session = donnees.state.targetSession
    const aVenir = donnees.state.targetIsUpcoming
    const etats = donnees.state.sessionStates ?? {}
    const statut = session ? (etats[session.id] ?? 'scheduled') : 'scheduled'

    $('titre-conf').textContent = session
      ? (aVenir ? heure(session.startsAt, donnees.timezone) + ' · ' + session.title : session.title)
      : 'Aucune conférence à piloter'
    const qui = $('qui-conf')
    const noms = intervenants(session)
    qui.textContent = noms
    qui.hidden = noms === ''

    const badge = $('badge-conf')
    badge.className = 'badge ' + statut
    badge.textContent =
      statut === 'running' ? 'en cours' : statut === 'ended' ? 'terminée' : aVenir ? 'à venir' : 'prête'

    /**
     * Les deux boutons suivent la table du cycle de vie, pas une condition
     * écrite ici.
     *
     * C'est la même table que le hub applique en écriture : un bouton actif
     * dont la procédure refuserait le geste — ou l'inverse — n'est plus
     * possible. Le refus sert d'infobulle, pour que la raison soit lisible sans
     * avoir à cliquer pour la découvrir.
     */
    const demarrer = $('btn-conf-demarrer')
    const terminer = $('btn-conf-terminer')
    for (const [bouton, action] of [[demarrer, 'start'], [terminer, 'end']]) {
      const refus = session == null
        ? 'Aucune conférence à piloter dans cette salle.'
        : EtatSalle.refusDeTransition(statut, action)
      bouton.disabled = refus != null
      if (refus == null) bouton.removeAttribute('title')
      else bouton.title = refus
    }
    demarrer.classList.toggle('actif', statut === 'running')

    const reste = resteAuProgramme()
    /**
     * Terminée : on nomme ce que le décompte vise.
     *
     * Le grand nombre compte jusqu'à la prochaine conférence, la ligne
     * « Suivant » juste en dessous annonce le prochain *créneau* — qui peut être
     * une pause. Les deux différaient sans que rien ne l'explique. L'heure ici
     * lève l'ambiguïté, et l'annulation reste à portée.
     */
    const prochaine = statut === 'ended' ? prochaineConference(maintenant()) : null
    $('conf-detail').textContent =
      statut === 'ended'
        ? (prochaine == null
            ? "Terminée. « Remettre à venir » si c'est une erreur."
            : 'Prochaine conférence à ' + heure(prochaine.startsAt, donnees.timezone) +
              ". « Remettre à venir » si c'est une erreur.")
        : statut === 'running'
          ? reste
          : aVenir
            ? "Pas encore commencée au programme — « Commencer » reste disponible."
            : reste || ''
    // Le dépassement est l'information qui déclenche une décision.
    $('conf-detail').style.color = reste.startsWith('dépassement') ? 'var(--color-alerte)' : ''

    // La conférence suivante : elle ne se pilote pas encore, mais elle dit si
    // on peut laisser filer cinq minutes ou pas.
    const instant = maintenant()
    const depart = session?.startsAtMs ?? instant
    const suivante = (donnees.sessions ?? []).find((s) => s.startsAtMs > depart)
    // Sur une deuxième ligne : accolés au titre, les noms sortaient du cadre
    // dès que le titre était long, et c'est le titre qui disparaissait.
    const quiSuivante = intervenants(suivante)
    $('suivant').innerHTML = suivante == null
      ? 'Plus rien après au programme.'
      : '<span class="text-attenue">Suivant</span> <span class="tabular-nums text-texte">' +
        heure(suivante.startsAt, donnees.timezone) + '</span> <span class="text-texte">· ' +
        echapper(suivante.title) + '</span>' +
        (quiSuivante ? '<div class="mt-0.5 text-texte">' + echapper(quiSuivante) + '</div>' : '')

    rendreRestant()
  }

  /**
   * Ce que compte le grand chronomètre.
   *
   * Avant le créneau, le temps qui reste **avant** de commencer ; à partir de
   * son heure, ce qu'il reste du créneau. Compter d'emblée vers la fin donnait
   * « 2:01:59 » en gros caractères à 8h38 sur la conférence de 9h50 : un
   * chiffre qui se lit comme un talk en cours, et qui a été lu ainsi.
   *
   * Un talk lancé en avance compte vers sa fin sans attendre son heure : dès
   * qu'on a appuyé sur « Commencer », c'est l'écart au programme qui décide de
   * la suite de la journée.
   */
  function comptePourLeChrono() {
    const session = donnees.state.targetSession
    if (session == null) return null
    const instant = maintenant()
    const statut = (donnees.state.sessionStates ?? {})[session.id] ?? 'scheduled'

    /**
     * Une conférence terminée ne décompte plus rien.
     *
     * Le chronomètre continuait sur son créneau : « Terminer » appuyé à 10:35,
     * il restait quinze minutes à l'écran sur un talk que la salle venait de
     * quitter. Ce qu'on vient y chercher à ce moment-là est la seule chose qui
     * décide de la suite — dans combien de temps la prochaine commence.
     */
    if (statut === 'ended') {
      const suivante = prochaineConference(instant)
      return suivante == null ? null : { ms: suivante.startsAtMs - instant, avantDebut: true }
    }

    if (statut === 'scheduled' && session.startsAtMs > instant) {
      return { ms: session.startsAtMs - instant, avantDebut: true }
    }
    return session.endsAtMs == null ? null : { ms: session.endsAtMs - instant, avantDebut: false }
  }

  /**
   * La prochaine conférence de la salle : celle qui va encore se tenir.
   *
   * Pauses sautées — un déjeuner n'est pas ce qu'on attend — et conférences
   * déjà terminées sautées aussi. La page ne tranche plus elle-même : la règle
   * est celle de l'automate, la même que le banc d'essai déroule.
   */
  function prochaineConference(instant) {
    return EtatSalle.prochaineConference(
      donnees.sessions ?? [],
      instant,
      donnees.state.sessionStates ?? {},
    )
  }

  /** Le grand compte à rebours, remis à jour chaque seconde par tic(). */
  function rendreRestant() {
    const el = $('restant')
    const compte = comptePourLeChrono()
    // Le badge dit ce que le nombre décompte : un temps d'antenne qui s'épuise,
    // ou une attente avant que ça reparte. Les deux se lisent pareil sans lui.
    $('badge-restant').hidden = compte == null || !compte.avantDebut
    if (compte == null) {
      el.textContent = '--:--'
      el.className = 'text-[40px] leading-none font-bold tabular-nums text-attenue'
      return
    }
    el.textContent = chrono(compte.ms)
    // Avant le début, le décompte ne réclame rien : atténué, il se distingue
    // d'un créneau qui court — lequel vire à l'attention puis à l'alerte.
    const teinte = compte.avantDebut
      ? 'text-attenue'
      : compte.ms < 0
        ? 'text-alerte'
        : compte.ms < 300_000
          ? 'text-attention'
          : 'text-texte'
    el.className = 'text-[40px] leading-none font-bold tabular-nums ' + teinte
  }

  function rendreDiagnostic() {
    const diag = donnees.diagnostics
    const LIGNE = 'flex items-center gap-2'
    if (!diag) { $('diag').innerHTML = '<div class="' + LIGNE + '">Régie en lecture seule</div>'; return }

    $('diag').innerHTML = ['A', 'B'].map((cle) => {
      const obs = diag.obs[cle]
      const connecte = obs?.connected === true
      const manquants = obs?.unresolvedRoles ?? []
      return '<div class="' + LIGNE + '">' +
        '<span class="pastille ' + (connecte ? '' : 'offline') + '"></span>' +
        '<span class="truncate">OBS ' + cle + (connecte ? ' — ' + echapper(obs.currentSceneName ?? 'scène inconnue') : ' — déconnecté') + '</span>' +
        badgeSimule(cle) +
        (manquants.length ? '<span class="ml-auto shrink-0 text-attention">rôles absents : ' + manquants.join(', ') + '</span>' : '') +
        '</div>'
    }).join('')

    $('journal').innerHTML = (diag.journal ?? []).map((entree) =>
      '<div class="' + (entree.level === 'warn' || entree.level === 'error' ? 'text-attention' : '') + '">' +
      echapper(entree.message) + '</div>').join('')
  }

  function rendre(nouvelles) {
    donnees = nouvelles
    const etat = donnees.state

    // Le titre suit l'événement, pas une constante du binaire : c'est la même
    // machine qui servira l'édition suivante, et la barre de fenêtre est le
    // premier endroit où un nom périmé se remarque.
    const nomEvenement = donnees.eventIdentity?.name
    if (nomEvenement) document.title = 'Régie — ' + nomEvenement

    $('salle').textContent = donnees.roomName ?? etat.roomId ?? 'Salle non appairée'

    // La profondeur de file est l'indicateur à surveiller pendant une coupure :
    // elle se lit dans le bandeau, et se détaille dans la bulle du hub.
    const profondeur = donnees.diagnostics?.outboxDepth ?? etat.outboxDepth ?? 0
    rendreHub(etat, profondeur)
    $('file').textContent = profondeur > 0 ? profondeur + ' en attente' : ''

    // Une heure calée sur un hub en temps simulé se lit de travers si on ne le
    // dit pas : l'écart avec la montre de l'opérateur ferait douter du reste.
    document.body.dataset.horloge = etat.simulatedClock ? 'simulee' : 'reelle'

    boutons($('modes'), MODES, etat.mode, (mode) => ({ action: 'display.set', mode }))
    // Le relais n'apparaît que s'il est configuré, et annonce sa source :
    // « Relais → track-2 » plutôt qu'un bouton dont personne ne sait ce qu'il montre.
    const source = donnees.diagnostics?.relaySourceRoomId
    const scenes = source
      ? [...SCENES_BASE, ['RELAY', 'Relais → ' + source, null]]
      : SCENES_BASE
    boutons($('scenes'), scenes, etat.sceneRole, (role) => ({ action: 'scene.set', role }))

    const rec = donnees.diagnostics?.recording
    /*
     * Le départ de la prise, et sur quelle horloge le compter.
     *
     * Un startedAtCorrigeMs renseigné veut dire « compte sur l'horloge du hub »
     * — le cas du développement, où l'on déroule une journée en la poussant, et
     * où le chronomètre doit dire la même chose que la durée finalement
     * enregistrée. Absent, on compte en temps réel, comme en production.
     */
    debutRec = rec?.active ? (rec.startedAtCorrigeMs ?? rec.startedAtMs) : null
    recSuitHorloge = rec?.active === true && rec.startedAtCorrigeMs != null
    const btnRec = $('btn-rec')
    btnRec.classList.toggle('actif', Boolean(rec?.active))
    btnRec.textContent = rec?.active ? 'Arrêter' : 'Enregistrer'
    btnRec.insertAdjacentHTML('beforeend', '<span class="touche">R</span>')
    $('btn-marqueur').disabled = !rec?.active
    $('marqueurs').textContent = rec?.active
      ? (rec.markers === 0 ? 'aucun marqueur' : rec.markers + ' marqueur(s)')
      : 'hors enregistrement'

    const btnStream = $('btn-stream')
    btnStream.classList.toggle('actif', etat.streaming === true)
    btnStream.textContent = etat.streaming ? 'Arrêter la diffusion' : 'Diffuser'

    // Liste des salles suivables, remplie une fois.
    const catalogue = donnees.diagnostics?.rooms ?? []
    if (catalogue.length > 0 && sallesDisponibles.length !== catalogue.length) {
      sallesDisponibles = catalogue
      const choix = $('choix-autre-salle')
      choix.innerHTML = '<option value="">Choisir une salle…</option>' +
        catalogue
          .filter((salle) => salle.roomId !== donnees.state.roomId)
          .map((salle) => '<option value="' + echapper(salle.roomId) + '">' + echapper(salle.name) + '</option>')
          .join('')
    }

    rendreAppairage()
    rendreSignalements()
    rendreEncart()
    rendreConference()
    rendreEcrans()
    rendreDiagnostic()
    rendreMode()
    for (const instance of ['A', 'B']) $('simule-' + instance).innerHTML = badgeSimule(instance)
    rendreFluxSalles()
    if (refaireConfig) { refaireConfig = false; rendreConfig() } else majEtatConfig()
    void chargerProgrammes()
    tic()
  }

  /**
   * Depuis quand le flux de la page est coupé, ou null s'il tient.
   *
   * Distinct de la connectivité affichée à côté, qui dit si la **salle** joint
   * le hub. Celle-ci dit si la **page** joint sa salle — deux pannes
   * différentes, et la seconde était muette.
   */
  let fluxCoupeDepuis = null

  /** Au-delà, une coupure cesse d'être une reconnexion et devient un écran mort. */
  const FLUX_MORT_MS = 4000

  function rendreVivacite() {
    const coupe = fluxCoupeDepuis != null && Date.now() - fluxCoupeDepuis > FLUX_MORT_MS
    $('flux-mort').hidden = !coupe
  }

  function tic() {
    if (!donnees) return
    const decalage = donnees.state.serverTimeOffsetMs || 0
    $('horloge').textContent = new Intl.DateTimeFormat('fr-FR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: donnees.timezone,
    }).format(new Date(Date.now() + decalage))

    rendreRestant()
    rendreFluxSalles()
    rendreSignalements()
    rendreVivacite()

    const duree = $('duree')
    if (debutRec == null) {
      duree.textContent = '00:00'
      duree.classList.add('inactif')
      return
    }
    duree.classList.remove('inactif')
    // maintenant() porte le décalage du hub, et le relit à chaque tic : c'est
    // ce qui fait avancer le chronomètre d'un coup quand on pousse l'horloge.
    const ecoule = Math.max(0, (recSuitHorloge ? maintenant() : Date.now()) - debutRec)
    const m = String(Math.floor(ecoule / 60000)).padStart(2, '0')
    const s = String(Math.floor((ecoule % 60000) / 1000)).padStart(2, '0')
    duree.textContent = m + ':' + s
  }
  setInterval(tic, 1000)

  /**
   * Charge du poste, relevée à part du flux d'état.
   *
   * Un appel toutes les cinq secondes plutôt qu'un champ de plus dans la charge
   * utile : la mesure est déjà une moyenne sur l'intervalle — interroger plus
   * souvent ne dirait rien de plus — et surtout une salle dont la régie est
   * fermée continue de n'émettre aucun trafic.
   */
  const CPU_PERIODE_MS = 5000
  /** Au-delà, l'encodage n'a plus de marge ; plus haut encore, il perd des images. */
  const CPU_ATTENTION = 0.7
  const CPU_ALERTE = 0.9

  /** Pastilles de l'en-tête : la couleur d'un niveau, et rien d'autre. */
  const PASTILLE_NIVEAU = { ok: '', attention: ' degraded', alerte: ' offline', inconnu: ' hors' }

  /** Les niveaux, du plus calme au plus grave. « inconnu » n'est pas une gravité. */
  const GRAVITE = ['ok', 'attention', 'alerte']

  /** Une barre de proportion, teintée par sa propre mesure. */
  function jauge(part, niveau) {
    return '<div class="jauge"><span class="niveau-' + niveau + '" style="width:' +
      Math.min(100, Math.max(0, part)) + '%"></span></div>'
  }

  /**
   * Le pire de deux niveaux — ce que la pastille du bandeau doit montrer.
   *
   * « inconnu » ne l'emporte sur rien : une mesure absente ne doit pas éteindre
   * l'alerte que l'autre est en train de donner.
   */
  function pire(a, b) {
    if (GRAVITE.indexOf(a) < 0) return b
    if (GRAVITE.indexOf(b) < 0) return a
    return GRAVITE.indexOf(a) >= GRAVITE.indexOf(b) ? a : b
  }

  /**
   * Remplit un indicateur d'en-tête : sa pastille, sa bulle, et ce qu'un lecteur
   * d'écran en dira.
   *
   * Les deux indicateurs passent par ici, et c'est le point : ils se lisent d'un
   * même coup d'œil parce qu'ils sont bâtis d'une même main — la couleur au même
   * endroit, le verdict à la même place, le chiffre au même format. Deux rendus
   * séparés auraient divergé au premier ajout.
   */
  function rendreIndicateur(cle, vue) {
    const bloc = $(cle)

    // Un seul attribut : la pastille et la bulle se colorent d'après lui, et ne
    // peuvent donc pas se contredire.
    bloc.dataset.niveau = vue.niveau
    $('pastille-' + cle).className = 'pastille' + PASTILLE_NIVEAU[vue.niveau]

    // La couleur du grand chiffre est celle de *sa* mesure, pas celle du bloc :
    // un processeur au repos reste vert sous une pastille rouge de mémoire.
    const teinte = 'niveau-' + (vue.valeurNiveau ?? vue.niveau)
    $('bulle-' + cle).innerHTML =
      '<div class="text-[10px] font-semibold tracking-[.12em] text-attenue uppercase">' + vue.titre + '</div>' +
      '<div class="mt-1 mb-2 flex items-baseline gap-2">' +
        '<span class="chiffre ' + teinte + ' text-[22px] leading-none font-semibold tabular-nums">' + vue.valeur + '</span>' +
        '<span class="etiquette ' + teinte + ' ml-auto text-right text-[11px] font-semibold">' + vue.etiquette + '</span>' +
      '</div>' +
      // La jauge n'a de sens que sur une part de quelque chose : le lien avec le
      // hub n'en a pas, et une barre vide s'y lirait comme une mesure à zéro.
      (vue.jauge == null ? '' : jauge(vue.jauge, vue.valeurNiveau ?? vue.niveau)) +
      '<div class="mt-1.5 text-[11px] text-attenue">' + vue.detail + '</div>' +
      (vue.encart ?? '') +
      '<div class="mt-2 border-t border-bord pt-2 text-xs leading-snug text-texte">' + vue.verdict + '</div>'

    // Ce que le lecteur d'écran annonce : la bulle est décorative, elle ne fait
    // que mettre en forme cette phrase-là.
    bloc.setAttribute('aria-label', vue.resume ??
      vue.titre + ' : ' + vue.valeur + ', ' + vue.etiquette + ' — ' + vue.detail + '. ' + vue.verdict)
  }

  /**
   * Le lien avec le hub, dans ses trois états.
   *
   * Ce que la bulle ajoute à la couleur : **ce qui marche encore**. C'est la
   * seule question de l'opérateur quand la pastille change en pleine journée, et
   * la réponse est contre-intuitive — la salle projette, capte et déroule son
   * programme sans le hub. Le dire évite l'arrêt de séance réflexe.
   */
  const HUB_ETATS = {
    ONLINE: {
      niveau: 'ok',
      libelle: 'hub connecté',
      valeur: 'Connecté',
      etiquette: 'échanges en direct',
      verdict: 'Commandes, remontée et programme circulent normalement.',
    },
    DEGRADED: {
      niveau: 'attention',
      libelle: 'temps réel interrompu',
      valeur: 'Différé',
      // Pas « temps réel interrompu » : le bandeau le dit déjà à trois
      // centimètres de là. L'étiquette sert à dire ce qu'il advient du reste.
      etiquette: 'remontée en file',
      verdict: 'Le hub répond encore, mais plus en direct : la salle continue seule et ce qu’elle produit part en file. Rien n’est perdu tant que l’application reste ouverte.',
    },
    OFFLINE: {
      niveau: 'alerte',
      libelle: 'hors ligne',
      valeur: 'Hors ligne',
      etiquette: 'aucun contact',
      verdict: 'Plus rien ne circule avec le hub. Projection et captation, elles, n’en dépendent pas : continuez le talk, prévenez la console par un autre moyen.',
    },
  }

  /**
   * L'écart avec l'horloge du hub, dans une unité qu'on puisse se représenter.
   *
   * « décalée de +5 693 432,6 s » est exact et illisible. Au-delà de la minute
   * seul l'ordre de grandeur compte : un poste à deux heures du hub n'a pas le
   * même problème qu'un poste à deux secondes, et c'est ce qu'il faut lire.
   */
  function ecartHorloge(ms) {
    const secondes = Math.abs(ms) / 1000
    if (secondes < 1) return 'horloge alignée'

    const signe = ms > 0 ? '+' : '−'
    const dit = (valeur, unite) => 'horloge décalée de ' + signe + valeur + ' ' + unite
    if (secondes < 90) return dit(secondes.toFixed(1).replace('.', ','), 's')
    const minutes = secondes / 60
    if (minutes < 90) return dit(Math.round(minutes), 'min')
    const heures = minutes / 60
    if (heures < 48) return dit(Math.round(heures), 'h')
    return dit(Math.round(heures / 24), 'jours')
  }

  function rendreHub(etat, profondeur) {
    const hub = HUB_ETATS[etat.connectivity] ?? HUB_ETATS.OFFLINE
    $('etat-libelle').textContent = hub.libelle

    // L'écart d'horloge se dit ici et nulle part ailleurs : c'est ce qui
    // explique un compte à rebours qui ne colle pas à la montre de l'opérateur.
    const horloge = etat.simulatedClock
      ? 'horloge simulée par le hub'
      : ecartHorloge(etat.serverTimeOffsetMs || 0)

    rendreIndicateur('hub', {
      titre: 'Lien avec le hub',
      valeur: hub.valeur,
      etiquette: hub.etiquette,
      niveau: hub.niveau,
      jauge: null,
      detail: (profondeur > 0 ? profondeur + ' en attente de remontée' : 'file vide') + ' · ' + horloge,
      verdict: hub.verdict,
    })
  }

  /**
   * Les quatre états de la charge processeur, chacun avec ce qu'il coûte.
   *
   * Le verdict est écrit ici plutôt que déduit à l'affichage : une couleur seule
   * ne dit pas quoi faire, et l'opérateur qui survole la pastille au milieu
   * d'un talk n'a pas trois secondes pour se demander ce qu'elle attend de lui.
   */
  const CPU_NIVEAUX = {
    ok: {
      etiquette: 'marge confortable',
      verdict: 'Le poste encaisse l’encodage sans forcer.',
    },
    attention: {
      etiquette: 'charge soutenue',
      verdict: 'Plus de marge pour un imprévu : fermez ce qui n’est pas la régie.',
    },
    alerte: {
      etiquette: 'saturé',
      verdict: 'OBS perd probablement des images, et rien d’autre ne le dira. Le rush s’abîme maintenant.',
    },
    inconnu: {
      etiquette: 'mesure indisponible',
      verdict: 'Pastille sans valeur, pas poste au repos : la charge n’a pas pu être lue.',
    },
  }

  /**
   * L'autre façon dont un poste lâche, et la plus sournoise.
   *
   * La machine ne ralentit pas franchement : elle commence à échanger sur le
   * disque — celui-là même qui écrit le rush. Le symptôme visible est un
   * enregistrement qui saute, sans que le processeur ait bougé.
   */
  const MEM_ATTENTION = 0.85
  const MEM_ALERTE = 0.95
  const MEM_VERDICTS = {
    attention: 'La mémoire se remplit. Fermez les onglets et les lecteurs vidéo ouverts à côté avant le prochain talk.',
    alerte: 'Mémoire pleine : la machine va échanger sur le disque, celui-là même qui écrit le rush. Fermez tout le reste maintenant.',
  }

  /** Octets en gigaoctets, à une décimale, à la française. */
  function enGo(octets) {
    return (octets / 1_000_000_000).toFixed(1).replace('.', ',')
  }

  function rendreCpu(charge) {
    const valeur = charge == null ? null : charge.cpu
    const connu = typeof valeur === 'number'
    const cle = !connu ? 'inconnu'
      : valeur >= CPU_ALERTE ? 'alerte'
      : valeur >= CPU_ATTENTION ? 'attention' : 'ok'
    const pourcent = connu ? Math.round(valeur * 100) : 0

    const memoire = charge == null ? null : charge.memoire
    const part = memoire != null && memoire.totalOctets > 0
      ? memoire.occupeeOctets / memoire.totalOctets
      : null
    const cleMem = part == null ? 'inconnu'
      : part >= MEM_ALERTE ? 'alerte'
      : part >= MEM_ATTENTION ? 'attention' : 'ok'
    const pourcentMem = part == null ? 0 : Math.round(part * 100)

    // Le verdict revient à la mesure la plus grave : une mémoire pleine sous un
    // processeur au repos ne doit pas s'entendre dire « le poste encaisse ».
    const parLaMemoire = GRAVITE.indexOf(cleMem) > GRAVITE.indexOf(cle)
    const detailCpu = connu
      ? 'processeur · moyenne sur ' + Math.max(1, Math.round((charge.fenetreMs || 0) / 1000)) + ' s · ' +
        charge.coeurs + ' cœurs'
      : charge == null
        ? 'le serveur local de la salle n’a pas répondu'
        : 'première mesure en cours, le temps d’une fenêtre'
    const detailMem = part == null
      ? 'mémoire illisible sur cette machine'
      : enGo(memoire.occupeeOctets) + ' Go occupés sur ' + enGo(memoire.totalOctets)

    rendreIndicateur('cpu', {
      titre: 'Charge du poste',
      valeur: connu ? pourcent + ' %' : '—',
      etiquette: CPU_NIVEAUX[cle].etiquette,
      // La pastille du bandeau prend la pire des deux : c'est elle qu'on lit de
      // loin, et elle ne doit rater aucune des deux façons de saturer.
      niveau: pire(cle, cleMem),
      valeurNiveau: cle,
      jauge: pourcent,
      detail: detailCpu,
      encart:
        '<div class="mt-2.5 mb-1 flex items-baseline gap-2">' +
          '<span class="text-[10px] font-semibold tracking-[.12em] text-attenue uppercase">Mémoire</span>' +
          '<span class="niveau-' + cleMem + ' ml-auto text-xs font-semibold tabular-nums">' +
            (part == null ? '—' : pourcentMem + ' %') + '</span>' +
        '</div>' +
        jauge(pourcentMem, cleMem) +
        '<div class="mt-1.5 text-[11px] text-attenue">' + detailMem + '</div>',
      verdict: parLaMemoire ? MEM_VERDICTS[cleMem] : CPU_NIVEAUX[cle].verdict,
      resume: 'Charge du poste : processeur ' + (connu ? pourcent + ' %' : 'non mesuré') +
        ', ' + CPU_NIVEAUX[cle].etiquette + ' — ' + detailCpu +
        '. Mémoire ' + (part == null ? 'non mesurée' : pourcentMem + ' %, ' + detailMem) +
        '. ' + (parLaMemoire ? MEM_VERDICTS[cleMem] : CPU_NIVEAUX[cle].verdict),
    })
  }

  async function releverCpu() {
    try {
      const reponse = await fetch('/control/host')
      if (!reponse.ok) throw new Error('relevé indisponible')
      rendreCpu(await reponse.json())
    } catch {
      rendreCpu(null)
    }
  }
  releverCpu()
  setInterval(releverCpu, CPU_PERIODE_MS)

  $('btn-rec').onclick = () =>
    agir({ action: debutRec == null ? 'recording.start' : 'recording.stop' })
  $('btn-stream').onclick = () =>
    agir({ action: donnees?.state.streaming ? 'stream.stop' : 'stream.start' })
  $('btn-marqueur').onclick = () => {
    const champ = $('label-marqueur')
    const label = champ.value.trim() || 'Chapitre'
    agir({ action: 'recording.mark', label })
    champ.value = ''
  }

  $('btn-message').onclick = () => {
    const champ = $('message-texte')
    const texte = champ.value.trim()
    if (texte.length === 0) return
    agir({ action: 'message.send', text: texte, level: $('message-niveau').value })
    champ.value = ''
  }
  $('message-texte').addEventListener('keydown', (evenement) => {
    if (evenement.key === 'Enter') $('btn-message').click()
  })

  /**
   * Démarrage d'une conférence, et ce qui va avec.
   *
   * Deux réglages de salle s'y accrochent, tous deux actifs par défaut :
   * l'avertissement quand rien n'enregistre, et la bascule de scène. Ils sont
   * ici plutôt que dans le cœur applicatif parce que ce sont des gestes de
   * régie : la salle qui les refuse les décoche dans son ⚙, et le hub garde le
   * réglage.
   */
  /**
   * Réglages du démarrage, défauts compris.
   *
   * Les défauts vivent dans le contrat, où le hub les applique. La page les
   * répète pour un état reçu avant ce réglage : lire un champ absent comme
   * « ne rien faire » désactiverait un garde-fou en silence, ce qui est
   * exactement ce qu'il est censé empêcher. Une valeur nulle, elle, reste un
   * choix explicite.
   */
  function reglagesDemarrage() {
    const config = donnees?.diagnostics?.config ?? {}
    return {
      avertir: config.promptRecordingOnStart !== false,
      scene: config.sceneOnStart === undefined ? 'LIVE' : config.sceneOnStart,
    }
  }

  /**
   * Au-delà, un démarrage cesse d'être « un peu en avance » et devient une
   * erreur de cible.
   *
   * Un quart d'heure : c'est le battement le plus large du programme, donc la
   * limite en deçà de laquelle lancer le talk suivant est un geste normal — on
   * a fini plus tôt, le speaker est branché, la salle est pleine. Au-delà, on
   * vise presque toujours autre chose que ce qu'on croit.
   */
  const TROP_TOT_MS = 15 * 60000

  /**
   * Démarrer, avec un garde-fou quand c'est très en avance.
   *
   * La question passe **avant** celle de l'enregistrement : celle-ci porte sur
   * la manière de commencer, celle-là sur la conférence qu'on est en train de
   * lancer. Les poser dans l'autre ordre ferait démarrer une captation pour un
   * talk qu'on va renoncer à lancer.
   */
  function demarrerAvecGardeFou() {
    const session = donnees?.state.targetSession
    const avance = session == null ? null : session.startsAtMs - maintenant()
    if (avance == null || avance <= TROP_TOT_MS) {
      void demarrerConference()
      return
    }
    $('modale-tot-detail').textContent =
      '« ' + session.title + ' » est au programme à ' +
      heure(session.startsAt, donnees.timezone) + ', dans ' + resteLisible(avance) + '. ' +
      'La lancer maintenant l\u2019inscrira comme tenue à cette heure-ci, ' +
      'dans le programme comme dans l\u2019historique du hub.'
    document.body.dataset.tot = 'ouverte'
  }

  function fermerTot() {
    document.body.dataset.tot = 'fermee'
  }

  async function demarrerConference() {
    fermerTot()
    const enregistre = donnees?.diagnostics?.recording?.active === true
    if (reglagesDemarrage().avertir && !enregistre) {
      // La question n'a de sens qu'avant : une fois la conférence lancée,
      // l'enregistrement démarré manquera toujours les premières minutes.
      document.body.dataset.rec = 'ouverte'
      return
    }
    await lancerConference(false)
  }

  /** @param enregistrer Lancer l'enregistrement d'abord, puis la conférence. */
  async function lancerConference(enregistrer) {
    document.body.dataset.rec = 'fermee'
    if (enregistrer) {
      const resultat = await agir({ action: 'recording.start' })
      // L'enregistrement d'abord, et seulement s'il part : commencer quand même
      // rendrait l'avertissement mensonger la prochaine fois.
      if (!resultat?.ok) return
    }
    await agir({ action: 'session.start' })

    // Après le démarrage : la scène suit la conférence, et une bascule sans
    // conférence lancée laisserait la salle à l'antenne sur rien.
    const role = reglagesDemarrage().scene
    if (role) await agir({ action: 'scene.set', role })
  }

  $('btn-conf-demarrer').onclick = () => demarrerAvecGardeFou()
  $('tot-non').onclick = fermerTot
  $('tot-oui').onclick = () => void demarrerConference()
  $('rec-annuler').onclick = () => { document.body.dataset.rec = 'fermee' }
  $('rec-sans').onclick = () => void lancerConference(false)
  $('rec-avec').onclick = () => void lancerConference(true)
  /**
   * Ce qu'il reste au créneau, en toutes lettres.
   *
   * Les minutes seules ne suffisent pas ici : arrondies, huit secondes
   * deviennent « 0 min », et la question perdrait le seul chiffre qui permet d'y
   * répondre sans réfléchir.
   */
  function resteLisible(ms) {
    const secondes = Math.round(ms / 1000)
    if (secondes < 60) return secondes + ' s'
    return duree(Math.round(secondes / 60))
  }

  /**
   * Terminer, avec un garde-fou quand c'est en avance.
   *
   * En avance seulement : terminer à l'heure ou en dépassement est le geste
   * normal de la journée, et le confirmer à chaque fois en ferait un réflexe.
   * Un créneau sans heure de fin n'a pas d'avance possible — rien à demander.
   */
  function terminerConference() {
    const session = donnees?.state.targetSession
    const reste = session?.endsAtMs == null ? null : session.endsAtMs - maintenant()
    if (reste == null || reste <= 0) {
      void agir({ action: 'session.end' })
      return
    }
    $('modale-fin-detail').textContent =
      'Il reste ' + resteLisible(reste) + ' au créneau de « ' + session.title + ' ». ' +
      'La salle passera à « rien dans la salle », et les autres régies le verront. ' +
      '« Remettre à venir » annule, si c\u2019est une erreur.'
    document.body.dataset.fin = 'ouverte'
  }

  function fermerFin() {
    document.body.dataset.fin = 'fermee'
  }

  $('btn-conf-terminer').onclick = () => terminerConference()
  $('fin-non').onclick = fermerFin
  $('fin-oui').onclick = () => {
    fermerFin()
    void agir({ action: 'session.end' })
  }
  $('conf-detail').onclick = () => {
    if (donnees?.state.currentSession && $('badge-conf').classList.contains('ended')) {
      agir({ action: 'session.reset' })
    }
  }

  const ONGLETS = ['programme', 'autre', 'salles', 'questions']
  function ouvrirEncart(nom) {
    encart = nom
    for (const onglet of ONGLETS) {
      $('encart-' + onglet).classList.toggle('actif', onglet === nom)
    }
    if (donnees) rendreEncart()
  }
  for (const onglet of ONGLETS) $('encart-' + onglet).onclick = () => ouvrirEncart(onglet)

  /** Ouvre la consultation : les programmes ne prennent la place qu'à la demande. */
  function ouvrirModale(nom) {
    ouvrirEncart(nom)
    fermerVod()
    document.body.dataset.modale = 'ouverte'
  }
  function fermerModale() {
    document.body.dataset.modale = 'fermee'
  }
  $('btn-vod').onclick = ouvrirVod
  $('btn-fermer-vod').onclick = fermerVod
  $('modale-vod').onclick = (evenement) => {
    if (evenement.target === $('modale-vod')) fermerVod()
  }
  $('btn-vod-relire').onclick = () => void chargerVod()
  $('btn-vod-tout').onclick = () => void verifierToutVod()
  $('btn-vod-monter-tout').onclick = () => void monterVod(null)

  $('btn-config').onclick = ouvrirConfig
  $('btn-fermer-config').onclick = fermerConfig
  $('modale-config').onclick = (evenement) => {
    if (evenement.target === $('modale-config')) fermerConfig()
  }
  $('btn-relire-scenes').onclick = () => agir({ action: 'obs.refreshScenes' })

  /**
   * Connecte une instance, sur ce qui est à l'écran.
   *
   * Le formulaire part d'abord au hub : brancher sur les réglages d'avant la
   * saisie donnerait un résultat que personne ne pourrait s'expliquer. Hub
   * injoignable, on connecte tout de même avec la configuration en place —
   * rouvrir OBS après un redémarrage n'a besoin de personne d'autre.
   */
  async function connecterInstance(instance) {
    const bouton = $('cfg-connect-' + instance)
    bouton.disabled = true
    try {
      if (donnees.state.connectivity === 'ONLINE') {
        const enregistre = await agir({ action: 'room.configure', patch: lireConfig() })
        if (!enregistre?.ok) return
        refaireConfig = true
      }
      await agir({ action: 'obs.connect', instance })
    } finally {
      bouton.disabled = false
    }
  }
  $('btn-config-enregistrer').onclick = async () => {
    const bouton = $('btn-config-enregistrer')
    const avis = $('config-avis')
    bouton.disabled = true
    avis.dataset.raison = ''
    avis.className = 'flex-1 text-xs text-attenue'
    avis.textContent = 'Enregistrement…'

    const resultat = await agir({ action: 'room.configure', patch: lireConfig() })
    bouton.disabled = false
    avis.className = 'flex-1 text-xs ' + (resultat?.ok ? 'text-ok' : 'text-alerte')
    avis.textContent = resultat?.ok ? 'Enregistré.' : (resultat?.message ?? 'Échec')
    // Reconstruit sur l'état qui revient du hub, pas sur ce qu'on vient de
    // taper : c'est la seule façon de voir ce qui a réellement été retenu.
    if (resultat?.ok) refaireConfig = true
  }

  $('btn-programme').onclick = () => ouvrirModale('programme')
  $('btn-salles').onclick = () => ouvrirModale('salles')
  // Ouvrir l'onglet relit la liste : la regarder sans la rafraîchir donnerait
  // les questions d'il y a une heure.
  $('encart-questions').addEventListener('click', () => void agir({ action: 'questions.refresh' }))
  $('btn-fermer-modale').onclick = fermerModale
  // Clic sur le voile, pas sur la boîte : le geste attendu pour refermer.
  $('modale').onclick = (evenement) => {
    if (evenement.target === $('modale')) fermerModale()
  }

  $('choix-autre-salle').onchange = (evenement) => {
    void chargerAutreSalle(evenement.target.value)
  }

  // Une salle du flux ouvre son programme : c'est la question qui suit
  // immédiatement « elle finit dans 3 min ».
  $('flux-salles').onclick = (evenement) => {
    const bouton = evenement.target.closest?.('[data-salle]')
    if (bouton == null) return
    const roomId = bouton.dataset.salle
    ouvrirModale('autre')
    $('choix-autre-salle').value = roomId
    void chargerAutreSalle(roomId)
  }

  $('btn-ecrans').onclick = (evenement) => {
    evenement.stopPropagation()
    $('menu-ecrans').classList.toggle('ouvert')
  }
  document.addEventListener('click', () => $('menu-ecrans').classList.remove('ouvert'))

  // Raccourcis : dans une salle sombre, viser un bouton coûte plus cher
  // qu'appuyer sur une touche.
  document.addEventListener('keydown', (evenement) => {
    /**
     * Une touche tenue avec Ctrl, Cmd ou Alt appartient au navigateur.
     *
     * Ctrl+R recharge la page — et lançait la captation au passage, puisque
     * seule la lettre était lue. Une régie retrouvée en train d'enregistrer
     * sans que personne ne l'ait demandé, un fichier de plus sur le disque, et
     * rien à l'écran pour dire d'où ça venait. Ctrl+S, Ctrl+P, Ctrl+L posaient
     * le même piège sur d'autres lettres.
     *
     * Maj reste passant : « Maj+R » n'a pas de sens pour le navigateur, et
     * c'est la même intention que « r » pour qui tape vite.
     */
    if (evenement.ctrlKey || evenement.metaKey || evenement.altKey) return

    if (evenement.key === 'Escape') {
      fermerModale()
      fermerConfig()
      fermerFin()
      fermerTot()
      fermerVod()
      // Une modale qu'Échap ne ferme pas est un piège : celle-ci se refermait
      // déjà sur « Annuler », qui est exactement ce que fait cette ligne.
      document.body.dataset.rec = 'fermee'
    }
    // Les listes déroulantes comptent autant que les champs texte : une touche
    // « l » dans un choix de scène ne doit pas basculer la projection en direct.
    const saisie = evenement.target.tagName
    if (saisie === 'INPUT' || saisie === 'SELECT' || saisie === 'TEXTAREA') return
    const touche = evenement.key.toLowerCase()

    /**
     * Une question ouverte prend le clavier.
     *
     * Les trois modales de décision portent sur la conférence, et les
     * raccourcis agissent dessus : un « r » réflexe pendant qu'on demande s'il
     * faut enregistrer basculerait la captation sous la question elle-même.
     * Elles répondent donc seules, et rien d'autre ne passe.
     */
    if (document.body.dataset.fin === 'ouverte') {
      if (touche === 'y' || touche === 'o') $('fin-oui').click()
      if (touche === 'n') fermerFin()
      return
    }
    if (document.body.dataset.tot === 'ouverte') {
      if (touche === 'y' || touche === 'o') $('tot-oui').click()
      if (touche === 'n') fermerTot()
      return
    }
    if (document.body.dataset.rec === 'ouverte') return
    // Le contrôle des rushes se lit à deux mains sur la liste : un « r » réflexe
    // par-dessus lancerait une captation dans le dos de l'opérateur.
    if (document.body.dataset.vod === 'ouverte') return
    if (touche === 'l') agir({ action: 'scene.set', role: 'LIVE' })
    if (touche === 'h') agir({ action: 'scene.set', role: 'HOLD' })
    if (touche === 'r') $('btn-rec').click()
    if (touche === 'm') $('btn-marqueur').click()
    if (touche === 's') ouvrirModale('salles')
    if (touche === 'p') ouvrirModale('programme')
  })

  /**
   * Vumètres.
   *
   * Flux séparé de l'état : à 10 envois par seconde, passer par la charge utile
   * complète republierait tout le programme cent fois plus souvent que
   * nécessaire. Ouvrir cette page suffit à abonner la salle chez OBS ; la
   * fermer l'en détache.
   */
  const PLANCHER = -60
  const barres = new Map()

  function couleur(db) {
    if (db > -9) return "bg-alerte"
    if (db > -20) return "bg-attention"
    return "bg-ok"
  }

  function rendreNiveaux(inputs) {
    const zone = $('niveaux')
    if (inputs.length === 0) {
      zone.innerHTML = '<div class="text-xs text-attenue">Aucune entrée audio — OBS-B est-il connecte ?</div>'
      barres.clear()
      return
    }

    for (const entree of inputs) {
      let ligne = barres.get(entree.nom)
      if (ligne == null) {
        // Construit une fois, mis à jour ensuite : réécrire le HTML dix fois
        // par seconde ferait clignoter la page et coûterait pour rien.
        if (barres.size === 0) zone.innerHTML = ''
        const bloc = document.createElement('div')
        bloc.className = 'shrink-0'
        bloc.innerHTML =
          '<div class="mb-1 flex items-baseline justify-between gap-2">' +
          '<span class="truncate text-xs">' + echapper(entree.nom) + '</span>' +
          '<span class="shrink-0 text-[11px] text-attenue tabular-nums"></span></div>' +
          '<div class="flex flex-col gap-0.5"></div>'
        zone.appendChild(bloc)
        ligne = {
          valeur: bloc.querySelector("span:last-child"),
          canaux: bloc.querySelector("div:last-child"),
          jauges: [],
          crete: PLANCHER,
          creteExpire: 0,
        }
        barres.set(entree.nom, ligne)
      }

      // Une jauge par canal, créée à la volée : mono et stéréo coexistent.
      while (ligne.jauges.length < entree.canaux.length) {
        const piste = document.createElement('div')
        piste.className = "relative h-1.5 overflow-hidden rounded-full bg-fond"
        piste.innerHTML = '<div class="h-full rounded-full transition-[width] duration-75"></div>'
        ligne.canaux.appendChild(piste)
        ligne.jauges.push(piste.firstChild)
      }

      let sommet = PLANCHER
      entree.canaux.forEach((canal, index) => {
        const jauge = ligne.jauges[index]
        const part = Math.max(0, Math.min(1, (canal.magnitude - PLANCHER) / -PLANCHER))
        jauge.style.width = (part * 100).toFixed(1) + '%'
        jauge.className = "h-full rounded-full transition-[width] duration-75 " + couleur(canal.magnitude)
        if (canal.crete > sommet) sommet = canal.crete
      })

      // Maintien de crête : une saturation d'un dixième de seconde doit rester
      // lisible, sinon on ne la voit jamais passer.
      const instant = Date.now()
      if (sommet >= ligne.crete || instant > ligne.creteExpire) {
        ligne.crete = sommet
        ligne.creteExpire = instant + 1500
      }
      ligne.valeur.textContent = ligne.crete <= PLANCHER ? '—' : Math.round(ligne.crete) + ' dB'
      ligne.valeur.className = "shrink-0 text-[11px] tabular-nums " +
        (ligne.crete > -9 ? "text-alerte" : "text-attenue")
    }
  }

  if (typeof EventSource !== 'undefined' && !window.__APERCU__) {
    const fluxAudio = new EventSource('/display/audio')
    fluxAudio.onmessage = (evenement) => rendreNiveaux(JSON.parse(evenement.data).inputs)
  } else if (window.__NIVEAUX__) {
    // Aperçu hors ligne : sans niveaux figés, le panneau se relirait vide et
    // personne ne regarderait le vumètre avant le jour J.
    rendreNiveaux(window.__NIVEAUX__)
  }

  // Le flux n'envoie que ce qui change : on garde l'etat courant et on fusionne.
  // Un message complet (a l'ouverture, et apres chaque reconnexion) le remplace.
  let etatCourant = {}
  const embarque = document.getElementById('etat-initial')
  if (embarque) { etatCourant = JSON.parse(embarque.textContent); rendre(etatCourant) }

  if (typeof EventSource !== 'undefined' && !window.__APERCU__) {
    const flux = new EventSource('/display/state?vue=regie')
    /**
     * Le flux, lui aussi, doit dire quand il ne va pas bien.
     *
     * EventSource se reconnecte tout seul et ne lève rien : une machine de
     * salle redémarrée sous une page ouverte laisse cette page vivante en
     * apparence — l'horloge tourne, le compte à rebours descend — et figée en
     * fait, sur l'état d'avant la coupure.
     *
     * Le délai de grâce évite de crier à chaque reconnexion : onerror part
     * aussi pour une coupure d'une seconde, que personne n'a besoin de voir.
     */
    flux.onopen = () => { fluxCoupeDepuis = null }
    flux.onerror = () => { if (fluxCoupeDepuis == null) fluxCoupeDepuis = Date.now() }
    flux.onmessage = (evenement) => {
      fluxCoupeDepuis = null
      etatCourant = JSON.parse(evenement.data)
      rendre(etatCourant)
    }
    flux.addEventListener("delta", (evenement) => {
      fluxCoupeDepuis = null
      etatCourant = Object.assign({}, etatCourant, JSON.parse(evenement.data))
      rendre(etatCourant)
    })
  }
})()
</script>
</body>
</html>`
}
