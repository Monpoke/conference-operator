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
<title>Régie — Cloud Nord</title>
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

  /* Voile d'appairage : occupe tout l'écran tant que la machine n'est pas liée. */
  #appairage { display: none; }
  body[data-appairage="requis"] #appairage { display: flex; }

  #toast { opacity: 0; transform: translateX(-50%) translateY(20px); }
  #toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
  #toast.erreur { border-color: var(--color-alerte); background: #3a1519; }
</style>
</head>
<body class="grid h-screen grid-rows-[auto_auto_auto_1fr] bg-fond font-sans text-texte" data-appairage="ok" data-modale="fermee" data-config="fermee">
${etatInitial}
<header class="flex items-center gap-3 border-b border-bord bg-surface px-3 py-2">
  <div class="truncate text-[15px] font-semibold" id="salle">—</div>
  <span class="shrink-0" id="badge-mode"></span>
  <div class="flex shrink-0 items-center gap-1.5 text-xs text-attenue">
    <span class="pastille" id="pastille"></span>
    <span id="etat-libelle">hors ligne</span>
  </div>
  <div class="shrink-0 text-xs text-attention" id="file"></div>
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
      <!-- Le temps restant est la donnée qu'on regarde en boucle : elle a la taille qui va avec. -->
      <div class="text-[40px] leading-none font-bold tabular-nums" id="restant">--:--</div>
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
      <h2 class="titre-panneau">Captation — OBS&nbsp;B<span id="simule-B"></span></h2>
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

<script>
(() => {
  let donnees = null
  let debutRec = null

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
   * Fin effective d'un créneau : fin explicite, sinon durée, sinon début du
   * suivant.
   *
   * Même règle que effectiveEndMs côté programme. Un créneau sans dateEnd n'est
   * pas un créneau de durée nulle : le lire ainsi ne mettait jamais rien « en
   * cours » dans les salles dont l'export ne porte que les heures de début.
   *
   * Rend null pour un créneau qu'aucune des trois règles ne ferme — le dernier
   * de la journée. On préfère ne rien surligner à surligner un talk fini depuis
   * la veille.
   */
  function finEffective(sessions, index) {
    const session = sessions[index]
    if (session.endsAtMs != null) return session.endsAtMs
    if (session.durationMinutes != null) return session.startsAtMs + session.durationMinutes * 60000
    return sessions[index + 1] ? sessions[index + 1].startsAtMs : null
  }

  function enCours(sessions, instant) {
    return sessions.find((s, i) => {
      const fin = finEffective(sessions, i)
      return fin != null && s.startsAtMs <= instant && fin > instant
    }) ?? null
  }

  function apres(sessions, instant) {
    return sessions.find((s) => s.startsAtMs > instant) ?? null
  }

  /** Créneau au-delà duquel une fin proche se signale. */
  const FIN_PROCHE_MS = 5 * 60000

  /**
   * État de la conférence d'une salle, pour la pastille et son libellé.
   *
   * Deux sources, dans cet ordre :
   *
   * - **le dépassement** vient de l'état remonté par la salle. Le programme ne
   *   le dira jamais : passé l'heure de fin, il passe simplement au créneau
   *   suivant. Une salle qui pilote encore un talk dont le créneau est clos est
   *   précisément ce qu'on veut voir depuis la régie d'à côté ;
   * - **le reste** se lit sur le programme mis en cache, à l'heure du hub. Il
   *   répond pendant une coupure, et suit l'heure simulée.
   *
   * @param sessionPilotee Conférence que la salle pilote réellement, ou null.
   */
  function etatConference(sessions, instant, sessionPilotee) {
    if (sessionPilotee != null) {
      const index = sessions.findIndex((s) => s.id === sessionPilotee)
      const fin = index === -1 ? null : finEffective(sessions, index)
      if (fin != null && fin <= instant) {
        return { classe: 'depassement', libelle: 'dépassement ' + duree(Math.round((instant - fin) / 60000)) }
      }
    }

    const courante = enCours(sessions, instant)
    if (courante == null) {
      return { classe: 'hors', libelle: sessions.length === 0 ? 'programme inconnu' : 'hors créneau' }
    }
    if (courante.kind === 'break') return { classe: 'pause', libelle: 'pause' }

    const fin = finEffective(sessions, sessions.indexOf(courante))
    if (fin != null && fin - instant <= FIN_PROCHE_MS) {
      // Le cas qui décide : on ne lance pas un talk quand la salle d'à côté
      // s'apprête à déverser son public dans le couloir.
      return { classe: 'fin-proche', libelle: 'vers la fin' }
    }
    return { classe: '', libelle: 'en cours' }
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
      const fin = finEffective(sessions, i)
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
        : creneaux(sessionsAutreSalle, enCours(sessionsAutreSalle, maintenant())?.id ?? null)
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
      const courante = enCours(sessions, instant)
      const suivante = apres(sessions, instant)
      const etat = etatConference(sessions, instant, vue?.currentSessionId ?? null)

      let libelle = ''
      let detail = 'programme inconnu'
      let teinte = 'text-attenue'

      if (etat.classe === 'depassement') {
        // Le programme est passé au créneau suivant ; la salle, non. C'est
        // elle qui a raison, et c'est ce qui décale toute la journée.
        libelle = sessionDe(sessions, vue?.currentSessionId)?.title ?? ''
        detail = etat.libelle
        teinte = 'text-alerte'
      } else if (courante != null && courante.kind === 'break') {
        libelle = courante.title
        detail = suivante == null ? 'pause' : 'reprise ' + heure(suivante.startsAt, donnees.timezone)
      } else if (courante != null) {
        libelle = courante.title
        const fin = finEffective(sessions, sessions.indexOf(courante))
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
      return '<button data-salle="' + echapper(salle.id) + '" ' +
        'class="flex shrink-0 items-center gap-2 rounded-md border border-bord bg-surface2 px-2.5 py-1 text-xs font-normal">' +
        '<span class="pastille ' + classe + '"></span>' +
        '<span class="font-semibold">' + echapper(salle.name) + '</span>' +
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
          '<div>' + champ('cfg-openfeedback', 'Projet OpenFeedback', config.openFeedbackProjectId,
            'Sert au QR « Notez le talk ». Change une fois par édition.') + '</div>' +
          '<div>' + champ('cfg-root', 'Dossier des enregistrements', config.recordingRoot,
            "Pour mémoire : c'est OBS-B qui décide où il écrit. Le fichier est renommé sur place.") + '</div>' +
          relais +
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
      openFeedbackProjectId: texte('cfg-openfeedback'),
    }
  }

  function ouvrirConfig() {
    fermerModale()
    document.body.dataset.config = 'ouverte'
    if (donnees) rendreConfig()
  }

  function fermerConfig() {
    document.body.dataset.config = 'fermee'
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
      const etat = etatConference(sessions, instant, salle.currentSessionId)
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
        (etat.classe === 'depassement' ? 'text-alerte' : etat.classe === 'fin-proche' ? 'text-attention' : 'text-attenue') +
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

    const demarrer = $('btn-conf-demarrer')
    const terminer = $('btn-conf-terminer')
    demarrer.disabled = session == null || statut === 'running'
    terminer.disabled = session == null || statut !== 'running'
    demarrer.classList.toggle('actif', statut === 'running')

    const reste = resteAuProgramme()
    $('conf-detail').textContent =
      statut === 'ended'
        ? "Terminée. « Remettre à venir » si c'est une erreur."
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

  /** Le grand compte à rebours, remis à jour chaque seconde par tic(). */
  function rendreRestant() {
    const el = $('restant')
    const ms = resteMs()
    if (ms == null) {
      el.textContent = '--:--'
      el.className = 'text-[40px] leading-none font-bold tabular-nums text-attenue'
      return
    }
    el.textContent = chrono(ms)
    const teinte = ms < 0 ? 'text-alerte' : ms < 300_000 ? 'text-attention' : 'text-texte'
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

    $('salle').textContent = donnees.roomName ?? etat.roomId ?? 'Salle non appairée'
    const pastille = $('pastille')
    pastille.className = 'pastille' + (etat.connectivity === 'ONLINE' ? '' : etat.connectivity === 'DEGRADED' ? ' degraded' : ' offline')
    $('etat-libelle').textContent =
      etat.connectivity === 'ONLINE' ? 'hub connecté'
      : etat.connectivity === 'DEGRADED' ? 'temps réel interrompu' : 'hors ligne'

    // Une heure calée sur un hub en temps simulé se lit de travers si on ne le
    // dit pas : l'écart avec la montre de l'opérateur ferait douter du reste.
    document.body.dataset.horloge = etat.simulatedClock ? 'simulee' : 'reelle'

    // La profondeur de file est l'indicateur à surveiller pendant une coupure.
    const profondeur = donnees.diagnostics?.outboxDepth ?? etat.outboxDepth ?? 0
    $('file').textContent = profondeur > 0 ? profondeur + ' en attente' : ''

    boutons($('modes'), MODES, etat.mode, (mode) => ({ action: 'display.set', mode }))
    // Le relais n'apparaît que s'il est configuré, et annonce sa source :
    // « Relais → track-2 » plutôt qu'un bouton dont personne ne sait ce qu'il montre.
    const source = donnees.diagnostics?.relaySourceRoomId
    const scenes = source
      ? [...SCENES_BASE, ['RELAY', 'Relais → ' + source, null]]
      : SCENES_BASE
    boutons($('scenes'), scenes, etat.sceneRole, (role) => ({ action: 'scene.set', role }))

    const rec = donnees.diagnostics?.recording
    debutRec = rec?.active ? rec.startedAtMs : null
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

  function tic() {
    if (!donnees) return
    const decalage = donnees.state.serverTimeOffsetMs || 0
    $('horloge').textContent = new Intl.DateTimeFormat('fr-FR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: donnees.timezone,
    }).format(new Date(Date.now() + decalage))

    rendreRestant()
    rendreFluxSalles()
    rendreSignalements()

    const duree = $('duree')
    if (debutRec == null) {
      duree.textContent = '00:00'
      duree.classList.add('inactif')
      return
    }
    duree.classList.remove('inactif')
    const ecoule = Math.max(0, Date.now() - debutRec)
    const m = String(Math.floor(ecoule / 60000)).padStart(2, '0')
    const s = String(Math.floor((ecoule % 60000) / 1000)).padStart(2, '0')
    duree.textContent = m + ':' + s
  }
  setInterval(tic, 1000)

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

  $('btn-conf-demarrer').onclick = () => agir({ action: 'session.start' })
  $('btn-conf-terminer').onclick = () => agir({ action: 'session.end' })
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
    document.body.dataset.modale = 'ouverte'
  }
  function fermerModale() {
    document.body.dataset.modale = 'fermee'
  }
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
    if (evenement.key === 'Escape') { fermerModale(); fermerConfig() }
    // Les listes déroulantes comptent autant que les champs texte : une touche
    // « l » dans un choix de scène ne doit pas basculer la projection en direct.
    const saisie = evenement.target.tagName
    if (saisie === 'INPUT' || saisie === 'SELECT' || saisie === 'TEXTAREA') return
    const touche = evenement.key.toLowerCase()
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
    flux.onmessage = (evenement) => { etatCourant = JSON.parse(evenement.data); rendre(etatCourant) }
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
