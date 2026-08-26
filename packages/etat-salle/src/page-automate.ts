import { MACHINE_JS } from './generated/navigateur.js'

/**
 * Banc d'essai de l'automate.
 *
 * Une page autonome où l'on charge le programme d'une salle, où l'on pousse
 * l'heure à la vitesse qu'on veut, et où l'on regarde l'automate répondre. Elle
 * n'imite rien : elle inline `MACHINE_JS`, exactement comme la régie et la
 * console, et appelle les mêmes fonctions. Un état qui colle ici colle en
 * salle, et c'est tout l'intérêt — le jour J, on ne peut pas rejouer 09:50.
 *
 * Trois choses qu'on ne voit nulle part ailleurs :
 *
 * - le **journal** des changements d'état, horodaté à l'heure simulée : c'est
 *   lui qui montre qu'une salle revient — ou ne revient pas — à un état neutre ;
 * - la **clôture automatique** appliquée en direct, avec son délai de grâce, et
 *   un interrupteur pour retirer les heures de fin explicites — le cas où la
 *   règle horaire ne voit rien passer ;
 * - le **schéma** de l'automate, l'état courant allumé et la dernière
 *   transition surlignée.
 */
export interface CreneauApercu {
  id: string
  title: string
  kind: 'talk' | 'break'
  startsAt: string
  startsAtMs: number
  endsAt: string | null
  endsAtMs: number | null
  durationMinutes: number | null
}

export interface SalleApercu {
  id: string
  name: string
  creneaux: CreneauApercu[]
}

export interface AutomatePageOptions {
  salles: SalleApercu[]
  timezone: string
  /** Instant d'ouverture. Par défaut, le début du premier créneau. */
  depart?: number
  /** Nom de l'événement, pour le titre. */
  evenement?: string
}

export function renderAutomatePage(options: AutomatePageOptions): string {
  const donnees = {
    salles: options.salles,
    timezone: options.timezone,
    depart: options.depart ?? options.salles[0]?.creneaux[0]?.startsAtMs ?? Date.now(),
    evenement: options.evenement ?? 'Programme',
  }

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Automate d'une salle — banc d'essai</title>
<style>
  :root {
    --fond: #0e1116; --surface: #161b22; --surface2: #1c2129; --bord: #2b3240;
    --texte: #e6edf3; --attenue: #8b949e;
    --ok: #3fb950; --attention: #d29922; --alerte: #f85149; --marque: #58a6ff;
    --hors: #484f58;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--fond); color: var(--texte);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  h1 { font-size: 15px; margin: 0; font-weight: 600; }
  h2 { font-size: 12px; margin: 0 0 10px; font-weight: 600; text-transform: uppercase;
       letter-spacing: .08em; color: var(--attenue); }
  .barre { display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
           padding: 12px 16px; background: var(--surface); border-bottom: 1px solid var(--bord); }
  .grille { display: grid; grid-template-columns: 360px 1fr; gap: 16px; padding: 16px; align-items: start; }
  @media (max-width: 1100px) { .grille { grid-template-columns: 1fr; } }
  .carte { background: var(--surface); border: 1px solid var(--bord); border-radius: 10px; padding: 14px; }
  .carte + .carte { margin-top: 16px; }
  button, select, input[type=number], input[type=datetime-local] {
    font: inherit; color: inherit; background: var(--surface2);
    border: 1px solid var(--bord); border-radius: 7px; padding: 6px 10px;
  }
  button { cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--marque); }
  button:disabled { opacity: .4; cursor: not-allowed; }
  button.primaire { background: var(--marque); color: #05121f; border-color: transparent; font-weight: 600; }
  button.actif { border-color: var(--ok); }
  label { display: inline-flex; align-items: center; gap: 6px; color: var(--attenue); font-size: 13px; }
  .attenue { color: var(--attenue); }
  .alerte { color: var(--alerte); }
  .attention { color: var(--attention); }
  .num { font-variant-numeric: tabular-nums; }

  /*
   * Pastille : mêmes teintes que la régie et la console, dans la palette du
   * banc d'essai.
   *
   * Ce banc a sa propre palette — plus contrastée, pensée pour être lue à côté
   * d'un diagramme, pas dans une salle sombre. Ce qui doit correspondre, ce sont
   * les *noms* : ils viennent de la table des apparences, et cette liste doit
   * les couvrir tous. Le contour de confiance (doute, muette) n'y figure pas, et
   * c'est volontaire — ce banc ne rend qu'un état de conférence, jamais une
   * connectivité. Le test « vocabulaire de la pastille », dans le paquet ui,
   * tient la correspondance.
   */
  .pastille { width: 14px; height: 14px; border-radius: 999px; background: var(--ok); display: inline-block; }
  .pastille.hors { background: var(--hors); }
  .pastille.pas-commencee { background: var(--hors); }
  .pastille.retard { background: var(--attention); }
  .pastille.fin-proche { background: var(--attention); }
  .pastille.terminee { background: var(--hors); }
  .pastille.depassement { background: var(--alerte); }

  .etat-grand { display: flex; align-items: center; gap: 12px; font-size: 22px; font-weight: 600; }
  .etat-grand .pastille { width: 20px; height: 20px; }

  .creneau { display: grid; grid-template-columns: 96px 1fr auto; gap: 10px; align-items: baseline;
             padding: 6px 8px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
  .creneau:hover { background: var(--surface2); }
  .creneau.courant { background: color-mix(in srgb, var(--marque) 18%, transparent);
                     box-shadow: inset 3px 0 0 var(--marque); }
  .creneau.cible { border-color: var(--marque); }
  .creneau.passe { opacity: .45; }
  .creneau.break { font-style: italic; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--bord); }
  .badge.running { border-color: var(--ok); color: var(--ok); }
  .badge.ended { border-color: var(--hors); color: var(--attenue); }
  button.kind { font-size: 11px; padding: 1px 8px; border-radius: 999px; color: var(--attenue); }
  button.kind.surcharge { color: var(--marque); border-color: var(--marque); }

  #journal { max-height: 260px; overflow-y: auto; font-size: 12.5px; }
  #journal div { padding: 3px 0; border-top: 1px solid var(--bord); }
  #journal div:first-child { border-top: 0; }

  svg .noeud rect { fill: var(--surface2); stroke: var(--bord); stroke-width: 1.5; }
  svg .noeud text { fill: var(--attenue); font-size: 12px; text-anchor: middle; }
  svg .noeud.allume rect { stroke-width: 2.5; }
  svg .noeud.allume text { fill: var(--texte); font-weight: 600; }
  svg .arete { stroke: var(--bord); fill: none; stroke-width: 1.5; marker-end: url(#fleche); }
  svg .arete.derniere { stroke: var(--marque); stroke-width: 2.5; marker-end: url(#flecheVive); }
  /* Le liseré perce les traits qui passent dessous : sans lui, l'étiquette se
     lit à moitié dès que deux flèches se croisent. */
  svg .etiquette { fill: var(--attenue); font-size: 10.5px; text-anchor: middle;
                   stroke: var(--surface); stroke-width: 3px; paint-order: stroke; }
  svg .etiquette.derniere { fill: var(--marque); }
</style>
</head>
<body>

<div class="barre">
  <h1>Automate d'une salle</h1>
  <select id="salle"></select>
  <span class="attenue">|</span>
  <label>heure simulée <input type="datetime-local" id="horloge" step="1"></label>
  <button id="pause">▶︎</button>
  <select id="vitesse">
    <option value="1">×1</option>
    <option value="60" selected>×60</option>
    <option value="600">×600</option>
  </select>
  <button id="recul">−5 min</button>
  <button id="avance">+5 min</button>
  <span class="attenue">|</span>
  <button id="rejouer">Rejouer la journée</button>
  <span id="ecart" class="attenue num"></span>
</div>

<div style="padding: 0 16px;">
  <input type="range" id="curseur" style="width: 100%;" min="0" max="1000" value="0">
</div>

<div class="grille">
  <div>
    <div class="carte">
      <h2>Où en est la salle</h2>
      <div class="etat-grand"><span class="pastille" id="pastille"></span><span id="mot"></span></div>
      <div id="detail" class="attenue" style="margin-top: 8px;"></div>
      <div id="pause-badge" style="margin-top: 8px;"></div>
      <div id="deborde"></div>
    </div>

    <div class="carte">
      <h2>Piloter la conférence</h2>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <button id="commencer" class="primaire">Commencer</button>
        <button id="terminer">Terminer</button>
        <button id="remettre">Remettre à venir</button>
      </div>
      <div id="cible" class="attenue" style="margin-top: 10px;"></div>
    </div>

    <div class="carte">
      <h2>Clôture automatique</h2>
      <div style="display: flex; gap: 14px; align-items: center; flex-wrap: wrap;">
        <label><input type="checkbox" id="auto-actif" checked> active</label>
        <label>grâce <input type="number" id="auto-grace" value="5" min="0" max="120" style="width: 68px;"> min</label>
      </div>
      <label style="margin-top: 10px;">
        <input type="checkbox" id="sans-fin">
        retirer les heures de fin explicites
      </label>
      <div class="attenue" style="margin-top: 6px; font-size: 12.5px;">
        La règle horaire lit la même fin que le dépassement : heure explicite, sinon durée,
        sinon début du créneau suivant. Cocher ci-dessus le vérifie — seul un créneau
        qu'aucune des trois règles ne ferme reste ouvert, et c'est alors à raison.
      </div>
    </div>
  </div>

  <div>
    <div class="carte">
      <h2>L'automate</h2>
      <svg id="schema" viewBox="0 0 900 360" style="width: 100%; height: auto;"></svg>
    </div>

    <div class="carte">
      <h2>Créneaux de la salle <span class="attenue" style="text-transform: none; letter-spacing: 0;">— cliquer pour cibler, le type pour le surcharger</span></h2>
      <div id="creneaux"></div>
    </div>

    <div class="carte">
      <h2>Journal <span class="attenue" style="text-transform: none; letter-spacing: 0;">— heure simulée</span></h2>
      <div id="journal"></div>
    </div>
  </div>
</div>

<script id="donnees" type="application/json">${JSON.stringify(donnees).replace(/</g, '\\u003c')}</script>

<!-- L'automate, inliné : les mêmes fonctions que le hub et la régie. -->
<script>${MACHINE_JS}</script>

<script>
(() => {
  const $ = (id) => document.getElementById(id)
  const DONNEES = JSON.parse($('donnees').textContent)

  /** Ce que la page pilote : une salle, un instant, des décisions. */
  let salleId = DONNEES.salles[0].id
  let instant = DONNEES.depart
  /**
   * Les décisions, **datées de l'heure simulée où on les a prises**.
   *
   * Pas une simple table identifiant → statut : reculer l'horloge doit défaire
   * ce qui n'avait pas encore eu lieu. Sans la date, terminer une conférence à
   * 09:05 puis revenir à 08:59 laissait la salle « terminée » — sur un créneau
   * que personne n'avait encore touché à cette heure-là. Le hub applique
   * exactement cette règle depuis toujours ; c'est la page qui ne l'avait pas.
   */
  let decisions = {}
  /**
   * Surcharges de créneau, comme le hub en sert.
   *
   * L'export ne dit pas tout : le normaliseur n'a qu'un signal pour trancher —
   * un créneau **sans intervenant** est une pause — et il se trompe dans les
   * deux sens. Une keynote dont l'intervenant n'est pas encore annoncé passe
   * pour un déjeuner, et la salle se lit « rien dans la salle » alors qu'on y
   * attend du monde. Corriger le type du créneau est la réponse prévue, et
   * c'est ici qu'on vérifie ce qu'elle donne avant de la poser sur le hub.
   */
  let surcharges = {}
  let cibleManuelle = null
  let joue = false
  let dernierEtat = null
  let derniereArete = null
  const journal = []

  const salle = () => DONNEES.salles.find((s) => s.id === salleId)

  /**
   * Les créneaux tels que l'automate les voit.
   *
   * L'interrupteur « sans heure de fin » ne bricole pas l'automate : il retire
   * la donnée, comme le ferait un export qui ne porte que des heures de début.
   */
  function creneaux() {
    const bruts = salle().creneaux.map((c) =>
      surcharges[c.id] == null ? c : { ...c, kind: surcharges[c.id] },
    )
    return $('sans-fin').checked ? bruts.map((c) => ({ ...c, endsAtMs: null, endsAt: null })) : bruts
  }

  const heure = (ms) =>
    new Intl.DateTimeFormat('fr-FR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: DONNEES.timezone,
    }).format(new Date(ms))

  const jourEtHeure = (ms) =>
    new Intl.DateTimeFormat('fr-FR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: DONNEES.timezone,
    }).format(new Date(ms))

  function duree(ms) {
    const signe = ms < 0 ? '−' : ''
    const total = Math.round(Math.abs(ms) / 1000)
    const min = Math.floor(total / 60)
    return signe + min + ' min ' + String(total % 60).padStart(2, '0') + ' s'
  }

  /**
   * Le créneau piloté : celui qu'on a désigné, sinon le courant, sinon le suivant.
   *
   * Même règle qu'en régie : entre deux talks ou pendant une pause, c'est la
   * conférence qui arrive qu'on veut pouvoir lancer.
   */
  function cible() {
    const liste = creneaux()
    if (cibleManuelle != null) return liste.find((c) => c.id === cibleManuelle) ?? null
    // La même règle que la régie, prise au même endroit : le banc n'a d'intérêt
    // que s'il déroule l'automate et non une copie qui lui ressemble.
    return EtatSalle.conferenceAPiloter(liste, instant, statutsA(instant))
  }

  /**
   * Les statuts tels qu'ils s'appliquent à un instant donné.
   *
   * On filtre à la lecture, jamais en effaçant : ré-avancer l'horloge retrouve
   * la journée là où on l'avait laissée.
   */
  function statutsA(t) {
    const vus = {}
    for (const [id, decision] of Object.entries(decisions)) {
      if (EtatSalle.decisionApplicable(decision.a, t)) vus[id] = decision.statut
    }
    return vus
  }

  const statutDe = (creneau) =>
    creneau == null ? 'scheduled' : statutsA(instant)[creneau.id] ?? 'scheduled'

  function noter(texte, teinte) {
    journal.unshift({ a: instant, texte, teinte: teinte ?? '' })
    if (journal.length > 200) journal.pop()
  }

  /** Applique un geste, si la table l'autorise. */
  function agir(action) {
    const creneau = cible()
    if (creneau == null) return
    const statut = statutDe(creneau)
    const refus = EtatSalle.refusDeTransition(statut, action)
    if (refus != null) {
      noter('refusé — ' + refus, 'alerte')
      rendre()
      return
    }
    const suivant = EtatSalle.statutApres(statut, action)
    if (action === 'reset') delete decisions[creneau.id]
    else decisions[creneau.id] = { statut: suivant, a: instant }
    noter(
      { start: 'Commencer', end: 'Terminer', reset: 'Remettre à venir' }[action] +
        ' · ' + creneau.title.slice(0, 40) + ' → ' + suivant,
    )
    rendre()
  }

  /**
   * La règle horaire, appliquée à chaque tic.
   *
   * C'est aClore de la lib, pas une imitation : ce qui ferme ici ferme sur le
   * hub, et ce qui reste ouvert ici reste ouvert le jour J.
   */
  function clotureAutomatique() {
    const reglage = {
      actif: $('auto-actif').checked,
      graceMinutes: Number($('auto-grace').value) || 0,
    }
    const liste = creneaux()
    for (const creneau of EtatSalle.aClore(liste, instant, statutsA(instant), reglage)) {
      decisions[creneau.id] = { statut: 'ended', a: instant }
      noter('clôture automatique · ' + creneau.title.slice(0, 40), 'attention')
    }
  }

  // ————————————————————————————————— le schéma

  /**
   * Le schéma de l'automate, dessiné à la main.
   *
   * Les huit états, disposés comme la vie d'un créneau se déroule : le hors
   * créneau en haut, la conférence au milieu, ce qui la termine en bas.
   */
  const NOEUDS = {
    aucune: { x: 120, y: 40, mot: 'hors créneau' },
    pause: { x: 320, y: 40, mot: 'pause' },
    'pas-commencee': { x: 120, y: 130, mot: 'pas commencée' },
    retard: { x: 320, y: 130, mot: 'retard' },
    'en-cours': { x: 540, y: 130, mot: 'en cours' },
    'fin-proche': { x: 750, y: 130, mot: 'vers la fin' },
    terminee: { x: 540, y: 290, mot: 'terminée' },
    depassement: { x: 750, y: 230, mot: 'dépassement' },
  }
  const L = 150
  const H = 34

  const ARETES = [
    ['aucune', 'pause', 'un break'],
    ['aucune', 'pas-commencee', 'un talk'],
    ['pause', 'pas-commencee', ''],
    ['pas-commencee', 'retard', '+5 min'],
    ['pas-commencee', 'en-cours', 'Commencer'],
    ['retard', 'en-cours', 'Commencer'],
    ['en-cours', 'fin-proche', '≤5 min'],
    ['fin-proche', 'depassement', 'fin atteinte'],
    ['en-cours', 'terminee', 'Terminer'],
    ['fin-proche', 'terminee', 'Terminer'],
    ['depassement', 'terminee', 'clôture'],
    ['terminee', 'aucune', 'fin du créneau'],
    ['terminee', 'pas-commencee', ''],
    ['depassement', 'pas-commencee', ''],
  ]

  /**
   * Le point où la droite centre-à-centre sort du cadre.
   *
   * Sans ça, les flèches partent du centre et passent sous les boîtes : on ne
   * voit plus ce qui va vers quoi, et les étiquettes atterrissent au milieu
   * d'un état.
   */
  function bord(centre, dx, dy) {
    const rx = L / 2 + 5
    const ry = H / 2 + 5
    const echelle = Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry)
    if (echelle === 0) return { x: centre.x, y: centre.y }
    return { x: centre.x + dx / echelle, y: centre.y + dy / echelle }
  }

  /** Bord à bord : la flèche s'arrête au cadre, pas au centre. */
  function segment(a, b) {
    const de = NOEUDS[a]
    const vers = NOEUDS[b]
    const dx = vers.x - de.x
    const dy = vers.y - de.y
    const p1 = bord(de, dx, dy)
    const p2 = bord(vers, -dx, -dy)
    return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }
  }

  function dessinerSchema() {
    const parts = [
      '<defs>',
      '<marker id="fleche" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">',
      '<path d="M0,0 L8,4 L0,8 z" fill="#2b3240"/></marker>',
      '<marker id="flecheVive" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">',
      '<path d="M0,0 L8,4 L0,8 z" fill="#58a6ff"/></marker>',
      '</defs>',
    ]

    for (const [de, vers, mot] of ARETES) {
      const s = segment(de, vers)
      const vive = derniereArete != null && derniereArete[0] === de && derniereArete[1] === vers
      parts.push(
        '<line class="arete' + (vive ? ' derniere' : '') + '" x1="' + s.x1 + '" y1="' + s.y1 +
          '" x2="' + s.x2 + '" y2="' + s.y2 + '"/>',
      )
      if (mot) {
        parts.push(
          '<text class="etiquette' + (vive ? ' derniere' : '') + '" x="' + (s.x1 + s.x2) / 2 +
            '" y="' + ((s.y1 + s.y2) / 2 - 5) + '">' + mot + '</text>',
        )
      }
    }

    for (const [nom, noeud] of Object.entries(NOEUDS)) {
      const apparence = EtatSalle.apparenceDe(nom)
      const allume = nom === dernierEtat
      const couleur = {
        '': 'var(--ok)', hors: 'var(--hors)', 'pas-commencee': 'var(--hors)',
        retard: 'var(--attention)', 'fin-proche': 'var(--attention)',
        terminee: 'var(--hors)', depassement: 'var(--alerte)',
      }[apparence.teinte] ?? 'var(--hors)'
      parts.push(
        '<g class="noeud' + (allume ? ' allume' : '') + '">' +
          '<rect x="' + (noeud.x - L / 2) + '" y="' + (noeud.y - H / 2) + '" width="' + L +
          '" height="' + H + '" rx="8"' + (allume ? ' stroke="' + couleur + '"' : '') + '/>' +
          '<circle cx="' + (noeud.x - L / 2 + 14) + '" cy="' + noeud.y + '" r="5" fill="' + couleur +
          '" opacity="' + (allume ? 1 : 0.35) + '"/>' +
          '<text x="' + (noeud.x + 7) + '" y="' + (noeud.y + 4) + '">' + noeud.mot + '</text>' +
          '</g>',
      )
    }

    $('schema').innerHTML = parts.join('')
  }

  // ————————————————————————————————— le rendu

  function rendre() {
    const liste = creneaux()
    const etat = EtatSalle.etatDesCreneaux(liste, instant, statutsA(instant))
    const apparence = EtatSalle.apparenceDe(etat)

    if (etat !== dernierEtat) {
      derniereArete = dernierEtat == null ? null : [dernierEtat, etat]
      noter(
        dernierEtat == null ? 'état initial · ' + apparence.mot : dernierEtat + ' → ' + etat,
        apparence.teinte === 'depassement' ? 'alerte' : '',
      )
      dernierEtat = etat
    }

    $('pastille').className = 'pastille ' + apparence.teinte
    $('mot').textContent = apparence.mot

    const position = EtatSalle.timelinePosition(liste, instant)
    const courant = position.current
    const index = courant == null ? -1 : liste.indexOf(courant)
    const fin = index < 0 ? null : EtatSalle.finEffectiveA(liste, index)
    $('detail').innerHTML = courant == null
      ? 'Aucun créneau à cet instant. Suivant : ' +
        (position.next == null ? '—' : position.next.title + ' à ' + heure(position.next.startsAtMs))
      : '<b>' + courant.title + '</b><br>' +
        heure(courant.startsAtMs) + ' → ' + (fin == null ? 'fin inconnue' : heure(fin)) +
        (fin == null ? '' : ' · <span class="num">' + duree(fin - instant) + '</span> ' +
          (fin - instant < 0 ? 'de dépassement' : 'restantes'))

    /**
     * Qui déborde, nommément.
     *
     * L'état dit « dépassement », mais le créneau affiché juste au-dessus est
     * le créneau *courant* — pas celui qui traîne. Sans ce rappel, on cherche
     * le coupable dans la liste, et c'est précisément ce qu'on est venu voir.
     */
    const applicables = statutsA(instant)
    const debordent = liste.filter((c, i) => {
      if (applicables[c.id] !== 'running' || c.kind === 'break') return false
      const finC = EtatSalle.finEffectiveA(liste, i)
      return finC != null && finC <= instant
    })
    $('deborde').innerHTML = debordent.length === 0
      ? ''
      : debordent.map((c) =>
          '<div class="alerte" style="margin-top:8px;">Déborde depuis ' +
          duree(instant - (EtatSalle.finEffectiveA(liste, liste.indexOf(c)) ?? instant)) + ' : <b>' +
          c.title + '</b> <button data-deborde="' + c.id + '" style="padding:2px 8px;">cibler</button></div>',
        ).join('')
    for (const b of $('deborde').querySelectorAll('[data-deborde]')) {
      b.onclick = () => { cibleManuelle = b.dataset.deborde; rendre() }
    }

    const pause = EtatSalle.pauseDesCreneaux(liste, instant)
    $('pause-badge').innerHTML = pause == null
      ? '<span class="attenue">Aucun break en vue.</span>'
      : '<span class="badge">' + (pause.state === 'en-cours' ? 'BREAK' : 'BREAK à venir') + '</span> ' +
        pause.session.title + (pause.endsAtMs == null ? '' : ' · reprise ' + heure(pause.endsAtMs))

    // Les trois boutons suivent la table, comme en régie.
    const creneauCible = cible()
    const statut = statutDe(creneauCible)
    for (const [id, action] of [['commencer', 'start'], ['terminer', 'end'], ['remettre', 'reset']]) {
      const refus = creneauCible == null
        ? 'Aucune conférence à piloter.'
        : EtatSalle.refusDeTransition(statut, action)
      $(id).disabled = refus != null
      $(id).title = refus ?? ''
    }
    $('cible').innerHTML = creneauCible == null
      ? 'Aucun créneau piloté.'
      : 'Créneau piloté : <b>' + creneauCible.title + '</b> · statut <span class="badge ' + statut +
        '">' + statut + '</span>' +
        (cibleManuelle == null ? '' : ' <button id="delier" style="padding:2px 8px;">délier</button>')
    const delier = $('delier')
    if (delier != null) delier.onclick = () => { cibleManuelle = null; rendre() }

    $('creneaux').innerHTML = liste.map((c, i) => {
      const finC = EtatSalle.finEffectiveA(liste, i)
      const statutC = applicables[c.id]
      const classes = ['creneau']
      if (c === courant) classes.push('courant')
      if (creneauCible != null && c.id === creneauCible.id) classes.push('cible')
      if (finC != null && finC <= instant && c !== courant) classes.push('passe')
      if (c.kind === 'break') classes.push('break')
      const surcharge = surcharges[c.id] != null
      return '<div class="' + classes.join(' ') + '" data-id="' + c.id + '">' +
        '<span class="attenue num">' + heure(c.startsAtMs).slice(0, 5) +
        (finC == null ? '' : '–' + heure(finC).slice(0, 5)) + '</span>' +
        '<span>' + c.title + '</span>' +
        '<span style="white-space: nowrap;">' +
        (statutC == null ? '' : '<span class="badge ' + statutC + '">' + statutC + '</span> ') +
        '<button class="kind' + (surcharge ? ' surcharge' : '') + '" data-kind="' + c.id +
        '" title="Surcharger le type de ce créneau, comme le fait le hub">' +
        c.kind + (surcharge ? ' ✳︎' : '') + '</button>' +
        '</span></div>'
    }).join('')
    for (const ligne of $('creneaux').querySelectorAll('[data-id]')) {
      ligne.onclick = () => { cibleManuelle = ligne.dataset.id; rendre() }
    }
    for (const b of $('creneaux').querySelectorAll('[data-kind]')) {
      b.onclick = (evenement) => {
        // Sans ça, surcharger un créneau le désignerait aussi comme cible.
        evenement.stopPropagation()
        const id = b.dataset.kind
        const actuel = liste.find((c) => c.id === id)
        const vers = actuel.kind === 'talk' ? 'break' : 'talk'
        const origine = salle().creneaux.find((c) => c.id === id).kind
        if (vers === origine) delete surcharges[id]
        else surcharges[id] = vers
        noter('surcharge · ' + actuel.title.slice(0, 32) + ' → ' + vers)
        rendre()
      }
    }

    $('journal').innerHTML = journal.map((e) =>
      '<div><span class="attenue num">' + heure(e.a) + '</span> ' +
      '<span class="' + e.teinte + '">' + e.texte + '</span></div>').join('')

    const bornes = etendue()
    $('curseur').value = String(
      Math.round(((instant - bornes.debut) / (bornes.fin - bornes.debut)) * 1000),
    )
    $('horloge').value = champDate(instant)
    $('ecart').textContent = jourEtHeure(instant)

    dessinerSchema()
  }

  /** La journée de la salle, du premier début à la dernière fin, avec un peu d'air. */
  function etendue() {
    const liste = creneaux()
    const premier = liste[0]
    const dernier = liste[liste.length - 1]
    const debut = (premier?.startsAtMs ?? DONNEES.depart) - 30 * 60000
    const finBrute = dernier == null
      ? DONNEES.depart
      : EtatSalle.finEffectiveA(liste, liste.length - 1) ?? dernier.startsAtMs + 60 * 60000
    return { debut, fin: finBrute + 60 * 60000 }
  }

  /**
   * Le champ datetime-local veut une heure locale, pas un instant.
   *
   * On l'écrit dans le fuseau de l'événement : lire 10:00 quand la salle joue à
   * 10:00 est le minimum qu'on attende d'un banc d'essai de l'horloge.
   */
  function champDate(ms) {
    const parts = new Intl.DateTimeFormat('sv-SE', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: DONNEES.timezone, hour12: false,
    }).format(new Date(ms))
    return parts.replace(' ', 'T')
  }

  /** L'inverse : on cherche l'instant dont l'écriture locale est celle saisie. */
  function depuisChamp(valeur) {
    const vise = valeur.length === 16 ? valeur + ':00' : valeur
    const cible = Date.parse(vise + 'Z')
    if (Number.isNaN(cible)) return null
    /**
     * On cherche le point fixe : l'instant dont l'écriture locale est celle
     * saisie. L'écart se mesure contre la saisie, jamais contre l'essai
     * courant — sinon chaque passe retranche à nouveau le décalage du fuseau,
     * et deux passes mettent la page deux heures avant l'heure demandée.
     */
    let essai = cible
    for (let i = 0; i < 3; i += 1) {
      const ecart = Date.parse(champDate(essai) + 'Z') - cible
      if (ecart === 0) break
      essai -= ecart
    }
    return essai
  }

  // ————————————————————————————————— les commandes

  $('salle').innerHTML = DONNEES.salles
    .map((s) => '<option value="' + s.id + '">' + s.name + ' (' + s.creneaux.length + ')</option>')
    .join('')
  $('salle').onchange = () => {
    salleId = $('salle').value
    cibleManuelle = null
    dernierEtat = null
    derniereArete = null
    noter('salle : ' + salle().name)
    rendre()
  }

  $('commencer').onclick = () => agir('start')
  $('terminer').onclick = () => agir('end')
  $('remettre').onclick = () => agir('reset')

  $('pause').onclick = () => {
    joue = !joue
    $('pause').textContent = joue ? '❚❚' : '▶︎'
    $('pause').classList.toggle('actif', joue)
  }
  $('recul').onclick = () => { instant -= 5 * 60000; tic(0) }
  $('avance').onclick = () => { instant += 5 * 60000; tic(0) }

  $('rejouer').onclick = () => {
    // Les surcharges survivent : elles corrigent le programme, elles ne font
    // pas partie des décisions de la journée qu'on rejoue.
    decisions = {}
    cibleManuelle = null
    dernierEtat = null
    derniereArete = null
    journal.length = 0
    instant = etendue().debut
    noter('journée remise à zéro')
    rendre()
  }

  $('curseur').oninput = () => {
    const bornes = etendue()
    instant = bornes.debut + (Number($('curseur').value) / 1000) * (bornes.fin - bornes.debut)
    tic(0)
  }
  $('horloge').onchange = () => {
    const lu = depuisChamp($('horloge').value)
    if (lu != null) { instant = lu; tic(0) }
  }
  for (const id of ['auto-actif', 'auto-grace', 'sans-fin']) $(id).onchange = () => rendre()

  /** Un tic : l'heure avance, la règle horaire s'applique, on redessine. */
  function tic(deltaMs) {
    if (deltaMs > 0) instant += deltaMs
    clotureAutomatique()
    rendre()
  }

  const PAS_MS = 100
  setInterval(() => {
    if (!joue) return
    tic(Number($('vitesse').value) * PAS_MS)
  }, PAS_MS)

  noter('ouverture')
  rendre()
})()
</script>
</body>
</html>`
}
