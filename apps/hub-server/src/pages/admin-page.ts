import { TAILWIND_CSS } from '@cloudnord/ui'

/**
 * Console d'exploitation du hub.
 *
 * Regroupe les quatre gestes du jour J : approuver une machine de salle,
 * importer ou revenir sur un programme, modérer le mur, surveiller les salles.
 * Servie par le hub lui-même, sans étape de build — c'est l'outil dont on a
 * besoin quand quelque chose ne va pas, il doit s'ouvrir sans rien installer.
 */
export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cloud Nord — console hub</title>
<style>${TAILWIND_CSS}</style>
<style>
  /*
   * Ce qui reste hors Tailwind : l'avis flottant, dont l'apparition se pilote
   * par une classe posée depuis le JavaScript.
   */
  #avis { opacity: 0; }
  #avis.visible { opacity: 1; }
  #avis.erreur { border-color: var(--color-alerte); background: #35161a; }
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
  </section>
</div>

<div class="mx-auto max-w-[1180px] p-5" id="console" hidden>
  <header class="mb-5 flex items-center gap-3.5">
    <h1 class="text-[19px] font-semibold">Cloud Nord — console hub</h1>
    <div class="ml-auto text-[13px] text-attenue" id="identite"></div>
    <button class="petit" id="btn-rafraichir">Rafraîchir</button>
  </header>

  <nav class="mb-[18px] flex gap-1.5">
    <button id="nav-exploitation" class="btn btn-onglet actif">Exploitation</button>
    <button id="nav-conferences" class="btn btn-onglet">Conférences</button>
    <button id="nav-moderation" class="btn btn-onglet">Modération</button>
    <button id="nav-messages" class="btn btn-onglet">Messages</button>
    <button id="nav-reglages" class="btn btn-onglet">Réglages</button>
  </nav>

  <div class="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] items-start gap-3.5" id="vue-exploitation">
    <section class="panneau col-span-full">
      <h2 class="titre-panneau">Salles</h2>
      <table>
        <thead><tr><th>Salle</th><th>État</th><th>Scène</th><th>REC</th><th>File</th><th>Vu</th></tr></thead>
        <tbody id="salles"></tbody>
      </table>
    </section>

    <section class="panneau">
      <h2 class="titre-panneau">Machines en attente d'appairage</h2>
      <div id="appairages"></div>
    </section>

    <section class="panneau">
      <h2 class="titre-panneau">Machines appairées</h2>
      <table>
        <thead><tr><th>Machine</th><th>Salle</th><th></th></tr></thead>
        <tbody id="machines"></tbody>
      </table>
    </section>

    <section class="panneau">
      <h2 class="titre-panneau">Programme</h2>
      <div class="mb-[11px]">
        <label for="url-programme">URL de l'export</label>
        <div class="flex items-end gap-[9px] [&>*]:flex-1">
          <input id="url-programme" type="url" placeholder="https://…/programme.json">
          <button class="principal shrink-0" id="btn-importer">Importer</button>
        </div>
      </div>
      <table>
        <thead><tr><th>Version</th><th>Sessions</th><th>Anomalies</th><th></th></tr></thead>
        <tbody id="snapshots"></tbody>
      </table>
    </section>

  </div>

  <div class="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] items-start gap-3.5" id="vue-moderation" hidden>
    <section class="panneau col-span-full">
      <h2 class="titre-panneau">Modération du mur</h2>
      <div class="aide mt-0 mb-3.5">
        Rien n'atteint un écran de salle sans passer par ici : ces messages sont
        projetés devant le public.
      </div>
      <div id="moderation"></div>
    </section>
  </div>

  <div class="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] items-start gap-3.5" id="vue-messages" hidden>
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
  </div>

  <div class="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] items-start gap-3.5" id="vue-conferences" hidden>
    <section class="panneau col-span-full">
      <h2 class="titre-panneau">Conférences — toutes salles</h2>
      <table>
        <thead><tr><th>Salle</th><th>Conférence</th><th>Prévu</th><th>Reste</th><th>État</th><th></th></tr></thead>
        <tbody id="conferences"></tbody>
      </table>
    </section>
  </div>

  <div class="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] items-start gap-3.5" id="vue-reglages" hidden>
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
  </div>
</div>

<div id="avis"></div>

<script>
(() => {
  const $ = (id) => document.getElementById(id)
  let jeton = localStorage.getItem('cloudnord-admin') || null

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

  function deconnecter() {
    jeton = null
    localStorage.removeItem('cloudnord-admin')
    $('console').hidden = true
    $('connexion').hidden = false
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
      localStorage.setItem('cloudnord-admin', jeton)
      $('identite').textContent = $('email').value
      demarrer()
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  const echapper = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  const ilYA = (iso) => {
    if (!iso) return 'jamais'
    const secondes = Math.round((Date.now() - Date.parse(iso)) / 1000)
    if (secondes < 60) return secondes + ' s'
    if (secondes < 3600) return Math.round(secondes / 60) + ' min'
    return Math.round(secondes / 3600) + ' h'
  }

  async function chargerSalles() {
    const salles = await appeler('rooms/statuses')
    $('salles').innerHTML = salles.map((salle) => {
      const classe = salle.connectivity === 'ONLINE' ? '' : salle.connectivity === 'DEGRADED' ? 'degraded' : 'offline'
      return '<tr><td>' + echapper(salle.name) + '</td>' +
        '<td><span class="pastille ' + classe + '"></span>' + salle.connectivity.toLowerCase() + '</td>' +
        '<td>' + echapper(salle.sceneRole ?? '—') + '</td>' +
        '<td>' + (salle.recording ? '<span class="actif">● REC</span>' : '—') + '</td>' +
        '<td>' + (salle.outboxDepth > 0 ? salle.outboxDepth : '—') + '</td>' +
        '<td>' + ilYA(salle.lastSeenAt) + '</td></tr>'
    }).join('') || '<tr><td colspan="6" class="vide">Aucune salle déclarée.</td></tr>'
  }

  async function chargerAppairages() {
    const [attente, salles] = await Promise.all([appeler('devices/pending'), appeler('rooms/list')])
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

  $('btn-importer').onclick = async () => {
    const url = $('url-programme').value.trim()
    if (!url) { avis('Renseignez une URL', true); return }
    $('btn-importer').disabled = true
    try {
      const resultat = await appeler('program/import', { sourceUrl: url })
      avis(resultat.program.sessions.length + ' sessions importées')
      await chargerSnapshots()
    } catch (cause) {
      avis(cause.message, true)
    } finally {
      $('btn-importer').disabled = false
    }
  }

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

  const VUES = ['exploitation', 'conferences', 'moderation', 'messages', 'reglages']
  let vueCourante = 'exploitation'

  function basculerVue(nom) {
    vueCourante = nom
    for (const vue of VUES) {
      $('vue-' + vue).hidden = vue !== nom
      $('nav-' + vue).classList.toggle('actif', vue === nom)
    }
    void tout()
  }
  for (const vue of VUES) $('nav-' + vue).onclick = () => basculerVue(vue)

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
      const heure = (iso) =>
        iso ? new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—'

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
   */
  function resteAuProgramme(etat) {
    if (etat.status !== 'running' || !etat.scheduledEndsAt) return '<span class="text-attenue">—</span>'

    const minutes = Math.round((Date.parse(etat.scheduledEndsAt) - Date.now()) / 60000)
    if (minutes >= 0) {
      const classe = minutes <= 5 ? 'class="text-attention"' : ''
      return '<span ' + classe + '>' + minutes + ' min</span>'
    }
    // Débordement : c'est l'information qui déclenche une décision.
    return '<span class="font-semibold text-alerte">+' + Math.abs(minutes) + ' min</span>'
  }

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

  async function chargerReglages() {
    const [reglages, horloge] = await Promise.all([appeler('settings/get'), appeler('clock/get')])
    $('auto-actif').checked = reglages.autoEndEnabled
    $('auto-delai').value = reglages.autoEndGraceMinutes
    rendreHorloge(horloge)
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
      dateStyle: 'full', timeStyle: 'medium', timeZone: 'Europe/Paris',
    }).format(new Date(horloge.serverTime))

    $('horloge-controles').hidden = !horloge.controllable
    $('horloge-aide').innerHTML = horloge.controllable
      ? "Déplacer l'heure déplace <strong>tout le système</strong> : les salles s'alignent " +
        'aussitôt. Outil de développement — pendant l\u2019événement, cela fausserait les ' +
        'timecodes des enregistrements et déclencherait des clôtures à contretemps.'
      : 'Réglage fermé sur ce hub. L\u2019ouvrir avec <code>CLOCK_CONTROL=1</code>, ' +
        'à réserver au développement.'

    if (!horloge.controllable) return
    if (!$('horloge-cible').value) $('horloge-cible').value = pourChamp(horloge.serverTime)

    // Raccourcis vers les moments qu'on veut réellement observer.
    const raccourcis = $('horloge-raccourcis')
    if (raccourcis.childElementCount === 0) {
      const moments = [
        ['Ouverture', '2026-10-30T09:30'],
        ['Premier talk', '2026-10-30T11:00'],
        ['Déjeuner', '2026-10-30T12:30'],
        ['Fin de journée', '2026-10-30T18:30'],
      ]
      for (const [libelle, valeur] of moments) {
        const bouton = document.createElement('button')
        bouton.className = 'petit'
        bouton.textContent = libelle
        bouton.onclick = () => { $('horloge-cible').value = valeur }
        raccourcis.appendChild(bouton)
      }
    }
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

  $('btn-horloge-appliquer').onclick = () => {
    const valeur = $('horloge-cible').value
    if (!valeur) { avis('Renseignez une date', true); return }
    // Le champ datetime-local rend une heure locale : on la convertit en instant.
    reglerHorloge(new Date(valeur).toISOString())
  }
  $('btn-horloge-reelle').onclick = () => reglerHorloge(null)

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
        await Promise.all([
          chargerSalles(), chargerAppairages(), chargerMachines(), chargerSnapshots(),
        ])
      } else if (vueCourante === 'conferences') {
        await chargerConferences()
      } else if (vueCourante === 'moderation') {
        await chargerModeration()
      } else if (vueCourante === 'messages') {
        await chargerMessages()
      } else {
        await chargerReglages()
      }
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  function demarrer() {
    $('connexion').hidden = true
    $('console').hidden = false
    void tout()
    // La supervision doit rester vivante sans intervention : c'est l'écran
    // qu'on laisse ouvert toute la journée.
    setInterval(() => { if (!$('console').hidden) void tout() }, 10_000)
  }

  $('btn-rafraichir').onclick = () => tout()
  if (jeton) demarrer()
})()
</script>
</body>
</html>`
}
