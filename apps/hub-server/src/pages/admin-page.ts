import { TAILWIND_CSS } from '@cloudnord/ui'
import { IDENTITE_PAR_DEFAUT, MODELES_BANDEAU, type EventIdentity, type ModeExecution } from '@cloudnord/contract'
import type { IgnoreConfig } from '../config.js'

/**
 * Console d'exploitation du hub.
 *
 * Regroupe les quatre gestes du jour J : approuver une machine de salle,
 * importer ou revenir sur un programme, modérer le mur, surveiller les salles.
 * Servie par le hub lui-même, sans étape de build — c'est l'outil dont on a
 * besoin quand quelque chose ne va pas, il doit s'ouvrir sans rien installer.
 */
export interface AdminPageOptions {
  /** Mode d'exécution du hub, affiché en clair : voir le badge de l'en-tête. */
  mode?: ModeExecution
  /**
   * Identité de l'événement, tranchée par le hub.
   *
   * Rendue dans la page : la console doit dire de quel événement elle est la
   * console dès l'écran de connexion, c'est-à-dire avant d'avoir le droit
   * d'appeler la moindre procédure.
   *
   * `derived` est ce que donnerait le programme importé seul : c'est le
   * `placeholder` des champs de réglage laissés vides. La page le rafraîchit
   * ensuite par `event/identity` ; il n'est ici que pour le premier rendu.
   */
  event?: { resolved: EventIdentity; derived: EventIdentity }
  /** Réglages trouvés dans l'environnement et laissés sans effet, avec pourquoi. */
  ignores?: IgnoreConfig[]
  /**
   * Connexion Google, si le hub en a les identifiants. `null` sinon.
   *
   * Le domaine est affiché sous le bouton : il dit qui peut entrer, et évite
   * qu'on s'obstine avec une adresse personnelle que Google refusera.
   */
  google?: { domaine: string } | null
}

/**
 * Échappe une valeur de configuration insérée dans le HTML rendu.
 *
 * Le domaine Google vient d'un `.env`, pas d'un formulaire : le risque est
 * faible, mais une page qui construit du HTML par concaténation ne doit pas
 * avoir d'exception — c'est l'exception qu'on oublie de rouvrir le jour où la
 * valeur vient d'ailleurs.
 */
function echapperServeur(valeur: string): string {
  return valeur.replace(/[&<>"']/g, (caractere) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[caractere]!)
}

/**
 * Vues de la console, dans l'ordre des onglets.
 *
 * `developpement` n'existe qu'en mode dev — la console ne le rend pas, et le
 * hub ne sert pas son adresse : une vue masquée reste à un `hidden` près de
 * quelqu'un qui inspecte la page.
 */
export function vuesConsole(dev: boolean): string[] {
  const vues = ['exploitation', 'appairage', 'conferences', 'moderation', 'messages', 'reglages']
  return dev ? [...vues, 'developpement'] : vues
}

/**
 * Adresse d'une vue.
 *
 * L'exploitation vit à la racine : c'est la vue par défaut, et `/admin` est
 * l'adresse qu'on écrit de mémoire ou qu'on met en favori.
 */
export function cheminDeVue(vue: string): string {
  return vue === 'exploitation' ? '/admin' : `/admin/${vue}`
}

/**
 * Adresse de l'appairage imposée par Better Auth.
 *
 * C'est celle qu'il donne aux machines (`/admin/devices?user_code=…`) : elle ne
 * se renomme pas, elle s'ajoute. Elle ouvre la même vue que `/admin/appairage`.
 */
export const ALIAS_APPAIRAGE = '/admin/devices'

export function renderAdminPage(options: AdminPageOptions = {}): string {
  const identite = options.event?.resolved ?? IDENTITE_PAR_DEFAUT
  const identiteDeduite = options.event?.derived ?? IDENTITE_PAR_DEFAUT
  const nomEvenement = echapperServeur(identite.name)
  const mode = options.mode ?? 'production'
  const ignores = options.ignores ?? []
  const google = options.google ?? null

  /**
   * Le menu Développement n'est pas *masqué* en production : il n'est pas rendu.
   *
   * Masquer laisserait le panneau à un `hidden` près de quelqu'un qui inspecte
   * la page, et surtout laisserait le JavaScript câbler des boutons qui
   * déplacent l'heure de tout le système. Le hub refuse déjà `clock/set` hors
   * mode dev ; la console dit la même chose en ne proposant rien.
   */
  const dev = mode === 'dev'
  const vues = vuesConsole(dev)
  /** Adresse de chaque vue, et vue de chaque adresse — alias d'appairage compris. */
  const chemins = Object.fromEntries(vues.map((vue) => [vue, cheminDeVue(vue)]))
  const vuesParChemin = {
    ...Object.fromEntries(vues.map((vue) => [cheminDeVue(vue), vue])),
    [ALIAS_APPAIRAGE]: 'appairage',
  }

  /**
   * Deux avertissements, rendus côté serveur.
   *
   * Servis avec la page plutôt que chargés ensuite : ils décrivent le hub qui
   * répond, pas un état applicatif, et doivent être là même si tout le reste
   * échoue à se charger.
   */
  const badgeMode = mode === 'dev'
    ? '<span class="rounded border border-attention/40 px-1.5 py-px text-[11px] font-semibold ' +
      'tracking-[.08em] text-attention uppercase">mode dev</span>'
    : ''
  /**
   * Connexion Google, rendue seulement si le hub sait s'en servir.
   *
   * Le mot de passe reste au-dessus, et n'est jamais retiré : Google exige
   * internet au moment de la connexion, et tout ce système est bâti pour
   * survivre à une coupure. Un compte de secours provisionné en CLI est la
   * seule porte qui ne dépend de personne.
   */
  const boutonGoogle = google == null
    ? ''
    : '<div class="my-3.5 flex items-center gap-2 text-xs text-attenue">' +
      '<span class="h-px flex-1 bg-bord"></span>ou<span class="h-px flex-1 bg-bord"></span></div>' +
      '<button class="w-full" id="btn-google">Continuer avec Google</button>' +
      '<div class="mt-2 text-center text-xs text-attenue">Comptes ' +
      echapperServeur('@' + google.domaine) + ' uniquement</div>'

  const avisIgnores = ignores.length === 0
    ? ''
    : '<div class="mb-3.5 rounded-[10px] border border-[#6c2027] bg-[#3a1519] px-3.5 py-2.5 text-sm">' +
      ignores.map(({ variable, raison }) =>
        // La raison accompagne la variable : « ignoré » tout court enverrait
        // chercher au mauvais endroit, et les deux causes ne se corrigent pas
        // de la même façon.
        '<div><strong>' + variable + '</strong> ignoré : ' + raison + '.</div>').join('') +
      '</div>'

  /**
   * Vue Développement : les commodités qui déplacent tout le système.
   *
   * L'heure du hub y est seule pour l'instant, et c'est déjà beaucoup — la
   * changer réaligne les trois salles, fausse les timecodes VOD et déclenche
   * des clôtures automatiques à contretemps. Elle n'a rien à faire à côté des
   * réglages qu'on touche le jour J.
   */
  const vueDeveloppement = dev
    ? `<div class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5" id="vue-developpement" hidden>
    <section class="panneau">
      <h2 class="titre-panneau">Heure du hub</h2>
      <div class="reglage">
        <div class="libelle">
          <strong id="horloge-etat">—</strong>
          <span id="horloge-valeur"></span>
        </div>
      </div>
      <div id="horloge-controles" hidden>
        <div class="mb-[11px]">
          <label for="horloge-cible">Se placer à</label>
          <input id="horloge-cible" type="datetime-local" step="60">
        </div>
        <div class="flex gap-1.5">
          <button class="principal" id="btn-horloge-appliquer">Appliquer</button>
          <button id="btn-horloge-reelle">Revenir à l'heure réelle</button>
        </div>
        <div class="mt-2 flex gap-1.5" id="horloge-raccourcis"></div>
      </div>
      <div class="aide" id="horloge-aide"></div>
    </section>

    <section class="panneau">
      <h2 class="titre-panneau">Ce menu n'existe qu'en mode dev</h2>
      <div class="aide mt-0">
        Le hub tourne avec <strong>MODE=dev</strong>. En production, ce menu
        n'est pas rendu du tout et <code>clock/set</code> est refusé côté
        serveur : deux verrous, parce qu'un seul se contourne.
      </div>
    </section>
  </div>`
    : ''

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${nomEvenement} — console hub</title>
<style>${TAILWIND_CSS}</style>
<style>
  /*
   * Ce qui reste hors Tailwind : l'avis flottant, dont l'apparition se pilote
   * par une classe posée depuis le JavaScript.
   */
  #avis { opacity: 0; }
  #avis.visible { opacity: 1; }
  #avis.erreur { border-color: var(--color-alerte); background: #35161a; }

  /*
   * Verdict d'un code d'appairage. Pilotée par un attribut, pas par l'attribut
   * hidden : la règle display:flex qui la centre bat la feuille du navigateur,
   * et la modale resterait affichée.
   */
  #verdict-code { display: none; }
  body[data-verdict="ouvert"] #verdict-code { display: flex; }

  /* Réglage des notifications : même mécanique que la modale ci-dessus. */
  #reglage-notifs { display: none; }
  body[data-notifs="ouvert"] #reglage-notifs { display: flex; }

  /* Confirmation d'une resynchronisation : même mécanique, même raison. */
  #confirmer-resync { display: none; }
  body[data-resync="ouvert"] #confirmer-resync { display: flex; }
</style>
</head>
<body class="bg-fond font-sans text-texte">
<div class="mx-auto my-[12vh] max-w-[380px] p-5" id="connexion">
  <section class="panneau">
    <h2 class="titre-panneau">Console hub</h2>
    <form id="form-connexion">
      <div class="mb-[11px]"><label for="email">Adresse e-mail</label><input id="email" type="email" required></div>
      <div class="mb-[11px]"><label for="motdepasse">Mot de passe</label><input id="motdepasse" type="password" required></div>
      <button class="principal w-full" type="submit">Se connecter</button>
    </form>
    ${boutonGoogle}
  </section>
</div>

<div class="mx-auto max-w-[1180px] p-3 sm:p-5" id="console" hidden>
  <!--
    En-tête.

    Sur un téléphone tenu debout au fond d'une salle, l'adresse de l'opérateur
    connecté est ce dont on a le moins besoin : elle disparaît la première, et
    les deux actions restent atteignables au pouce.
  -->
  <header class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 sm:mb-5">
    <h1 class="text-[17px] font-semibold sm:text-[19px]" id="titre-console">${nomEvenement} — console hub</h1>
    ${badgeMode}
    <div class="ml-auto flex items-center gap-2">
      <div class="hidden text-[13px] text-attenue sm:block" id="identite"></div>
      <a class="petit rounded-lg border border-bord bg-surface2 px-[11px] py-[7px] text-[13px] font-semibold text-texte no-underline"
         href="/mur" target="_blank" rel="noopener">Mur public</a>
      <button class="petit" id="btn-notifs" hidden>Notifications</button>
      <button class="petit" id="btn-rafraichir">Rafraîchir</button>
      <button class="petit" id="btn-deconnexion">Déconnexion</button>
    </div>
  </header>

  ${avisIgnores}

  <!--
    Navigation.

    Six ou sept onglets ne tiennent pas sur une largeur de téléphone : ils
    passeraient sur trois lignes, qui pousseraient le contenu sous la ligne de
    flottaison. En bande défilante ils tiennent sur une ligne, et la barre reste
    collée en haut — changer de vue est le geste qu'on répète le plus, il ne
    doit pas demander de remonter toute la page. Au-delà, la barre reprend sa
    place dans le flux et s'enroule.
  -->
  <nav class="sticky top-0 z-20 -mx-3 mb-3 flex gap-1.5 overflow-x-auto border-b border-bord bg-fond px-3 py-2
              sm:static sm:mx-0 sm:mb-[18px] sm:flex-wrap sm:border-0 sm:px-0 sm:py-0">
    <button id="nav-exploitation" class="btn btn-onglet actif shrink-0">Exploitation</button>
    <button id="nav-appairage" class="btn btn-onglet shrink-0">Appairage</button>
    <button id="nav-conferences" class="btn btn-onglet shrink-0">Conférences</button>
    <button id="nav-moderation" class="btn btn-onglet shrink-0">Modération</button>
    <button id="nav-messages" class="btn btn-onglet shrink-0">Messages</button>
    <button id="nav-reglages" class="btn btn-onglet shrink-0">Réglages</button>
    ${dev ? '<button id="nav-developpement" class="btn btn-onglet shrink-0 text-attention">Développement</button>' : ''}
  </nav>

  <div class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5" id="vue-exploitation">
    <!--
      Une carte par salle plutôt qu'un tableau.

      La supervision se regarde debout, au fond d'une salle, sur un téléphone :
      un tableau de sept colonnes y devient illisible ou déborde. Les cartes
      tiennent dans les deux cas, et laissent la place au titre de ce qui se
      joue — la première chose qu'on vient vérifier.
    -->
    <section class="panneau col-span-full">
      <h2 class="titre-panneau">Salles</h2>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-2.5" id="salles"></div>
    </section>

  </div>

  <!--
    Appairage : une vue à part.

    Le geste n'a lieu qu'à la mise en route, et il demande de l'attention — on
    lie une machine à une salle, et se tromper de salle envoie les commandes
    au mauvais vidéoprojecteur. Le mêler à la supervision, qu'on regarde toute
    la journée, c'était le noyer là où personne ne le cherche. C'est aussi la
    page vers laquelle Better Auth renvoie, code en paramètre.
  -->
  <div class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5" id="vue-appairage" hidden>
    <section class="panneau">
      <h2 class="titre-panneau">Machines en attente d'appairage</h2>
      <div id="appairages"></div>
    </section>

    <section class="panneau">
      <h2 class="titre-panneau">Machines appairées</h2>
      <div class="overflow-x-auto">
        <table>
          <thead><tr><th>Machine</th><th>Salle</th><th></th></tr></thead>
          <tbody id="machines"></tbody>
        </table>
      </div>
    </section>
  </div>

  <div class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5" id="vue-moderation" hidden>
    <section class="panneau col-span-full">
      <h2 class="titre-panneau">Modération du mur</h2>
      <div class="aide mt-0 mb-3.5">
        Rien n'atteint un écran de salle sans passer par ici : ces messages sont
        projetés devant le public.
      </div>
      <div id="moderation"></div>
    </section>
  </div>

  <div class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5" id="vue-messages" hidden>
    <section class="panneau">
      <h2 class="titre-panneau">Envoyer un message</h2>
      <div class="mb-[11px]">
        <label for="msg-salle">Destinataire</label>
        <select id="msg-salle"></select>
      </div>
      <div class="mb-[11px]">
        <label for="msg-texte">Message</label>
        <input id="msg-texte" maxlength="500" placeholder="Texte du message">
      </div>
      <div class="mb-[11px]">
        <label for="msg-cible">Qui le voit</label>
        <select id="msg-cible">
          <option value="operator">L'opérateur de la salle (bandeau de régie)</option>
          <option value="audience">Le public (écran de la salle)</option>
        </select>
      </div>
      <div class="mb-[11px]">
        <label for="msg-niveau">Niveau</label>
        <select id="msg-niveau">
          <option value="info">Info</option>
          <option value="warning">Important</option>
          <option value="urgent">Urgent</option>
        </select>
      </div>
      <div class="mb-[11px]">
        <label for="msg-duree">Durée d'affichage (minutes, vide = jusqu'à remplacement)</label>
        <input id="msg-duree" type="number" min="1" max="60" placeholder="10">
      </div>
      <button class="principal w-full" id="btn-envoyer-message">Envoyer</button>
      <div class="aide" id="msg-avertissement"></div>
    </section>

    <section class="panneau">
      <h2 class="titre-panneau">Reçus des salles</h2>
      <div id="messages-recus"></div>
    </section>

    <!--
      Bandeau live : superposé à la vidéo, il n'interrompt rien — c'est toute
      la différence avec un message d'écran, qui prend la salle entière.
    -->
    <section class="panneau col-span-full">
      <div class="mb-2.5 flex items-center gap-3">
        <h2 class="titre-panneau mb-0 flex-1">Bandeau live</h2>
        <button class="petit" id="btn-bandeau-masquer">Masquer le bandeau</button>
      </div>

      <div class="mb-[11px] flex flex-wrap gap-1.5" id="bandeau-modeles"></div>

      <div class="mb-[11px] flex gap-1.5">
        <input id="bandeau-texte" class="flex-1" maxlength="240" placeholder="Texte du bandeau">
        <select id="bandeau-niveau" class="w-auto shrink-0">
          <option value="info">Info</option>
          <option value="warning">Important</option>
          <option value="urgent">Urgent</option>
        </select>
        <button class="principal shrink-0" id="btn-bandeau-afficher">Afficher</button>
      </div>

      <div class="aide">
        Part dans les salles choisies plus haut, et se superpose aux scènes live —
        le talk continue dessous. Un modèle remplit le champ : le texte reste
        modifiable avant envoi.
      </div>

      <h3 class="titre-panneau mt-3.5">Déjà passés</h3>
      <div id="bandeau-historique"></div>
    </section>
  </div>

  <div class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5" id="vue-conferences" hidden>
    <section class="panneau col-span-full">
      <h2 class="titre-panneau">Conférences — toutes salles</h2>
      <div class="overflow-x-auto">
        <table>
          <thead><tr><th>Salle</th><th>Conférence</th><th>Prévu</th><th>Reste</th><th>État</th><th></th></tr></thead>
          <tbody id="conferences"></tbody>
        </table>
      </div>
    </section>

    <!--
      Le planning, en dessous, et dans le même onglet.

      Le tableau du dessus ne montre que ce qui a été **démarré** : il répond à
      « où en est-on », jamais à « et après, il y a quoi ». Or c'est la question
      qu'on pose à l'organisateur toute la journée, et jusqu'ici il fallait
      rouvrir le site de l'événement pour y répondre.

      Le lien OpenFeedback accompagne chaque créneau : c'est l'adresse qu'on
      redonne à un speaker qui vient demander où sont ses retours, et elle se
      fabrique depuis le programme, sans appel réseau.
    -->
    <section class="panneau col-span-full">
      <div class="mb-2.5 flex flex-wrap items-center gap-2">
        <h2 class="titre-panneau mb-0 flex-1">Planning du programme actif</h2>
        <select class="w-auto shrink-0" id="planning-salle">
          <option value="">Toutes les salles</option>
        </select>
      </div>
      <div class="overflow-x-auto">
        <table>
          <thead><tr><th>Horaire</th><th>Salle</th><th>Conférence</th><th>Feedback</th></tr></thead>
          <tbody id="planning"></tbody>
        </table>
      </div>
      <div class="aide">
        Les horaires sont ceux du programme, lus dans le fuseau de l'événement —
        pas celui du poste d'où l'on regarde. Le lien « noter » ouvre la page
        OpenFeedback de la conférence, la même que celle du QR projeté en salle.
      </div>
    </section>
  </div>

  <div class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5" id="vue-reglages" hidden>
    <!--
      L'événement.

      Ce panneau existe pour que le dépôt n'ait pas à connaître l'événement
      qu'il sert. Les deux champs sont vides dans le cas normal : le hub lit le
      nom dans le programme importé, et changer d'événement se réduit alors à
      importer son export. Ils ne servent qu'à contredire l'export — un nom
      interne (« CN26-prod »), ou pas de nom du tout.

      Ce qui est écrit ici se propage partout : mur public, titre de cette
      console, notifications poussées, et jusqu'aux fenêtres des machines de
      salle, qui le reçoivent au sync et le gardent en cache.
    -->
    <section class="panneau">
      <h2 class="titre-panneau">L'événement</h2>
      <div class="mb-[11px]">
        <label for="event-nom">Nom affiché</label>
        <input id="event-nom" type="text" maxlength="80" placeholder="">
      </div>
      <div class="mb-[11px]">
        <label for="event-nom-court">Nom court</label>
        <input id="event-nom-court" type="text" maxlength="40" placeholder="">
      </div>
      <div class="mb-[11px]">
        <label for="event-openfeedback">Projet OpenFeedback</label>
        <input id="event-openfeedback" type="text" maxlength="80" placeholder="mon-evenement-2026">
      </div>
      <button class="principal w-full" id="btn-event">Enregistrer</button>
      <div class="aide" id="event-aide"></div>
    </section>

    <!--
      Le programme : sa source, et les versions déjà importées.

      Un réglage, pas une variable d'environnement : l'URL change quand le
      programme change — c'est-à-dire pendant l'événement — et redémarrer le hub
      pour la corriger est précisément ce qu'on ne peut pas faire ce jour-là.

      Source et versions dans le même encart : on ne réimporte jamais sans
      regarder ce que ça donne, et revenir à la version d'avant est le geste qui
      suit immédiatement un import raté.
    -->
    <section class="panneau">
      <h2 class="titre-panneau">Programme</h2>
      <div class="mb-[11px]">
        <label for="url-programme">URL de l'export « conference-center »</label>
        <input id="url-programme" type="url" placeholder="https://…/programme.json">
      </div>
      <div class="flex flex-wrap gap-1.5 [&>*]:min-w-[130px] [&>*]:flex-1">
        <button class="principal" id="btn-source-programme">Enregistrer</button>
        <button id="btn-reimporter">Réimporter</button>
      </div>
      <div class="aide">
        Deux gestes, et dans cet ordre : enregistrer n'importe rien, importer ne
        change pas l'URL. « Réimporter » attend donc que la saisie soit
        enregistrée — sinon il tirerait l'ancienne adresse pendant qu'on en
        regarde une nouvelle. Cette URL sert aussi au tout premier démarrage du
        hub, quand aucun programme n'est encore en base.
      </div>
      <!-- Le tableau défile pour lui-même : sinon c'est la page qui déborde. -->
      <div class="mt-3.5 overflow-x-auto">
        <table>
          <thead><tr><th>Version</th><th>Sessions</th><th>Anomalies</th><th></th></tr></thead>
          <tbody id="snapshots"></tbody>
        </table>
      </div>
    </section>

    <!--
      Les comptes de l'événement.

      Réglage du hub et non constante du code : l'export amont ne porte que les
      réseaux des speakers, ceux de l'organisateur n'ont aucune source — et corriger
      un handle ne doit pas demander de rejouer une release sur les trois
      machines de salle. Ils descendent au sync et s'affichent dans la boucle
      d'attente projetée pendant les pauses.
    -->
    <section class="panneau">
      <h2 class="titre-panneau">Nos réseaux</h2>
      <div id="reseaux"></div>
      <div class="mt-2 flex flex-wrap gap-1.5 [&>*]:min-w-[130px] [&>*]:flex-1">
        <button id="btn-reseau-ajouter">Ajouter un compte</button>
        <button class="principal" id="btn-reseaux">Enregistrer</button>
      </div>
      <div class="aide">
        Affichés dans la boucle d'attente des salles, entre les sponsors et le
        programme. Le libellé est repris tel quel — c'est ce que la salle lit et
        retape.
      </div>
    </section>

    <section class="panneau">
      <h2 class="titre-panneau">Clôture automatique</h2>
      <div class="reglage">
        <div class="libelle">
          <strong>Clôturer les conférences dépassées</strong>
          <span>Sans elle, un talk lancé reste « en cours » indéfiniment.</span>
        </div>
        <input type="checkbox" id="auto-actif">
      </div>
      <div class="reglage">
        <div class="libelle">
          <strong>Délai de grâce</strong>
          <span>Minutes après la fin du créneau avant clôture.</span>
        </div>
        <input type="number" id="auto-delai" min="0" max="120">
      </div>
      <button class="principal mt-3 w-full" id="btn-reglages">Enregistrer</button>
      <div class="aide">
        La règle ne clôture que les conférences <strong>explicitement démarrées</strong>.
        Une conférence jamais lancée reste « à venir » : affirmer qu'un talk s'est
        tenu alors que personne ne l'a démarré fausserait l'historique et la VOD.
      </div>
    </section>

    <!--
      Remettre une salle d'aplomb sans la redémarrer.

      Le seul recours, jusqu'ici, était de redémarrer la machine de salle —
      donc de couper sa captation, au moment précis où l'on constate qu'elle a
      dérivé. Cette demande refait tout ce que fait un démarrage *sauf* ce qui
      coupe : le programme redescend entier, les assets manquants sont repris,
      configuration, réseaux, événement, horloge et cycle de vie sont relus. OBS
      reste connecté, l'enregistrement continue.
    -->
    <section class="panneau">
      <h2 class="titre-panneau">Resynchronisation des salles</h2>
      <div class="mb-[11px]">
        <label for="resync-salle">Salle à resynchroniser</label>
        <select id="resync-salle"><option value="">Toutes les salles</option></select>
      </div>
      <button class="w-full" id="btn-resync">Demander une resynchronisation</button>
      <div class="aide">
        Passe par le flux descendant : une salle momentanément coupée rattrapera
        la demande à sa reconnexion plutôt que de la perdre. Rien n'est coupé en
        salle — ni OBS, ni un enregistrement en cours.
      </div>
    </section>
  </div>

  ${vueDeveloppement}
</div>

<!--
  Verdict du code passé dans l'URL.

  Arriver par le lien de la régie et tomber sur une file de demandes ne dit
  rien de *ce* code-là : il peut être expiré, déjà traité, ou n'avoir jamais
  existé, pendant que trois autres machines attendent à l'écran. La modale
  tranche avant qu'on cherche.
-->
<div class="fixed inset-0 z-50 items-center justify-center bg-black/65 p-4" id="verdict-code">
  <div class="panneau w-full max-w-[440px]">
    <h2 class="titre-panneau" id="verdict-titre">Code d'appairage</h2>
    <div class="text-sm leading-relaxed" id="verdict-texte">Vérification…</div>
    <!--
      Décider sur place.

      Le code qu'on tient est là, la machine qui le demande aussi : renvoyer
      vers la liste derrière la modale faisait chercher la bonne ligne parmi
      d'autres, pour refaire le geste qu'on venait de valider des yeux.
    -->
    <div class="mt-3.5" id="verdict-decision" hidden>
      <label for="verdict-salle">Salle desservie</label>
      <select id="verdict-salle"></select>
    </div>
    <div class="mt-2 text-sm text-alerte" id="verdict-erreur"></div>
    <div class="mt-3.5 flex justify-end gap-1.5">
      <button class="danger" id="verdict-refuser" hidden>Refuser</button>
      <button class="principal" id="verdict-approuver" hidden>Approuver</button>
      <button id="verdict-fermer">Fermer</button>
    </div>
  </div>
</div>

<!--
  Niveaux de notification.

  Deux familles réglées séparément : elles ne s'adressent pas au même moment,
  l'une inquiète, l'autre rythme. Trois crans plutôt qu'un interrupteur — sur le
  programme 2026, annoncer chaque début, fin et fin proche fait soixante-trois
  avis dans la journée, et un téléphone qui vibre soixante-trois fois finit en
  silencieux.
-->
<div class="fixed inset-0 z-50 items-center justify-center bg-black/65 p-4" id="reglage-notifs">
  <div class="panneau w-full max-w-[460px]">
    <h2 class="titre-panneau">Notifications</h2>
    <div class="mb-3.5">
      <label for="notif-technique">Technique — les machines</label>
      <select id="notif-technique">
        <option value="rien">Rien</option>
        <option value="essentiel">Une salle ne répond plus, une machine à appairer</option>
        <option value="tout">Tout, retours de salle compris</option>
      </select>
    </div>
    <div class="mb-3.5">
      <label for="notif-exploitation">Exploitation — le déroulé</label>
      <select id="notif-exploitation">
        <option value="rien">Rien</option>
        <option value="essentiel">Dépassements et retards au démarrage</option>
        <option value="tout">Tout : débuts, fins, et fins dans cinq minutes</option>
      </select>
    </div>
    <div class="mb-3.5 text-xs text-attenue" id="notif-portee"></div>
    <div class="flex justify-end gap-1.5">
      <button id="notif-fermer">Fermer</button>
      <button class="principal" id="notif-appliquer">Appliquer</button>
    </div>
  </div>
</div>

<!--
  Confirmation d'une resynchronisation.

  Sous confirmation parce que le geste part vers des machines qu'on ne voit pas,
  et qu'il porte à toutes les salles par défaut : « Toutes » est le choix par
  défaut de la liste, et c'est exactement le cas où un clic de trop se paie.
  La modale nomme la cible plutôt que de la sous-entendre.
-->
<div class="fixed inset-0 z-50 items-center justify-center bg-black/65 p-4" id="confirmer-resync">
  <div class="panneau w-full max-w-[460px]">
    <h2 class="titre-panneau">Resynchroniser ?</h2>
    <div class="text-sm leading-relaxed" id="resync-texte"></div>
    <div class="aide mt-3">
      La salle relit tout du hub : programme entier, assets manquants,
      configuration, réseaux, événement, horloge, cycle de vie des conférences.
      <strong>OBS n'est pas reconnecté et l'enregistrement n'est pas interrompu.</strong>
    </div>
    <div class="mt-3.5 flex justify-end gap-1.5">
      <button id="resync-annuler">Annuler</button>
      <button class="principal" id="resync-confirmer">Resynchroniser</button>
    </div>
  </div>
</div>

<div id="avis"></div>

<script>
(() => {
  const $ = (id) => document.getElementById(id)
  let jeton = localStorage.getItem('hub-admin') || null

  function avis(message, erreur) {
    const el = $('avis')
    el.textContent = message
    el.className = 'visible' + (erreur ? ' erreur' : '')
    clearTimeout(el.__t)
    el.__t = setTimeout(() => el.classList.remove('visible'), 3800)
  }

  /** Le protocole oRPC en HTTP tient en un objet { json: ... }. */
  async function appeler(chemin, entree) {
    const reponse = await fetch('/rpc/' + chemin, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(jeton ? { authorization: 'Bearer ' + jeton } : {}),
      },
      body: JSON.stringify({ json: entree ?? {} }),
    })
    const corps = await reponse.json().catch(() => null)
    if (reponse.status === 401) { deconnecter(); throw new Error('Session expirée') }
    if (!reponse.ok) throw new Error(corps?.json?.message || 'Échec de la requête')
    return corps.json
  }

  /**
   * Ramène la page à l'écran de connexion.
   *
   * Purement local : appelé aussi quand le hub répond 401, où la session est
   * déjà morte et où lui parler ne ferait qu'ajouter une erreur à celle qu'on
   * traite. La révocation côté hub est le geste du bouton, ci-dessous.
   */
  function deconnecter() {
    jeton = null
    localStorage.removeItem('hub-admin')
    $('console').hidden = true
    $('connexion').hidden = false
    // Une modale laissée ouverte flotterait au-dessus du formulaire.
    fermerVerdict()
    fermerConfirmationResync()
    $('motdepasse').value = ''
  }

  /**
   * Déconnexion demandée : on révoque la session avant de lâcher le jeton.
   *
   * Oublier le jeton sans le révoquer laisserait une session valide derrière —
   * la console s'ouvre sur des postes partagés, au fond d'une salle, et le
   * jeton vit dans le stockage local du navigateur. L'échec réseau ne retient
   * personne : on rend quand même la main à l'écran de connexion, sinon un hub
   * injoignable empêcherait de fermer la console.
   */
  async function seDeconnecter() {
    try {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(jeton ? { authorization: 'Bearer ' + jeton } : {}),
        },
        body: '{}',
      })
    } catch (cause) {
      avis("Session ferm\u00e9e ici, mais le hub n'a pas r\u00e9pondu : " + cause.message, true)
    }
    deconnecter()
  }

  $('form-connexion').onsubmit = async (evenement) => {
    evenement.preventDefault()
    try {
      const reponse = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: $('email').value, password: $('motdepasse').value }),
      })
      if (!reponse.ok) throw new Error('Identifiants refusés')
      const session = await reponse.json()
      jeton = session.token
      localStorage.setItem('hub-admin', jeton)
      $('identite').textContent = $('email').value
      demarrer()
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  /**
   * Départ vers Google, retour sur la console.
   *
   * Better Auth ne redirige pas lui-même : il rend l'URL d'autorisation, que
   * la page suit. La salle demandée n'a rien à voir ici — c'est bien la
   * console qu'on rouvre au retour.
   */
  async function connexionGoogle() {
    try {
      const reponse = await fetch('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'google', callbackURL: '/admin' }),
      })
      const corps = await reponse.json().catch(() => null)
      if (!reponse.ok || !corps || !corps.url) throw new Error(corps && corps.message ? corps.message : 'Google indisponible')
      location.assign(corps.url)
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  /**
   * Session déjà ouverte par cookie — le retour de Google.
   *
   * La redirection pose un cookie de session ; le jeton porteur du formulaire,
   * lui, ne peut pas voyager dans une redirection lisible par la page. Les
   * appels RPC partent en same-origin, donc le cookie suit tout seul et le hub
   * résout la session comme pour un jeton. Il n'y a qu'à savoir qu'elle existe.
   */
  async function sessionExistante() {
    try {
      const reponse = await fetch('/api/auth/get-session')
      if (!reponse.ok) return null
      const session = await reponse.json().catch(() => null)
      return session && session.user ? session.user : null
    } catch {
      // Hub injoignable au chargement : l'écran de connexion est la bonne
      // réponse, il redira ce qu'il faut au premier essai.
      return null
    }
  }

  const echapper = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  const ilYA = (iso) => {
    if (!iso) return 'jamais'
    const secondes = Math.round((Date.now() - Date.parse(iso)) / 1000)
    // Une date dans le futur n'est pas un écart négatif à afficher : l'horloge
    // du hub et celle du navigateur ne sont pas la même, et « vu -6010436 s »
    // ne veut rien dire pour personne.
    if (secondes < 1) return "à l'instant"
    if (secondes < 60) return secondes + ' s'
    if (secondes < 3600) return Math.round(secondes / 60) + ' min'
    return Math.round(secondes / 3600) + ' h'
  }

  /**
   * Temps restant sur le créneau d'une salle, prêt à afficher.
   *
   * Arrondi à la minute : sur un écran de supervision qui se rafraîchit toutes
   * les dix secondes, la seconde serait fausse aussitôt affichée — et ce n'est
   * pas ici qu'on tient la fin d'un talk, c'est en régie.
   *
   * Le dépassement est la raison d'être de cet affichage : c'est lui qui décale
   * le reste de la journée, donc il se distingue du reste.
   */
  function restantDuCreneau(ms) {
    if (ms == null) return null
    const minutes = Math.round(ms / 60000)
    if (minutes < 0) return { texte: 'dépassement de ' + duree(-minutes), depasse: true }
    return { texte: duree(minutes) + ' restantes', depasse: false }
  }

  /** Durée en minutes, lisible. Au-delà de l'heure, les minutes seules ne se lisent plus. */
  function duree(minutes) {
    if (minutes < 60) return minutes + ' min'
    return Math.floor(minutes / 60) + ' h ' + String(minutes % 60).padStart(2, '0')
  }

  /**
   * Notifications du navigateur.
   *
   * La console se regarde sur un téléphone, dans un couloir, entre deux
   * salles : ce qui compte est de savoir qu'une salle déborde ou est tombée
   * *sans* avoir la page sous les yeux. Elles ne se déclenchent que sur un
   * **changement** — répéter « Track #1 déborde » toutes les dix secondes ferait
   * couper les notifications au bout de deux minutes, et on ne les rallume pas.
   *
   * Portée assumée : l'API Notification de la page, sans service worker ni Web
   * Push. Elles arrivent tant que la console est ouverte, onglet en arrière-plan
   * compris ; elles s'arrêtent quand le téléphone met le navigateur en sommeil.
   * Couvrir ce cas demande un abonnement Push côté hub, qui est un autre
   * chantier — et une console fermée n'est de toute façon plus une console.
   */
  const CLE_NOTIFS = 'hub-notifs'
  /**
   * Niveaux voulus par cet appareil-ci.
   *
   * Rangés côté navigateur *et* renvoyés au hub avec l'abonnement : la page
   * décide pour ses propres avis, le hub décide pour ceux qu'il pousse, et les
   * deux doivent dire la même chose. Le téléphone dans la poche et la console
   * posée sur la table sont deux appareils, avec deux réponses légitimes.
   */
  const NIVEAUX_DEFAUT = { technique: 'essentiel', exploitation: 'essentiel' }
  let niveaux = lireNiveaux()
  /** Dernier état connu par salle. Vide au premier chargement : voir plus bas. */
  const vuesSalles = new Map()
  let appairagesVus = null

  function lireNiveaux() {
    try {
      const brut = JSON.parse(localStorage.getItem(CLE_NOTIFS) || 'null')
      // L'ancien réglage était un simple « 1 » : il vaut les défauts, plutôt
      // que d'éteindre en silence des notifications déjà acceptées.
      if (brut === '1' || brut == null) return { ...NIVEAUX_DEFAUT }
      return {
        technique: brut.technique ?? NIVEAUX_DEFAUT.technique,
        exploitation: brut.exploitation ?? NIVEAUX_DEFAUT.exploitation,
      }
    } catch {
      return { ...NIVEAUX_DEFAUT }
    }
  }

  /** Actives dès qu'une famille dit autre chose que « rien ». */
  function notifsActives() {
    return niveaux.technique !== 'rien' || niveaux.exploitation !== 'rien'
  }

  const PORTEE = { rien: 0, essentiel: 1, tout: 2 }

  /** Cet avis-là passe-t-il le réglage de cet appareil ? */
  function niveauSuffit(famille, niveau) {
    return (PORTEE[niveaux[famille]] ?? 0) >= (PORTEE[niveau] ?? 1)
  }

  function notifsDisponibles() {
    return typeof Notification !== 'undefined'
  }

  function rendreBoutonNotifs() {
    const bouton = $('btn-notifs')
    if (!notifsDisponibles()) return
    bouton.hidden = false
    const allume = notifsActives() && localStorage.getItem(CLE_NOTIFS) != null
    bouton.textContent = allume ? 'Notifications ●' : 'Notifications'
    bouton.title = allume
      ? 'Alertes activées sur cet appareil'
      : "Être prévenu d'un dépassement, d'une salle coupée ou d'une machine à appairer"
  }

  /**
   * Abonnement Web Push : les avis qui survivent à la fermeture de la console.
   *
   * Les notifications de la page s'arrêtent dès que le téléphone endort le
   * navigateur — précisément le moment où l'on a besoin d'être prévenu. Le push
   * passe par le service worker, que le système réveille pour nous.
   *
   * Sans service worker, sans clé publique ou sans permission, la console
   * garde les notifications de page : mieux vaut un avertissement qui ne
   * traverse pas le verrouillage que pas d'avertissement du tout.
   */
  async function abonnerPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false
    /*
     * Contexte sécurisé exigé : HTTPS, ou localhost.
     *
     * Ouvrir la console par l'adresse IP du hub — ce qu'on fait naturellement
     * depuis un téléphone — n'en est pas un, et l'échec arriverait plus loin,
     * sous un message qui parle de service de push et envoie chercher au
     * mauvais endroit.
     */
    if (!globalThis.isSecureContext) {
      avis(
        "Notifications hors ligne : il faut ouvrir la console en HTTPS. Sur " +
          location.hostname + ', le navigateur les refuse.',
        true,
      )
      return false
    }
    try {
      const { publicKey } = await appeler('push/publicKey')
      if (!publicKey) return false

      const worker = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      const abonnement =
        (await worker.pushManager.getSubscription()) ??
        (await worker.pushManager.subscribe({
          // Imposé par les navigateurs : pas de push silencieux, chaque envoi
          // doit se voir. C'est aussi ce qu'on veut ici.
          userVisibleOnly: true,
          applicationServerKey: base64UrlVersOctets(publicKey),
        }))

      const brut = abonnement.toJSON()
      await appeler('push/subscribe', {
        endpoint: brut.endpoint,
        keys: { p256dh: brut.keys.p256dh, auth: brut.keys.auth },
        label: navigator.userAgent.slice(0, 80),
        // Renvoyés à chaque changement : le filtrage des avis poussés se fait
        // dans le hub, qui ne lit pas le stockage local du navigateur.
        levels: niveaux,
      })
      return true
    } catch (cause) {
      /*
       * Pas d'erreur bloquante : l'essentiel — être prévenu console ouverte —
       * fonctionne quand même, et insister masquerait ce qui marche.
       *
       * Le message du navigateur seul (« push service error ») fait chercher
       * la panne du côté du hub, alors qu'elle est presque toujours ailleurs :
       * s'abonner exige que **le navigateur** joigne le service de push de son
       * éditeur, sur Internet. Un réseau d'événement fermé le refuse, et
       * certains navigateurs le désactivent d'eux-mêmes.
       */
      const detail = String(cause?.message ?? cause)
      avis(
        /push service|Registration failed/i.test(detail)
          ? "Le navigateur n'a pas pu joindre son service de notifications " +
            '(Internet requis, même pour un hub local). Les alertes console ouverte fonctionnent.'
          : 'Notifications hors ligne indisponibles : ' + detail,
        true,
      )
      return false
    }
  }

  /** La clé VAPID voyage en base64url ; l'abonnement veut des octets. */
  function base64UrlVersOctets(valeur) {
    const complet = (valeur + '='.repeat((4 - (valeur.length % 4)) % 4))
      .replace(/-/g, '+')
      .replace(/_/g, '/')
    const brut = atob(complet)
    const octets = new Uint8Array(brut.length)
    for (let i = 0; i < brut.length; i += 1) octets[i] = brut.charCodeAt(i)
    return octets
  }

  async function desabonnerPush() {
    if (!('serviceWorker' in navigator)) return
    try {
      const worker = await navigator.serviceWorker.getRegistration()
      const abonnement = await worker?.pushManager.getSubscription()
      if (abonnement == null) return
      // Le hub d'abord : oublier l'abonnement côté navigateur sans le dire
      // laisserait le hub pousser dans le vide jusqu'à ce que le service de
      // push le lui refuse.
      await appeler('push/unsubscribe', { endpoint: abonnement.endpoint })
      await abonnement.unsubscribe()
    } catch {
      // Rien à rattraper : le hub purge de lui-même les abonnements morts.
    }
  }

  function ouvrirReglageNotifs() {
    $('notif-technique').value = niveaux.technique
    $('notif-exploitation').value = niveaux.exploitation
    $('notif-portee').textContent =
      Notification.permission === 'granted'
        ? "Cet appareil est autoris\u00e9 \u00e0 notifier."
        : "Le navigateur demandera l'autorisation \u00e0 la premi\u00e8re application."
    document.body.dataset.notifs = 'ouvert'
  }

  /**
   * Applique les niveaux choisis.
   *
   * Tout éteindre ne supprime pas l'abonnement côté navigateur : le rallumer ne
   * demande alors pas de repasser par la permission, qu'un refus rendrait
   * définitive. Le hub, lui, filtre à l'envoi.
   */
  async function appliquerNotifs() {
    niveaux = {
      technique: $('notif-technique').value,
      exploitation: $('notif-exploitation').value,
    }
    document.body.dataset.notifs = 'ferme'

    if (!notifsActives()) {
      localStorage.setItem(CLE_NOTIFS, JSON.stringify(niveaux))
      await desabonnerPush()
      rendreBoutonNotifs()
      avis('Notifications \u00e9teintes sur cet appareil')
      return
    }

    if (Notification.permission !== 'granted') {
      // Demandée au clic, jamais au chargement : un navigateur qui voit la
      // question arriver seule la refuse pour de bon, et on ne la repose plus.
      const reponse = await Notification.requestPermission()
      if (reponse !== 'granted') {
        avis(reponse === 'denied'
          ? "Notifications refus\u00e9es par le navigateur : \u00e0 rouvrir dans ses r\u00e9glages de site"
          : 'Notifications non activ\u00e9es', true)
        return
      }
    }

    localStorage.setItem(CLE_NOTIFS, JSON.stringify(niveaux))
    rendreBoutonNotifs()
    const horsLigne = await abonnerPush()
    prevenir(
      'Notifications activ\u00e9es',
      horsLigne
        ? "M\u00eame console ferm\u00e9e, tant que le navigateur a Internet."
        : 'Tant que la console reste ouverte.',
      'reglages',
    )
  }

  /**
   * @param cle Regroupe les avis d'une même salle : une notification remplace
   *   la précédente au lieu d'empiler une colonne sur l'écran de verrouillage.
   * @param vue Onglet à ouvrir au clic — la console a une adresse par onglet.
   */
  /**
   * @param famille technique ou exploitation. Absente : avis de service — la
   *   confirmation d'activation — qui ne se filtre pas.
   * @param niveau Niveau minimal auquel cet avis part.
   */
  function prevenir(titre, corps, cle, vue, famille, niveau) {
    if (!notifsDisponibles() || Notification.permission !== 'granted') return
    /*
     * Il ne suffit pas que le navigateur autorise : il faut que quelqu'un
     * l'ait voulu **ici**. Une permission accordée pour un autre usage ferait
     * sinon vibrer une console que personne n'a réglée.
     */
    if (localStorage.getItem(CLE_NOTIFS) == null) return
    if (famille && !niveauSuffit(famille, niveau ?? 'essentiel')) return
    try {
      const notification = new Notification(titre, { body: corps, tag: cle, lang: 'fr' })
      notification.onclick = () => {
        globalThis.focus?.()
        if (vue) basculerVue(vue)
        notification.close()
      }
    } catch {
      // Certains navigateurs mobiles refusent le constructeur hors service
      // worker. Rien à faire ici : la console reste utilisable, et insister
      // ferait une erreur toutes les dix secondes.
    }
  }

  /**
   * Compare la vue des salles à la précédente et prévient de ce qui a changé.
   *
   * Le tout premier passage n'alerte de rien : ouvrir la console sur une salle
   * déjà coupée n'est pas un événement, c'est un état — et trois notifications
   * à l'ouverture rendraient les suivantes invisibles.
   */
  function signalerSalles(salles) {
    const premier = vuesSalles.size === 0
    for (const salle of salles) {
      const avant = vuesSalles.get(salle.roomId)
      vuesSalles.set(salle.roomId, { conference: salle.conference, connectivity: salle.connectivity })
      if (premier || avant == null) continue

      // Deux étiquettes par salle : un « c'est parti » ne doit jamais venir
      // effacer un « ne répond plus » resté non lu.
      const machine = 'salle-' + salle.roomId
      const conf = 'conf-' + salle.roomId

      if (salle.connectivity !== 'ONLINE' && avant.connectivity === 'ONLINE') {
        prevenir(salle.name + ' ne r\u00e9pond plus', 'Plus de nouvelles de la machine de salle.', machine, 'exploitation', 'technique', 'essentiel')
      } else if (salle.connectivity === 'ONLINE' && avant.connectivity !== 'ONLINE') {
        // Un soulagement, pas une décision : réservé à qui veut tout suivre.
        prevenir(salle.name + ' est revenue', 'La machine de salle r\u00e9pond de nouveau.', machine, 'exploitation', 'technique', 'tout')
      }

      if (salle.conference === avant.conference) continue
      if (salle.conference === 'depassement') {
        // Le seul qui demande un arbitrage : c'est lui qui décale la journée.
        prevenir(salle.name + ' d\u00e9borde', 'Le cr\u00e9neau est fini, la conf\u00e9rence est toujours en cours.', conf, 'exploitation', 'exploitation', 'essentiel')
      } else if (salle.conference === 'retard') {
        prevenir(salle.name + " n'a pas d\u00e9marr\u00e9", "Le cr\u00e9neau a commenc\u00e9, la conf\u00e9rence n'est pas lanc\u00e9e.", conf, 'exploitation', 'exploitation', 'essentiel')
      } else if (salle.conference === 'fin-proche') {
        prevenir(salle.name + ' \u00b7 cinq minutes', 'La conf\u00e9rence touche \u00e0 sa fin.', conf, 'exploitation', 'exploitation', 'tout')
      } else if (salle.conference === 'en-cours' && avant.conference === 'pas-commencee') {
        prevenir(salle.name + " \u00b7 c'est parti", salle.currentSession?.title ?? 'La conf\u00e9rence a commenc\u00e9.', conf, 'exploitation', 'exploitation', 'tout')
      } else if (salle.conference === 'terminee') {
        prevenir(salle.name + ' \u00b7 termin\u00e9', salle.currentSession?.title ?? 'La conf\u00e9rence est termin\u00e9e.', conf, 'exploitation', 'exploitation', 'tout')
      }
    }
  }

  /** Une machine attend : le geste est court, mais personne ne le voit venir. */
  function signalerAppairages(attente) {
    const codes = attente.map((demande) => demande.clientId).sort().join('|')
    if (appairagesVus != null && codes !== appairagesVus && attente.length > 0) {
      const nouvelles = attente.filter((demande) => !appairagesVus.includes(demande.clientId))
      if (nouvelles.length > 0) {
        prevenir(
          nouvelles.length === 1 ? 'Une machine attend son appairage' : nouvelles.length + ' machines attendent leur appairage',
          "Le code est affich\u00e9 sur l'\u00e9cran de r\u00e9gie.",
          'appairage',
          'appairage',
          'technique',
          'essentiel',
        )
      }
    }
    appairagesVus = codes
  }

  async function chargerSalles() {
    const salles = await appeler('rooms/statuses')
    signalerSalles(salles)
    $('salles').innerHTML = salles.map((salle) => {
      /**
       * Remplissage : où en est la conférence. Contour : ce qu'on sait de la
       * salle. Une pastille qui ne portait que la connectivité affichait une
       * salle verte alors qu'elle débordait de dix minutes.
       */
      const CONFERENCE = {
        aucune: ['hors', 'rien au programme', 'text-attenue'],
        pause: ['pause', 'pause', 'text-attenue'],
        'pas-commencee': ['pas-commencee', 'pas commencée', 'text-attenue'],
        retard: ['retard', 'retard au démarrage', 'text-attention'],
        'en-cours': ['', 'en cours', 'text-attenue'],
        'fin-proche': ['fin-proche', 'vers la fin', 'text-attention'],
        terminee: ['terminee', 'terminée en avance', 'text-attenue'],
        depassement: ['depassement', 'dépassement', 'text-alerte'],
      }
      const [teinte, mot, couleurTexte] = CONFERENCE[salle.conference] || CONFERENCE.aucune
      const contour = salle.connectivity === 'DEGRADED' ? ' doute'
        : salle.connectivity === 'ONLINE' ? '' : ' muette'
      const classe = teinte + contour
      const etiquette = (texte, teinte) =>
        '<span class="rounded bg-surface2 px-1.5 py-0.5 text-[11px] ' + (teinte || 'text-attenue') + '">' + texte + '</span>'

      const badges = [
        salle.recording ? etiquette('● REC', 'text-alerte') : '',
        salle.streaming ? etiquette('● LIVE', 'text-ok') : '',
        salle.sceneRole ? etiquette(echapper(salle.sceneRole)) : '',
        salle.outboxDepth > 0 ? etiquette(salle.outboxDepth + ' en file', 'text-attention') : '',
      ].filter(Boolean).join(' ')

      // Calculé par le hub : lui seul connaît l'heure qui fait foi, et elle
      // peut être simulée.
      const reste = restantDuCreneau(salle.currentSession?.remainingMs)

      return '<div class="rounded-xl border border-bord bg-fond p-3">' +
        '<div class="flex items-center gap-2">' +
        '<span class="pastille ' + classe + '"></span>' +
        '<span class="flex-1 truncate font-semibold">' + echapper(salle.name) + '</span>' +
        '<a class="shrink-0 text-[13px] text-marque no-underline" target="_blank" rel="noopener" href="/mur?salle=' +
        encodeURIComponent(salle.roomId) + '">mur ↗</a></div>' +
        // Ce qui se joue : la première chose qu'on vient vérifier.
        '<div class="mt-1.5 text-[13px] leading-snug">' +
        (salle.currentSession
          ? echapper(salle.currentSession.title)
          : '<span class="text-attenue">Rien au programme</span>') + '</div>' +
        // Et pour combien de temps encore : sans ça, savoir ce qui se joue ne
        // dit pas si la salle est en avance, à l'heure, ou en train de déborder.
        (reste
          ? '<div class="mt-0.5 text-xs ' + (reste.depasse ? 'text-alerte' : 'text-attenue') + '">' +
            reste.texte + '</div>'
          : '') +
        (badges ? '<div class="mt-2 flex flex-wrap gap-1.5">' + badges + '</div>' : '') +
        // Le mot accompagne la couleur : une pastille seule ne se lit pas quand
        // on ne distingue pas les teintes, et la carte se regarde de loin.
        '<div class="mt-2 text-xs text-attenue"><span class="' + couleurTexte + '">' +
        (salle.connectivity === 'ONLINE' ? mot : 'salle muette') + '</span> · ' +
        salle.connectivity.toLowerCase() + ' · vu ' + ilYA(salle.lastSeenAt) + '</div>' +
        '</div>'
    }).join('') || '<div class="vide">Aucune salle déclarée.</div>'
  }

  /**
   * Ce que dit chaque verdict, et ce qu'il faut faire ensuite.
   *
   * Un code inconnu et un code expiré ne se corrigent pas de la même façon :
   * l'un se recopie ou vient d'une base recréée, l'autre se redemande depuis la
   * régie. Les confondre en « code invalide » enverrait chercher au mauvais bout
   * de la salle.
   */
  const VERDICTS = {
    inconnu: ['Code inconnu', "Aucun appairage en cours ne porte ce code. V\u00e9rifiez la saisie \u2014 " +
      "ou la base du hub a \u00e9t\u00e9 recr\u00e9\u00e9e depuis, et la machine doit en demander un nouveau."],
    expire: ['Code expir\u00e9', "Ce code a d\u00e9pass\u00e9 sa dur\u00e9e de vie. La r\u00e9gie en affiche " +
      "un nouveau d\u00e8s qu'elle red\u00e9marre son appairage."],
    approved: ['Code d\u00e9j\u00e0 approuv\u00e9', "Cette machine est appair\u00e9e : elle figure dans " +
      "\u00ab Machines appair\u00e9es \u00bb. Il n'y a rien \u00e0 faire ici."],
    denied: ['Code refus\u00e9', "Cet appairage a \u00e9t\u00e9 refus\u00e9. Pour revenir dessus, relancez " +
      "l'appairage depuis la r\u00e9gie : elle affichera un autre code."],
  }

  function fermerVerdict() {
    document.body.dataset.verdict = 'ferme'
  }

  /** Machine que la modale s'apprête à approuver ou refuser. */
  let machineDuVerdict = null

  /**
   * Approuve ou refuse depuis la modale.
   *
   * Le même chemin que les boutons de la liste — devices/approve porte
   * l'approbation *et* l'affectation en une opération —, mais sans avoir à
   * retrouver la ligne : on vient d'en lire le code.
   */
  async function deciderVerdict(approuver) {
    $('verdict-erreur').textContent = ''
    for (const bouton of ['verdict-approuver', 'verdict-refuser']) $(bouton).disabled = true
    try {
      if (approuver) {
        await appeler('devices/approve', {
          userCode: codeDeLUrl,
          clientId: machineDuVerdict,
          roomId: $('verdict-salle').value,
        })
        avis('Machine appair\u00e9e')
      } else {
        await appeler('devices/deny', { userCode: codeDeLUrl })
        avis('Appairage refus\u00e9')
      }
      fermerVerdict()
      await tout()
    } catch (cause) {
      // Dans la modale, pas dans l'avis flottant : l'erreur porte sur le geste
      // qu'on vient de faire, et le refus d'un code ouvert par un autre
      // opérateur demande de lire une phrase entière.
      $('verdict-erreur').textContent = cause.message
    } finally {
      for (const bouton of ['verdict-approuver', 'verdict-refuser']) $(bouton).disabled = false
    }
  }

  /**
   * Vérifie le code de l'URL avant que l'opérateur ne cherche la machine.
   *
   * La file affichée à côté ne dit rien de *ce* code-là : trois autres machines
   * peuvent y attendre pendant que celui-ci est mort. On tranche donc d'abord,
   * et la modale reste le seul endroit à lire.
   */
  /**
   * Prépare l'approbation : la liste des salles, celle demandée en tête.
   *
   * Pré-sélectionnée mais modifiable, comme dans la liste : c'est l'opérateur
   * de la salle qui sait où il se trouve, celui devant la console qui tranche.
   * Se tromper envoie les commandes au mauvais vidéoprojecteur.
   */
  async function proposerDecision(verdict) {
    machineDuVerdict = verdict.clientId
    const salles = await appeler('rooms/list')
    const choix = $('verdict-salle')
    choix.innerHTML = salles.map((salle) =>
      '<option value="' + echapper(salle.id) + '"' +
      (salle.id === verdict.requestedRoomId ? ' selected' : '') + '>' +
      echapper(salle.name) + '</option>').join('')
    // Une salle demandée absente de ce hub ne doit pas passer pour la première
    // de la liste : le dire vaut mieux que de laisser approuver au hasard.
    if (verdict.requestedRoomId && !salles.some((salle) => salle.id === verdict.requestedRoomId)) {
      $('verdict-erreur').textContent =
        'La machine demande ' + verdict.requestedRoomId + ", inconnue de ce hub."
    }
    $('verdict-decision').hidden = false
    $('verdict-approuver').hidden = false
    $('verdict-refuser').hidden = false
  }

  async function verifierCodeDeLUrl() {
    $('verdict-titre').textContent = 'Code ' + codeDeLUrl
    $('verdict-texte').textContent = 'V\u00e9rification\u2026'
    $('verdict-erreur').textContent = ''
    $('verdict-decision').hidden = true
    $('verdict-approuver').hidden = true
    $('verdict-refuser').hidden = true
    document.body.dataset.verdict = 'ouvert'

    let titre, corps
    try {
      const verdict = await appeler('devices/lookup', { userCode: codeDeLUrl })
      if (verdict.status === 'pending' && verdict.clientId) {
        titre = 'Code valide'
        corps = 'La machine <strong>' + echapper(verdict.clientId) +
          '</strong> attend son approbation.'
        await proposerDecision(verdict)
      } else if (verdict.status === 'pending') {
        // Sans client_id, Better Auth ne nous a pas reconnus comme le
        // consultant du code : approuver échouerait, autant ne pas le proposer.
        titre = 'Code valide'
        corps = "Une machine attend, mais ce code a \u00e9t\u00e9 ouvert par un autre " +
          'op\u00e9rateur : son approbation lui revient.'
      } else {
        const dit = VERDICTS[verdict.reason || verdict.status]
        titre = dit ? dit[0] : 'Code illisible'
        corps = echapper(dit ? dit[1] : "Le hub n'a pas su qualifier ce code.")
      }
    } catch (cause) {
      // Session expirée : l'appel a déjà ramené l'écran de connexion, et une
      // modale par-dessus ne ferait que masquer le formulaire.
      if (!jeton) return fermerVerdict()
      titre = 'V\u00e9rification impossible'
      corps = echapper(cause.message)
    }

    $('verdict-titre').textContent = titre
    $('verdict-texte').innerHTML =
      '<div class="mb-2 font-semibold tracking-[.12em] tabular-nums">' + echapper(codeDeLUrl) + '</div>' + corps
  }

  async function chargerAppairages() {
    const [attente, salles] = await Promise.all([appeler('devices/pending'), appeler('rooms/list')])
    signalerAppairages(attente)
    const conteneur = $('appairages')
    if (attente.length === 0) {
      conteneur.innerHTML = codeDeLUrl
        ? '<div class="vide">Aucune machine en attente. Le code ' + echapper(codeDeLUrl) +
          ' a peut-être déjà été traité, ou expiré.</div>'
        : '<div class="vide">Aucune machine en attente.</div>'
      return
    }
    conteneur.innerHTML = ''
    for (const demande of attente) {
      const bloc = document.createElement('div')
      bloc.className = 'message'
      /**
       * Salle demandée par la machine, transmise en scope, sous la forme room:<id>.
       *
       * Pré-sélectionnée mais modifiable : c'est l'opérateur de la salle qui
       * sait où il se trouve, mais celui devant la console qui tranche.
       */
      const demandee = (demande.scope ?? '').startsWith('room:')
        ? demande.scope.slice('room:'.length)
        : null
      const nomDemande = salles.find((s) => s.id === demandee)?.name

      bloc.innerHTML =
        '<div class="meta"><span>' + echapper(demande.clientId) + '</span><span>' + ilYA(demande.requestedAt) + '</span></div>' +
        (nomDemande
          ? '<div class="meta">La machine demande : <strong>' + echapper(nomDemande) + '</strong></div>'
          : '') +
        '<div class="mb-[11px]"><label>Code affiché sur la machine</label><input placeholder="XXXX-XXXX"></div>' +
        '<div class="mb-[11px]"><label>Salle desservie</label><select>' +
        salles.map((s) =>
          '<option value="' + echapper(s.id) + '"' + (s.id === demandee ? ' selected' : '') + '>' +
          echapper(s.name) + '</option>').join('') +
        '</select></div>' +
        '<div class="actions"><button class="principal">Approuver</button><button class="danger">Refuser</button></div>'

      const [champCode, champSalle] = [bloc.querySelector('input'), bloc.querySelector('select')]
      if (codeDeLUrl) {
        champCode.value = codeDeLUrl
        champCode.style.borderColor = 'var(--accent)'
      }
      const [approuver, refuser] = bloc.querySelectorAll('button')

      approuver.onclick = async () => {
        try {
          await appeler('devices/approve', {
            userCode: champCode.value.trim(),
            clientId: demande.clientId,
            roomId: champSalle.value,
          })
          avis('Machine appairée')
          await tout()
        } catch (cause) { avis(cause.message, true) }
      }
      refuser.onclick = async () => {
        try {
          await appeler('devices/deny', { userCode: champCode.value.trim() })
          avis('Demande refusée')
          await tout()
        } catch (cause) { avis(cause.message, true) }
      }
      conteneur.appendChild(bloc)
    }
  }

  async function chargerMachines() {
    const machines = await appeler('devices/list')
    const corps = $('machines')
    corps.innerHTML = ''
    if (machines.length === 0) {
      corps.innerHTML = '<tr><td colspan="3" class="vide">Aucune machine appairée.</td></tr>'
      return
    }
    for (const machine of machines) {
      const ligne = document.createElement('tr')
      const revoquee = machine.revokedAt != null
      ligne.innerHTML =
        '<td>' + echapper(machine.label ?? machine.clientId) + '</td>' +
        '<td>' + echapper(machine.roomId) + '</td><td></td>'
      const cellule = ligne.lastElementChild
      if (revoquee) {
        cellule.textContent = 'révoquée'
        cellule.style.color = 'var(--attenue)'
      } else {
        const bouton = document.createElement('button')
        bouton.className = 'danger petit'
        bouton.textContent = 'Révoquer'
        bouton.onclick = async () => {
          try {
            await appeler('devices/revoke', { clientId: machine.clientId })
            avis('Machine révoquée')
            await chargerMachines()
          } catch (cause) { avis(cause.message, true) }
        }
        cellule.appendChild(bouton)
      }
      corps.appendChild(ligne)
    }
  }

  async function chargerSnapshots() {
    const snapshots = await appeler('program/snapshots')
    const corps = $('snapshots')
    corps.innerHTML = ''
    if (snapshots.length === 0) {
      corps.innerHTML = '<tr><td colspan="4" class="vide">Aucun programme importé.</td></tr>'
      return
    }
    for (const snapshot of snapshots) {
      const ligne = document.createElement('tr')
      ligne.innerHTML =
        '<td>' + (snapshot.active ? '<span class="actif">● actif</span> ' : '') + echapper(snapshot.contentHash.slice(0, 10)) + '</td>' +
        '<td>' + snapshot.sessionCount + '</td>' +
        '<td>' + (snapshot.issueCount > 0 ? snapshot.issueCount : '—') + '</td><td></td>'
      if (!snapshot.active) {
        const bouton = document.createElement('button')
        bouton.className = 'petit'
        bouton.textContent = 'Activer'
        // Un import raté le jour J se rollback en un clic.
        bouton.onclick = async () => {
          try {
            await appeler('program/activate', { contentHash: snapshot.contentHash })
            avis('Programme activé')
            await chargerSnapshots()
          } catch (cause) { avis(cause.message, true) }
        }
        ligne.lastElementChild.appendChild(bouton)
      }
      corps.appendChild(ligne)
    }
  }

  /**
   * Import du programme, depuis la source **enregistrée**.
   *
   * Jamais depuis le champ de saisie : ce qui est importé doit être ce que le
   * hub réimportera tout seul au prochain démarrage, sans quoi les deux
   * divergeraient sans que rien ne le dise.
   */
  async function importerProgramme() {
    const url = reglages?.programSourceUrl ?? null
    if (!url) { avis('Aucune URL de programme enregistrée', true); return }
    $('btn-reimporter').disabled = true
    try {
      const resultat = await appeler('program/import', { sourceUrl: url })
      avis(resultat.program.sessions.length + ' sessions importées')
      await chargerSnapshots()
    } catch (cause) {
      avis(cause.message, true)
    } finally {
      rendreSourceProgramme()
    }
  }

  $('btn-reimporter').onclick = () => importerProgramme()
  // L'état du bouton suit la frappe : il doit dire « pas encore » avant le
  // clic, pas après.
  $('url-programme').oninput = () => rendreSourceProgramme()

  async function chargerModeration() {
    const messages = await appeler('wall/pending', {})
    const conteneur = $('moderation')
    if (messages.length === 0) {
      conteneur.innerHTML = '<div class="vide">Rien à relire.</div>'
      return
    }
    conteneur.innerHTML = ''
    for (const message of messages) {
      const bloc = document.createElement('div')
      bloc.className = 'message'
      bloc.innerHTML =
        '<div class="meta"><span class="source">' + echapper(message.source) + '</span>' +
        '<span>' + echapper(message.author) + '</span><span>' + ilYA(message.createdAt) + '</span></div>' +
        '<div class="corps">' + echapper(message.text) + '</div>' +
        '<div class="actions"><button class="principal petit">Publier</button><button class="danger petit">Rejeter</button></div>'

      const [publier, rejeter] = bloc.querySelectorAll('button')
      const moderer = async (decision) => {
        try {
          await appeler('wall/moderate', { id: message.id, decision })
          bloc.remove()
          if ($('moderation').children.length === 0) $('moderation').innerHTML = '<div class="vide">Rien à relire.</div>'
        } catch (cause) { avis(cause.message, true) }
      }
      publier.onclick = () => moderer('approve')
      rejeter.onclick = () => moderer('reject')
      conteneur.appendChild(bloc)
    }
  }

  /**
   * Code d'appairage passé dans l'URL.
   *
   * La machine affiche ce lien à l'écran de régie ; l'opérateur le suit et
   * retrouve le code déjà saisi. Recopier huit caractères depuis l'autre bout
   * d'une salle est exactement le genre de friction qui produit des erreurs.
   */
  const codeDeLUrl = new URLSearchParams(location.search).get('user_code')

  // Rendues par le serveur : la liste doit coller au markup, et le menu
  // Développement n'est pas rendu hors du mode de développement.
  const VUES = ${JSON.stringify(vues)}
  const CHEMINS = ${JSON.stringify(chemins)}
  const VUES_PAR_CHEMIN = ${JSON.stringify(vuesParChemin)}
  let vueCourante = 'exploitation'

  /**
   * Vue désignée par l'adresse courante.
   *
   * Une adresse inconnue retombe sur l'exploitation plutôt que de laisser une
   * console vide : le hub ne sert que les vues qui existent, mais l'historique
   * du navigateur peut porter une vue retirée depuis — developpement après un
   * redémarrage en production, par exemple.
   */
  function vueDuChemin() {
    // Sans expression régulière : dans cette page, le motif vit dans un
    // template literal, où une barre oblique échappée est mangée avant
    // d'atteindre le navigateur.
    const chemin = location.pathname
    const sansFin = chemin.length > 1 && chemin.endsWith('/') ? chemin.slice(0, -1) : chemin
    return VUES_PAR_CHEMIN[sansFin] || 'exploitation'
  }

  /**
   * Change de vue, et l'inscrit dans l'adresse.
   *
   * Sans ça, la console vivait entièrement sur /admin : un rafraîchissement
   * ramenait à l'exploitation, on ne pouvait ni mettre la modération en favori
   * ni envoyer « regarde cet onglet » à quelqu'un, et le bouton Retour du
   * navigateur quittait la console au lieu de revenir sur l'onglet précédent.
   *
   * @param historique false au premier rendu et sur popstate : l'adresse
   *   est déjà la bonne, l'empiler à nouveau ferait un doublon dont le bouton
   *   Retour ne sortirait pas.
   */
  function basculerVue(nom, historique = true) {
    vueCourante = nom
    for (const vue of VUES) {
      $('vue-' + vue).hidden = vue !== nom
      $('nav-' + vue).classList.toggle('actif', vue === nom)
    }
    // Le code d'appairage ne survit pas au changement d'onglet : il a été
    // traité, et le garder ferait rouvrir la modale au rafraîchissement suivant.
    if (historique && location.pathname + location.search !== CHEMINS[nom]) {
      history.pushState(null, '', CHEMINS[nom])
    }
    void tout()
  }
  for (const vue of VUES) $('nav-' + vue).onclick = () => basculerVue(vue)
  // Retour et Suivant du navigateur : on suit l'adresse, sans la réécrire.
  globalThis.addEventListener('popstate', () => basculerVue(vueDuChemin(), false))

  async function chargerConferences() {
    const [etats, snapshots] = await Promise.all([
      appeler('sessions/states', { roomId: null }),
      appeler('program/snapshots'),
    ])
    const actif = snapshots.find((s) => s.active)
    const corps = $('conferences')

    if (!actif) {
      corps.innerHTML = '<tr><td colspan="6" class="vide">Aucun programme actif.</td></tr>'
      return
    }
    if (etats.length === 0) {
      corps.innerHTML =
        '<tr><td colspan="6" class="vide">Aucune conférence démarrée pour le moment. ' +
        'Les décisions se prennent depuis la régie de chaque salle, ou ici une fois lancées.</td></tr>'
      return
    }

    corps.innerHTML = ''
    for (const etat of etats) {
      const ligne = document.createElement('tr')
      // Fuseau de l'événement, comme dans le planning juste en dessous : les
      // deux tableaux montrent les mêmes créneaux, ils ne peuvent pas annoncer
      // deux heures différentes selon l'endroit d'où la console est ouverte.
      const heure = (iso) =>
        iso ? new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: fuseauEvenement() }).format(new Date(iso)) : '—'

      const creneau = etat.scheduledStartsAt
        ? heure(etat.scheduledStartsAt) + '–' + heure(etat.scheduledEndsAt)
        : '—'

      ligne.innerHTML =
        '<td>' + echapper(etat.roomName ?? etat.roomId ?? '—') + '</td>' +
        // Le titre, pas l'identifiant : personne ne reconnaît une conférence à son id.
        '<td>' + echapper(etat.title ?? etat.sessionId) + '</td>' +
        '<td class="text-attenue">' + creneau + '</td>' +
        '<td>' + resteAuProgramme(etat) + '</td>' +
        '<td><span class="badge ' + echapper(etat.status) + '">' +
        (etat.status === 'running' ? 'en cours' : 'terminée') + '</span>' +
        (etat.decidedBy === 'auto' ? ' <span class="text-attenue">auto</span>' : '') + '</td>' +
        '<td></td>'

      const actions = document.createElement('div')
      actions.className = 'flex gap-1.5'
      const ajouter = (libelle, classe, action) => {
        const bouton = document.createElement('button')
        bouton.className = 'petit ' + classe
        bouton.textContent = libelle
        bouton.onclick = async () => {
          try {
            await appeler('sessions/' + action, { sessionId: etat.sessionId })
            avis('Conférence mise à jour')
            await chargerConferences()
          } catch (cause) { avis(cause.message, true) }
        }
        actions.appendChild(bouton)
      }
      if (etat.status === 'running') ajouter('Terminer', '', 'end')
      else ajouter('Relancer', '', 'start')
      ajouter('Remettre à venir', 'danger', 'reset')

      ligne.lastElementChild.appendChild(actions)
      corps.appendChild(ligne)
    }
  }

  /**
   * Temps qu'il **devrait** rester, d'après le programme.
   *
   * Pas le temps réel écoulé : c'est l'écart au créneau prévu qui intéresse
   * l'organisateur, parce que c'est lui qui décale toute la suite de la journée.
   *
   * L'écart vient du hub, comme celui des cartes de salles : lui seul connaît
   * l'heure qui fait foi, et elle peut être simulée. Soustraire ici la fin du
   * créneau de l'heure du navigateur affichait « +6010 min » sur un talk
   * parfaitement à l'heure dès qu'on déplaçait l'horloge depuis le menu
   * Développement.
   */
  function resteAuProgramme(etat) {
    if (etat.status !== 'running' || etat.remainingMs == null) return '<span class="text-attenue">—</span>'

    const minutes = Math.round(etat.remainingMs / 60000)
    if (minutes >= 0) {
      const classe = minutes <= 5 ? 'class="text-attention"' : ''
      return '<span ' + classe + '>' + minutes + ' min</span>'
    }
    // Débordement : c'est l'information qui déclenche une décision.
    return '<span class="font-semibold text-alerte">+' + Math.abs(minutes) + ' min</span>'
  }

  /**
   * Le planning du programme actif.
   *
   * Gardé en mémoire entre deux rendus : le filtre par salle rejoue l'affichage
   * sans redemander au hub, et un programme ne change qu'à l'import.
   */
  let planning = null

  /**
   * Fuseau dans lequel se lisent les horaires du programme.
   *
   * Celui de l'événement, jamais celui du poste : la console s'ouvre aussi
   * depuis un train ou un autre pays, et annoncer un talk une heure trop tôt à
   * qui appelle la salle est une erreur qu'on ne rattrape pas. Repli sur le
   * fuseau du navigateur tant que le hub n'a pas répondu — mieux qu'une heure
   * absente.
   */
  const fuseauEvenement = () => planning?.timezone ?? undefined

  async function chargerPlanning() {
    planning = await appeler('program/planning')

    // La liste des salles ne bouge qu'à l'import : la reconstruire à chaque
    // rafraîchissement remettrait le filtre sur « toutes » toutes les dix
    // secondes, pendant qu'on lit une salle en particulier.
    const filtre = $('planning-salle')
    if (filtre.options.length !== planning.rooms.length + 1) {
      filtre.innerHTML = '<option value="">Toutes les salles</option>' +
        planning.rooms.map((salle) =>
          '<option value="' + echapper(salle.id) + '">' + echapper(salle.name) + '</option>').join('')
    }
    rendrePlanning()
  }

  function rendrePlanning() {
    const corps = $('planning')
    if (planning == null || planning.sessions.length === 0) {
      corps.innerHTML = '<tr><td colspan="4" class="vide">Aucun programme actif. ' +
        'Il s\u2019importe depuis les réglages.</td></tr>'
      return
    }

    const salleChoisie = $('planning-salle').value
    const creneaux = planning.sessions.filter(
      (session) => salleChoisie === '' || session.roomId === salleChoisie)
    if (creneaux.length === 0) {
      corps.innerHTML = '<tr><td colspan="4" class="vide">Aucun créneau dans cette salle.</td></tr>'
      return
    }

    /**
     * Heures lues dans le fuseau de l'**événement**.
     *
     * La console s'ouvre depuis n'importe où — un train, un autre pays — et le
     * programme, lui, ne se décale pas. Afficher l'heure du poste ferait
     * annoncer un talk une heure trop tôt à qui appelle la salle.
     */
    const dans = (options) => (iso) =>
      new Intl.DateTimeFormat('fr-FR', { ...options, timeZone: planning.timezone }).format(new Date(iso))
    const heure = dans({ hour: '2-digit', minute: '2-digit' })
    const jour = dans({ weekday: 'short', day: '2-digit', month: '2-digit' })

    // Le jour n'apparaît que s'il y en a plusieurs : sur un événement d'une
    // journée, il ne dirait rien et prendrait la place du titre.
    const jours = new Set(creneaux.map((session) => jour(session.startsAt)))
    const plusieursJours = jours.size > 1

    /**
     * Où en est la journée, d'après l'heure du **hub**.
     *
     * Un planning de vingt-sept lignes se lit en cherchant d'abord « on en est
     * où » : sans repère, on recompte les créneaux depuis le haut à chaque
     * fois. L'heure vient du hub et non du navigateur — elle peut être simulée,
     * et c'est elle qui fait foi pour toute la journée.
     */
    const maintenant = Date.parse(planning.serverTime)
    const situer = (session) => {
      const debut = Date.parse(session.startsAt)
      const fin = session.endsAt == null ? null : Date.parse(session.endsAt)
      if (debut > maintenant) return 'a-venir'
      // Créneau de fin inconnue : il court jusqu'à preuve du contraire, plutôt
      // que d'être déclaré passé à la seconde où il commence.
      if (fin == null || maintenant < fin) return 'en-cours'
      return 'passe'
    }

    corps.innerHTML = creneaux.map((session) => {
      const quand = situer(session)
      const creneau = (plusieursJours ? jour(session.startsAt) + ' ' : '') +
        heure(session.startsAt) + (session.endsAt ? '–' + heure(session.endsAt) : '')
      const qui = session.speakers.length === 0
        ? ''
        : '<div class="text-xs text-attenue">' + echapper(session.speakers.join(', ')) + '</div>'
      // Case vide plutôt que lien mort : sans projet OpenFeedback réglé, ou sur
      // une pause, il n'y a rien à noter.
      const lien = session.feedbackUrl
        ? '<a class="font-semibold text-marque no-underline" target="_blank" rel="noopener" href="' +
          echapper(session.feedbackUrl) + '">noter ↗</a>'
        : '<span class="text-attenue">—</span>'

      /**
       * Trois traitements, un seul repère.
       *
       * Le créneau en cours est marqué au trait de marque et écrit en clair ;
       * ce qui est passé s'efface sans disparaître — on doit encore pouvoir y
       * retrouver un lien de feedback ; ce qui vient reste au repos.
       */
      const ligne = quand === 'en-cours'
        ? ' class="bg-surface2"'
        : quand === 'passe' ? ' class="opacity-55"' : ''
      const marque = quand === 'en-cours'
        ? '<span class="mr-1.5 inline-block h-3.5 w-[3px] translate-y-0.5 rounded-full bg-marque"></span>'
        : ''
      const horaire = quand === 'en-cours'
        ? 'whitespace-nowrap tabular-nums font-semibold text-texte'
        : 'whitespace-nowrap tabular-nums text-attenue'

      return '<tr' + ligne + '>' +
        '<td class="' + horaire + '">' + marque + creneau + '</td>' +
        '<td class="whitespace-nowrap">' + echapper(session.roomName ?? '—') + '</td>' +
        // Les pauses restent dans la liste — elles font partie de la journée —
        // mais en retrait : ce n'est pas ce qu'on cherche en ouvrant le planning.
        '<td' + (session.kind === 'break' ? ' class="text-attenue"' : '') + '>' +
        echapper(session.title) + qui +
        // Dit en toutes lettres ce que le trait montre : le surlignage seul se
        // confondrait avec une ligne survolée, et l'heure affichée peut être
        // simulée — auquel cas « en ce moment » est la seule chose qui explique
        // pourquoi c'est cette ligne-là qui est marquée.
        (quand === 'en-cours'
          ? '<div class="text-xs font-semibold text-marque">en ce moment</div>'
          : '') +
        '</td>' +
        '<td>' + lien + '</td>' +
        '</tr>'
    }).join('')
  }

  $('planning-salle').onchange = () => rendrePlanning()

  async function chargerMessages() {
    const [salles, recus] = await Promise.all([
      appeler('rooms/list'),
      appeler('messages/fromRooms', { limit: 40 }),
    ])

    const destinataire = $('msg-salle')
    if (destinataire.options.length === 0) {
      destinataire.innerHTML = '<option value="">Toutes les salles</option>' +
        salles.map((s) => '<option value="' + echapper(s.id) + '">' + echapper(s.name) + '</option>').join('')
    }

    const conteneur = $('messages-recus')
    if (recus.length === 0) {
      conteneur.innerHTML = '<div class="vide">Aucun message des salles.</div>'
      return
    }
    conteneur.innerHTML = recus.map((message) =>
      '<div class="message">' +
      '<div class="meta"><span class="source">' + echapper(message.level) + '</span>' +
      '<span>' + echapper(message.roomName ?? message.roomId) + '</span>' +
      '<span>' + ilYA(message.receivedAt) + '</span></div>' +
      '<div class="corps">' + echapper(message.text) + '</div></div>').join('')
  }

  /**
   * Avertit quand le message ira sur l'écran de la salle.
   *
   * La confusion coûterait cher : une note à l'opérateur projetée devant le
   * public ne se rattrape pas.
   */
  $('msg-cible').onchange = () => {
    const public_ = $('msg-cible').value === 'audience'
    $('msg-avertissement').innerHTML = public_
      ? '<strong class="text-attention">Ce message sera projeté devant le public</strong> ' +
        "et remplacera ce qui est à l'écran."
      : "Ce message n'apparaîtra que dans le bandeau de la régie, pas sur l'écran de la salle."
  }
  $('msg-cible').onchange()

  /**
   * Bandeau live.
   *
   * Les modèles viennent du contrat, rendus côté serveur : ce sont les quelques
   * phrases qu'on met à l'antenne sans réfléchir un jour d'événement, et les
   * retaper sous pression est le meilleur moyen de les rater.
   */
  const MODELES = ${JSON.stringify(MODELES_BANDEAU)}

  function salleVisee() {
    return $('msg-salle').value || null
  }

  async function chargerBandeaux() {
    const passes = await appeler('overlay/history', { roomId: salleVisee(), limit: 20 })
    const zone = $('bandeau-historique')
    if (passes.length === 0) {
      zone.innerHTML = '<div class="vide">Aucun bandeau diffusé pour le moment.</div>'
      return
    }
    zone.innerHTML = ''
    for (const passe of passes) {
      const ligne = document.createElement('div')
      ligne.className = 'reglage'
      ligne.innerHTML =
        '<div class="libelle"><strong>' + echapper(passe.message.text) + '</strong>' +
        '<span>' + passe.message.level + ' · ' + ilYA(passe.issuedAt) +
        (passe.roomId ? ' · ' + echapper(passe.roomId) : ' · toutes salles') + '</span></div>' +
        (passe.visible ? '<span class="badge running">en cours</span>' : '')
      const remettre = document.createElement('button')
      remettre.className = 'petit'
      remettre.textContent = passe.visible ? 'Masquer' : 'Remettre'
      remettre.onclick = () => (passe.visible
        ? masquerBandeau()
        : afficherBandeau(passe.message.text, passe.message.level))
      ligne.append(remettre)
      zone.append(ligne)
    }
  }

  async function afficherBandeau(text, level) {
    try {
      await appeler('overlay/show', { roomId: salleVisee(), message: { text, level }, ttlSeconds: null })
      avis('Bandeau affiché')
      await chargerBandeaux()
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  async function masquerBandeau() {
    try {
      await appeler('overlay/hide', { roomId: salleVisee() })
      avis('Bandeau retiré')
      await chargerBandeaux()
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  for (const modele of MODELES) {
    const bouton = document.createElement('button')
    bouton.className = 'petit'
    bouton.textContent = modele.nom
    // Remplit le champ plutôt que d'envoyer : un modèle est un point de départ,
    // pas un rail — la date, la durée, le nom de la salle changent à chaque fois.
    bouton.onclick = () => {
      $('bandeau-texte').value = modele.message.text
      $('bandeau-niveau').value = modele.message.level
      $('bandeau-texte').focus()
    }
    $('bandeau-modeles').append(bouton)
  }

  $('btn-bandeau-afficher').onclick = () => {
    const texte = $('bandeau-texte').value.trim()
    if (texte.length === 0) { avis('Renseignez un texte', true); return }
    void afficherBandeau(texte, $('bandeau-niveau').value)
  }
  $('btn-bandeau-masquer').onclick = () => void masquerBandeau()

  $('btn-envoyer-message').onclick = async () => {
    const texte = $('msg-texte').value.trim()
    if (texte.length === 0) { avis('Renseignez un message', true); return }
    const minutes = Number($('msg-duree').value)

    try {
      await appeler('messages/send', {
        roomId: $('msg-salle').value || null,
        text: texte,
        level: $('msg-niveau').value,
        target: $('msg-cible').value,
        ttlSeconds: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : null,
      })
      $('msg-texte').value = ''
      avis('Message envoyé')
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  /**
   * Derniers réglages connus.
   *
   * Gardés parce que deux vues s'en servent : Réglages les édite, et
   * Exploitation a besoin de l'URL du programme pour son bouton « Réimporter ».
   */
  let reglages = null

  /**
   * Ce que le hub déduirait du programme importé, réglages ignorés.
   *
   * Sert de placeholder aux champs de l'événement laissés vides : sans lui,
   * on ne sait pas ce qu'on obtient en vidant un champ, donc on ne le vide
   * jamais et le réglage devient un aller sans retour. Amorcé avec ce que le
   * serveur a rendu dans la page, puis rafraîchi.
   */
  let deduit = ${JSON.stringify(identiteDeduite)}

  /**
   * Rafraîchit le nom de l'événement, sans jamais faire tomber l'appelant.
   *
   * Le titre de la page est décoratif ; les réglages qu'il accompagne ne le
   * sont pas. Laisser une erreur ici interrompre chargerReglages priverait
   * la console de tout son onglet Réglages pour un nom mal rendu — le serveur
   * a déjà mis le bon dans la page au rendu.
   */
  async function chargerIdentite() {
    try {
      const identite = await appeler('event/identity')
      if (identite && identite.derived) deduit = identite.derived
      if (identite && identite.resolved && identite.resolved.name) {
        // Renommer l'événement et continuer à lire l'ancien nom en haut de sa
        // propre console serait le premier endroit où douter que le réglage
        // soit pris.
        const titre = identite.resolved.name + ' — console hub'
        document.title = titre
        $('titre-console').textContent = titre
      }
    } catch {
      // Volontairement muet : voir ci-dessus. Un avis toutes les dix secondes
      // sur un titre de page couvrirait ceux qui parlent des salles.
    }
  }

  /**
   * Comptes de l'événement, édités à la volée.
   *
   * Gardés dans un tableau plutôt que relus du DOM à l'enregistrement : une
   * ligne vidée puis réenregistrée doit disparaître, ce qui se dit mal en
   * relisant des champs.
   */
  let reseaux = []

  function rendreReseaux() {
    const zone = $('reseaux')
    zone.innerHTML = ''
    if (reseaux.length === 0) {
      zone.innerHTML = '<div class="vide">Aucun compte déclaré. La boucle des salles saute cette page.</div>'
      return
    }
    reseaux.forEach((lien, index) => {
      const ligne = document.createElement('div')
      ligne.className = 'mb-1.5 grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,2fr)_auto] items-center gap-1.5'
      ligne.innerHTML =
        '<input placeholder="Réseau" value="' + echapper(lien.network) + '">' +
        '<input placeholder="@handle" value="' + echapper(lien.handle) + '">' +
        '<input placeholder="https://…" value="' + echapper(lien.url) + '">'
      const champs = ligne.querySelectorAll('input')
      const cles = ['network', 'handle', 'url']
      champs.forEach((champ, rang) => {
        champ.oninput = () => { reseaux[index][cles[rang]] = champ.value }
      })
      const retirer = document.createElement('button')
      retirer.className = 'petit danger'
      retirer.textContent = '×'
      retirer.title = 'Retirer ce compte'
      retirer.onclick = () => { reseaux.splice(index, 1); rendreReseaux() }
      ligne.appendChild(retirer)
      zone.appendChild(ligne)
    })
  }

  $('btn-reseau-ajouter').onclick = () => {
    reseaux.push({ network: '', handle: '', url: '' })
    rendreReseaux()
  }

  $('btn-reseaux').onclick = async () => {
    // Les lignes vides sont écartées ici : ajouter une ligne puis se raviser
    // est un geste normal, et le hub refuserait une URL vide.
    const propres = reseaux.filter((lien) =>
      lien.network.trim() !== '' && lien.handle.trim() !== '' && lien.url.trim() !== '')
    try {
      reglages = await appeler('settings/update', { socialLinks: propres })
      reseaux = reglages.socialLinks.map((lien) => ({ ...lien }))
      rendreReseaux()
      avis('Réseaux enregistrés')
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  /**
   * Identité de l'événement.
   *
   * Les champs restent vides quand rien n'est réglé : le placeholder montre
   * alors ce que le hub a déduit du programme importé. Un champ pré-rempli
   * avec la valeur déduite ferait croire qu'elle est figée, et le premier
   * enregistrement l'aurait effectivement figée — le nom cesserait de suivre
   * les imports suivants.
   */
  function rendreEvenement() {
    // Sans écraser une saisie en cours : le rafraîchissement tourne toutes les
    // dix secondes, et rien n'est plus déroutant qu'un champ qui se réécrit
    // pendant qu'on tape dedans. Borné à ces trois champs : saisir l'URL du
    // programme ne doit pas figer le reste du panneau.
    const champs = ['event-nom', 'event-nom-court', 'event-openfeedback']
    if (champs.some((id) => $(id) === document.activeElement)) return
    $('event-nom').value = reglages.eventName ?? ''
    $('event-nom-court').value = reglages.eventShortName ?? ''
    $('event-openfeedback').value = reglages.openFeedbackProjectId ?? ''
    $('event-nom').placeholder = deduit.name
    $('event-nom-court').placeholder = deduit.shortName
    $('event-aide').textContent = reglages.eventName
      ? 'Nom imposé ici : il ne suivra plus les imports de programme. Videz le champ pour revenir à « ' + deduit.name +' ».'
      : 'Déduit du programme importé (« ' + deduit.name + ' »). Renseignez un nom pour contredire l\u2019export amont.'
  }

  $('btn-event').onclick = async () => {
    // Vidé = revenir à la déduction. Distinguer « vide » de « absent » est tout
    // l'intérêt du réglage : sans ça, on ne pourrait plus jamais le relâcher.
    const vide = (valeur) => (valeur.trim() === '' ? null : valeur.trim())
    try {
      reglages = await appeler('settings/update', {
        eventName: vide($('event-nom').value),
        eventShortName: vide($('event-nom-court').value),
        openFeedbackProjectId: vide($('event-openfeedback').value),
      })
      // Rechargé plutôt que déduit dans le navigateur : c'est le hub qui
      // tranche, et la page doit montrer ce qu'il a retenu, pas ce qu'elle
      // aurait retenu à sa place.
      await chargerIdentite()
      rendreEvenement()
      avis('Événement enregistré')
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  async function chargerReglages() {
    reglages = await appeler('settings/get')
    // Avant rendreEvenement : c'est lui qui fournit les placeholders, et un
    // import de programme fait pendant que la console est ouverte doit s'y voir.
    await chargerIdentite()
    rendreEvenement()
    $('auto-actif').checked = reglages.autoEndEnabled
    $('auto-delai').value = reglages.autoEndGraceMinutes
    // Sans écraser une saisie en cours : le rafraîchissement tourne toutes les
    // dix secondes, et rien n'est plus déroutant qu'un champ qui se réécrit
    // pendant qu'on tape dedans.
    if (document.activeElement !== $('url-programme')) {
      $('url-programme').value = reglages.programSourceUrl ?? ''
    }
    rendreSourceProgramme()
    // Même précaution : le rafraîchissement tourne toutes les dix secondes, et
    // réécrire la liste pendant qu'on tape dedans effacerait la saisie.
    if (!$('reseaux').contains(document.activeElement)) {
      reseaux = (reglages.socialLinks ?? []).map((lien) => ({ ...lien }))
      rendreReseaux()
    }
    await remplirSallesResync()
  }

  /**
   * Liste des salles à resynchroniser.
   *
   * Réécrite seulement quand elle change : cette vue se rafraîchit toutes les
   * dix secondes, et reconstruire la liste remettrait le choix sur « Toutes »
   * pendant qu'on ouvre la modale sur une salle précise.
   */
  async function remplirSallesResync() {
    const salles = await appeler('rooms/list')
    const choix = $('resync-salle')
    const attendu = salles.map((salle) => salle.id).join('|')
    if (choix.dataset.salles === attendu) return
    choix.dataset.salles = attendu
    const garde = choix.value
    choix.innerHTML = '<option value="">Toutes les salles</option>' +
      salles.map((salle) =>
        '<option value="' + echapper(salle.id) + '">' + echapper(salle.name) + '</option>').join('')
    if (salles.some((salle) => salle.id === garde)) choix.value = garde
  }

  /** Nom lisible de la cible, pour que la modale la nomme au lieu de l'insinuer. */
  function cibleResync() {
    const choix = $('resync-salle')
    return {
      roomId: choix.value || null,
      nom: choix.value === '' ? null : choix.options[choix.selectedIndex].textContent,
    }
  }

  function ouvrirConfirmationResync() {
    const { nom } = cibleResync()
    $('resync-texte').innerHTML = nom == null
      ? 'Demander une resynchronisation compl\u00e8te \u00e0 <strong>toutes les salles</strong>.'
      : 'Demander une resynchronisation compl\u00e8te \u00e0 <strong>' + echapper(nom) + '</strong>.'
    document.body.dataset.resync = 'ouvert'
  }

  function fermerConfirmationResync() {
    document.body.dataset.resync = 'ferme'
  }

  async function confirmerResync() {
    const { roomId, nom } = cibleResync()
    try {
      const resultat = await appeler('rooms/resync', { roomId })
      fermerConfirmationResync()
      // Le nombre de salles visées, pas un « c'est parti » : un hub sans
      // aucune salle appairée accepterait la demande sans que rien ne parte.
      avis(nom != null
        ? 'Resynchronisation demand\u00e9e \u00e0 ' + nom
        : resultat.rooms === 0
          ? 'Aucune salle sur ce hub : la demande n\u2019atteindra personne'
          : 'Resynchronisation demand\u00e9e \u00e0 ' + resultat.rooms + ' salle(s)')
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  /**
   * État du bouton d'import.
   *
   * Il attend que la saisie soit enregistrée : importer l'ancienne adresse
   * pendant qu'on en lit une nouvelle à l'écran est le genre de malentendu
   * qu'on ne remarque qu'après.
   */
  function rendreSourceProgramme() {
    const url = reglages?.programSourceUrl ?? null
    const enAttente = $('url-programme').value.trim() !== (url ?? '')
    $('btn-reimporter').disabled = url == null || enAttente
    $('btn-reimporter').title = url == null
      ? 'Renseignez une URL, puis enregistrez'
      : enAttente
        ? "Enregistrez d'abord : l'import part de l'URL enregistrée"
        : url
  }

  async function chargerDeveloppement() {
    rendreHorloge(await appeler('clock/get'))
  }

  /** Heure locale au format attendu par un champ datetime-local. */
  const pourChamp = (iso) => {
    const d = new Date(iso)
    const p = (n) => String(n).padStart(2, '0')
    // Concaténation plutôt qu'un template literal : ce code vit lui-même dans
    // un template literal, où un backtick refermerait la chaîne.
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function rendreHorloge(horloge) {
    $('horloge-etat').textContent = horloge.simulated ? 'Horloge SIMULÉE' : 'Heure réelle'
    $('horloge-etat').style.color = horloge.simulated ? 'var(--tiede)' : ''
    $('horloge-valeur').textContent = new Intl.DateTimeFormat('fr-FR', {
      // Fuseau de l'événement, comme partout ailleurs dans la console : lire
      // l'heure du hub dans celui du poste d'où l'on regarde, c'est justement
      // l'erreur que le réglage d'horloge sert à débusquer.
      dateStyle: 'full', timeStyle: 'medium', timeZone: fuseauEvenement(),
    }).format(new Date(horloge.serverTime))

    $('horloge-controles').hidden = !horloge.controllable
    $('horloge-aide').innerHTML = horloge.controllable
      ? "Déplacer l'heure déplace <strong>tout le système</strong> : les salles s'alignent " +
        'aussitôt. Outil de développement — pendant l\u2019événement, cela fausserait les ' +
        'timecodes des enregistrements et déclencherait des clôtures à contretemps.'
      : 'Réglage fermé : ce hub tourne en production. Il s\u2019ouvre avec <code>MODE=dev</code>, ' +
        'à réserver au développement.'

    if (!horloge.controllable) return
    if (!$('horloge-cible').value) $('horloge-cible').value = pourChamp(horloge.serverTime)

    /*
     * Raccourcis vers les moments qu'on veut réellement observer.
     *
     * Déduits du programme importé, jamais écrits en dur : une date d'édition
     * dans le code ne vaut que pour cette édition-là, et les boutons devenaient
     * silencieusement inutiles au changement d'événement — un déplacement à une
     * date sans le moindre créneau ne montre rien et ne dit pas pourquoi.
     *
     * Reconstruits à chaque changement de programme, d'où la version en clé.
     */
    const raccourcis = $('horloge-raccourcis')
    const version = planning?.contentHash ?? ''
    if (raccourcis.dataset.version !== version) {
      raccourcis.dataset.version = version
      raccourcis.replaceChildren()
      for (const [libelle, iso] of momentsDuProgramme()) {
        const bouton = document.createElement('button')
        bouton.className = 'petit'
        bouton.textContent = libelle
        bouton.onclick = () => { $('horloge-cible').value = pourChamp(iso) }
        raccourcis.appendChild(bouton)
      }
    }
  }

  /**
   * Les quatre moments d'une journée d'événement, lus dans le programme.
   *
   * Trois talks et une veille suffisent à dérouler tout ce qui se teste : la
   * boucle d'attente avant l'ouverture, un début, un milieu, un dépassement de
   * fin. Rien si aucun programme n'est importé — il n'y a alors rien à observer.
   */
  function momentsDuProgramme() {
    const creneaux = (planning?.sessions ?? []).filter((session) => session.startsAt)
    if (creneaux.length === 0) return []
    const tries = [...creneaux].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    const premier = tries[0]
    const dernier = tries[tries.length - 1]
    const talks = tries.filter((session) => session.kind !== 'break')
    const milieu = talks[Math.floor(talks.length / 2)] ?? tries[Math.floor(tries.length / 2)]

    const decale = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60_000).toISOString()
    const moments = [
      ['Avant ouverture', decale(premier.startsAt, -30)],
      ['Première conférence', decale(premier.startsAt, 5)],
      ['Milieu de journée', decale(milieu.startsAt, 5)],
      // Cinq minutes après la fin du dernier créneau : c'est là que la clôture
      // automatique se déclenche, et c'est ce qu'on vient vérifier.
      ['Fin de journée', decale(dernier.endsAt ?? dernier.startsAt, 5)],
    ]
    // Dédoublonné : sur un programme d'un seul créneau, quatre boutons qui
    // mènent au même instant se lisent comme quatre choix.
    const vus = new Set()
    return moments.filter(([, iso]) => (vus.has(iso) ? false : (vus.add(iso), true)))
  }

  async function reglerHorloge(at) {
    try {
      const resultat = await appeler('clock/set', { at })
      avis(at == null ? 'Retour à l\u2019heure réelle' : 'Heure du hub modifiée')
      rendreHorloge({ ...resultat, controllable: true })
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  // Hors développement, ces boutons ne sont pas rendus. Les câbler sans vérifier
  // lèverait sur un null et casserait tout le script de la console — le reste
  // de la page cesserait de répondre, sans un mot dans la console du navigateur.
  if ($('btn-horloge-appliquer') != null) {
    $('btn-horloge-appliquer').onclick = () => {
      const valeur = $('horloge-cible').value
      if (!valeur) { avis('Renseignez une date', true); return }
      // Le champ datetime-local rend une heure locale : on la convertit en instant.
      reglerHorloge(new Date(valeur).toISOString())
    }
    $('btn-horloge-reelle').onclick = () => reglerHorloge(null)
  }

  $('btn-source-programme').onclick = async () => {
    const url = $('url-programme').value.trim()
    try {
      // Vidé = plus de source. Le hub n'importe alors plus rien tout seul, ce
      // qui est un état légitime : un programme déjà en base continue de servir.
      reglages = await appeler('settings/update', { programSourceUrl: url === '' ? null : url })
      rendreSourceProgramme()
      avis('Source du programme enregistrée')
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  $('btn-reglages').onclick = async () => {
    try {
      await appeler('settings/update', {
        autoEndEnabled: $('auto-actif').checked,
        autoEndGraceMinutes: Number($('auto-delai').value),
      })
      avis('Réglages enregistrés')
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  async function tout() {
    try {
      // Seule la vue affichée est chargée : rafraîchir en boucle des panneaux
      // invisibles n'apporterait rien et sollicite le hub pour rien.
      if (vueCourante === 'exploitation') {
        // Les salles seules : c'est l'écran qu'on laisse ouvert toute la
        // journée, il n'a pas à interroger le hub sur le reste.
        await chargerSalles()
      } else if (vueCourante === 'appairage') {
        await Promise.all([chargerAppairages(), chargerMachines()])
      } else if (vueCourante === 'conferences') {
        // Le planning d'abord : c'est lui qui porte le fuseau de l'événement,
        // dans lequel le tableau du dessus lit ses horaires.
        await chargerPlanning()
        await chargerConferences()
      } else if (vueCourante === 'moderation') {
        await chargerModeration()
      } else if (vueCourante === 'messages') {
        await Promise.all([chargerMessages(), chargerBandeaux()])
      } else if (vueCourante === 'developpement') {
        await chargerDeveloppement()
      } else {
        await Promise.all([chargerSnapshots(), chargerReglages()])
      }
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  function demarrer() {
    $('connexion').hidden = true
    $('console').hidden = false
    // Arrivée par le lien que la machine affiche : on ouvre la page où le code
    // se saisit, sinon il faut le chercher dans un onglet qu'on ne connaît pas.
    // Arrivée par le lien que la machine affiche : on ouvre l'appairage, sans
    // toucher à l'adresse — le code y est encore, et la modale le lit.
    basculerVue(codeDeLUrl ? 'appairage' : vueDuChemin(), false)
    if (codeDeLUrl) void verifierCodeDeLUrl()
    // La supervision doit rester vivante sans intervention : c'est l'écran
    // qu'on laisse ouvert toute la journée.
    setInterval(() => { if (!$('console').hidden) void tout() }, 10_000)
  }

  $('btn-deconnexion').onclick = () => seDeconnecter()
  $('btn-notifs').onclick = () => ouvrirReglageNotifs()
  $('notif-fermer').onclick = () => { document.body.dataset.notifs = 'ferme' }
  $('notif-appliquer').onclick = () => void appliquerNotifs()
  rendreBoutonNotifs()
  $('verdict-fermer').onclick = fermerVerdict
  $('verdict-approuver').onclick = () => deciderVerdict(true)
  $('verdict-refuser').onclick = () => deciderVerdict(false)
  $('btn-resync').onclick = ouvrirConfirmationResync
  $('resync-annuler').onclick = fermerConfirmationResync
  $('resync-confirmer').onclick = () => void confirmerResync()
  document.addEventListener('keydown', (evenement) => {
    if (evenement.key === 'Escape') { fermerVerdict(); fermerConfirmationResync() }
  })

  $('btn-rafraichir').onclick = () => tout()
  if ($('btn-google')) $('btn-google').onclick = () => connexionGoogle()

  /**
   * Deux façons d'arriver connecté : le jeton rangé au dernier passage, ou le
   * cookie que vient de poser le retour de Google.
   */
  if (jeton) demarrer()
  else void sessionExistante().then((utilisateur) => {
    if (utilisateur == null) return
    $('identite').textContent = utilisateur.email
    demarrer()
  })
})()
</script>
</body>
</html>`
}
