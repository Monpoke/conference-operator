import { TAILWIND_CSS } from '@cloudnord/ui'
import { IDENTITE_PAR_DEFAUT, type EventIdentity } from '@cloudnord/contract'

export interface WallPageOptions {
  roomId: string | null
  rooms: { id: string; name: string }[]
  /**
   * Nom de l'événement, tranché par le hub.
   *
   * Rendu dans la page et non demandé par elle : c'est le premier mot que lit
   * quelqu'un qui vient de scanner un QR au fond d'une salle, et l'obtenir
   * d'un aller-retour réseau de plus le ferait apparaître après le reste — sur
   * la 4G d'une salle de conférence, bien après.
   */
  event?: EventIdentity
}

/**
 * Échappe une valeur insérée dans le HTML rendu.
 *
 * Le nom de l'événement vient de l'export amont ou d'un réglage de la console :
 * deux sources de confiance, mais aucune raison de faire une exception à la
 * règle dans une page construite par concaténation.
 */
function echapperServeur(valeur: string): string {
  return valeur.replace(/[&<>"']/g, (caractere) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[caractere]!)
}

/**
 * Mur public, scanné au QR code depuis un mobile.
 *
 * Contraintes qui expliquent la forme : elle s'ouvre sur la 4G d'une salle de
 * conférence, sur des téléphones quelconques, en une poignée de secondes. D'où
 * du HTML autonome, aucune dépendance externe, et des appels au contrat via un
 * `fetch` minimal — le protocole oRPC en HTTP est un simple `{ json: … }`.
 */
export function renderWallPage({ roomId, rooms, event }: WallPageOptions): string {
  const donnees = JSON.stringify({ roomId, rooms }).replace(/</g, '\\u003c')
  const identite = event ?? IDENTITE_PAR_DEFAUT
  const nom = echapperServeur(identite.name)

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#10121a">
<title>${nom} — mur &amp; questions</title>
<style>${TAILWIND_CSS}</style>
<style>
  /*
   * Contraintes propres au mobile, que les utilitaires n'expriment pas.
   *
   * La taille de saisie est la plus importante : **en dessous de 16 px, iOS
   * zoome automatiquement au focus** et casse la mise en page pour le reste de
   * la visite. La feuille partagée met les saisies en 14 px, taille juste pour
   * une console au clavier ; ici elle doit être remontée.
   */
  input, textarea, select { font-size: 16px; }
  textarea { min-height: 108px; resize: vertical; }
  body {
    min-height: 100dvh;
    padding: env(safe-area-inset-top) 16px calc(env(safe-area-inset-bottom) + 24px);
  }
  /* Pas de flash gris au toucher : la page est faite pour le doigt. */
  * { -webkit-tap-highlight-color: transparent; }
</style>
</head>
<body class="mx-auto max-w-[620px] bg-fond font-sans text-texte">
<header class="pt-[22px] pb-3.5">
  <h1 class="text-[21px] font-bold">${nom}</h1>
  <div class="mt-1 text-sm text-attenue" id="salle"></div>

  <!--
    Choix de la salle, sur la page.

    Le QR de chaque salle porte déjà la sienne, mais un participant arrive
    aussi par un lien partagé, ou change de salle entre deux talks. Sans ce
    choix, il tombait sur « Ouvrez le lien de votre salle » sans savoir quoi
    ouvrir — et sa question restait dans sa tête.

    Il ne concerne **que** les questions : le mur, lui, est commun à tout
    l'événement. D'où sa place dans l'onglet Questions plutôt que dans l'en-tête.
  -->

  <!-- Ce qu'il écoute en ce moment : « posez votre question » doit dire à
       propos de quoi, et la question arrive en régie rattachée au bon talk. -->
  <div class="mt-2.5 rounded-[10px] border border-bord bg-surface p-3" id="talk" hidden>
    <div class="text-[11px] tracking-[.1em] text-attenue uppercase" id="talk-quand">En ce moment</div>
    <div class="mt-1 text-[15px] leading-snug font-semibold" id="talk-titre"></div>
    <div class="mt-0.5 text-[13px] text-attenue" id="talk-qui"></div>
  </div>
</header>

<div class="onglets my-3.5 flex gap-1.5">
  <button id="onglet-mur" class="actif">Mur</button>
  <button id="onglet-questions">Questions</button>
</div>

<section id="vue-mur">
  <!--
    Ce que devient le message, dit avant de l'écrire.

    C'est la promesse de la page : on n'écrit pas dans une boîte à idées, on
    écrit sur les écrans de l'événement. Le dire après le formulaire — ce que
    faisait la version précédente, en petit et en gris — revenait à ne pas le
    dire : personne ne lit sous un bouton qu'il vient d'appuyer.
  -->
  <div class="mb-3.5 rounded-[12px] border border-marque/40 bg-[color-mix(in_srgb,var(--color-marque)_12%,transparent)] p-3.5">
    <div class="text-[15px] leading-snug font-semibold">
      Votre message s'affiche <span class="text-marque">dans toutes les salles</span>
    </div>
    <div class="mt-1 text-[13px] leading-relaxed text-attenue" id="portee">
      Projeté sur les écrans de l'événement, après relecture.
    </div>
  </div>

  <form class="carte" id="form-message">
    <label for="auteur">Votre prénom</label>
    <input class="mb-3.5 rounded-[10px] p-[13px]" id="auteur" maxlength="80" autocomplete="given-name" required>
    <label for="message">Votre message</label>
    <textarea class="mb-3.5 w-full rounded-[10px] border border-bord bg-fond p-[13px] text-texte" id="message" maxlength="500" required></textarea>
    <div class="-mt-2.5 mb-3 text-right text-xs text-attenue"><span id="compteur-message">0</span>/500</div>
    <button class="envoyer" type="submit">Envoyer à l'événement</button>
  </form>

  <!--
    Ce qui est déjà à l'écran.

    Sans ça, déposer un message revenait à parler dans le vide : rien ne
    montrait que d'autres écrivaient, ni que ça finissait réellement projeté.
    C'est ce qui fait la différence entre un formulaire de contact et un mur.
  -->
  <div class="mt-5 flex items-baseline gap-2">
    <h2 class="text-[13px] font-semibold tracking-[.1em] text-attenue uppercase">En ce moment sur les écrans</h2>
  </div>
  <div class="mt-2.5 flex flex-col gap-2.5" id="liste-mur"></div>
</section>

<section id="vue-questions" hidden>
  <!-- La salle ne sert qu'ici : une question s'adresse à un speaker précis,
       dans une pièce précise, alors qu'un message du mur s'adresse à tous. -->
  <label class="mb-1" for="choix-salle">Dans quelle salle êtes-vous ?</label>
  <select class="mb-3.5 rounded-[10px] p-[11px]" id="choix-salle"></select>

  <form class="carte" id="form-question">
    <label for="question">Votre question au speaker</label>
    <textarea class="mb-3.5 w-full rounded-[10px] border border-bord bg-fond p-[13px] text-texte" id="question" maxlength="300" required></textarea>
    <div class="-mt-2.5 mb-3 text-right text-xs text-attenue"><span id="compteur-question">0</span>/300</div>
    <button class="envoyer" type="submit">Poser la question</button>
  </form>
  <div class="mt-4 flex flex-col gap-2.5" id="liste-questions"></div>
</section>

<div class="avis" id="avis"></div>

<script id="donnees" type="application/json">${donnees}</script>
<script>
(() => {
  const { roomId, rooms } = JSON.parse(document.getElementById('donnees').textContent)
  const $ = (id) => document.getElementById(id)

  /**
   * Identifiant d'appareil : borne les votes sans imposer de compte.
   * Demander une inscription pour voter une question garantirait que personne
   * ne vote.
   */
  let deviceId = localStorage.getItem('mur-device')
  if (!deviceId || deviceId.length < 8) {
    deviceId = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    localStorage.setItem('mur-device', deviceId)
  }
  const votes = new Set(JSON.parse(localStorage.getItem('mur-votes') || '[]'))

  /**
   * Salle courante.
   *
   * Trois sources, dans cet ordre : le lien scanné, le dernier choix de ce
   * téléphone, puis rien. Le choix est mémorisé parce qu'un participant reste
   * dans la même salle plusieurs talks d'affilée, et rescanner à chaque fois
   * pour poser une question n'arriverait jamais.
   */
  let salleCourante = roomId || localStorage.getItem('mur-salle') || ''
  if (!rooms.some((r) => r.id === salleCourante)) salleCourante = ''

  const choix = $('choix-salle')
  choix.innerHTML = '<option value="">Choisissez votre salle…</option>' +
    rooms.map((r) => '<option value="' + r.id + '">' + r.name + '</option>').join('')
  choix.value = salleCourante

  function majSalle(valeur) {
    salleCourante = valeur
    choix.value = valeur
    const salle = rooms.find((r) => r.id === valeur)
    // La salle ne qualifie plus que les questions : le mur est commun à
    // l'événement, et laisser un nom de salle en tête de page laissait croire
    // qu'on écrivait à cette salle-là.
    $('salle').textContent = salle
      ? 'Questions — ' + salle.name
      : 'Mur commun à toutes les salles'
    if (valeur) localStorage.setItem('mur-salle', valeur)
    // L'adresse suit, pour que la page partagée ou rechargée reste la bonne.
    const url = new URL(location.href)
    if (valeur) url.searchParams.set('salle', valeur)
    else url.searchParams.delete('salle')
    history.replaceState(null, '', url)
    void rafraichirTalk()
    if (!$('vue-questions').hidden) void rafraichirQuestions()
  }

  choix.onchange = (evenement) => majSalle(evenement.target.value)

  /**
   * Conférence à laquelle se rattachent les questions.
   *
   * Celle en cours, ou à défaut la suivante : une question posée pendant la
   * pause qui précède un talk le vise, et la rattacher à rien la rendrait
   * invisible de tous — de la régie comme des autres participants.
   */
  let sessionCourante = null
  /** Son titre, pour dire de quoi la liste parle. */
  let titreCourant = null

  /** Conférence en cours dans la salle choisie, relue régulièrement. */
  async function rafraichirTalk() {
    const bloc = $('talk')
    if (!salleCourante) { bloc.hidden = true; return }
    try {
      const { current, next } = await appeler('rooms/current', { roomId: salleCourante })
      const session = current || next
      const avant = sessionCourante
      sessionCourante = session ? session.id : null
      titreCourant = session ? session.title : null
      if (!session) { bloc.hidden = true; return }
      bloc.hidden = false
      $('talk-quand').textContent = current ? 'En ce moment' : 'À suivre'
      $('talk-titre').textContent = session.title
      $('talk-qui').textContent = session.speakers.join(' · ')
      // La journée avance pendant que le téléphone reste posé sur la table :
      // au changement de talk, la liste affichée doit suivre sans attendre son
      // tour de rafraîchissement.
      if (avant !== sessionCourante && !$('vue-questions').hidden) void rafraichirQuestions()
    } catch {
      // Le mur reste utilisable sans : ce bloc informe, il ne commande rien.
      bloc.hidden = true
    }
  }

  /** Portée du mur, dite avec le nombre réel de salles plutôt qu'en principe. */
  $('portee').textContent = rooms.length > 1
    ? 'Projeté sur les écrans des ' + rooms.length + ' salles, après relecture.'
    : "Projeté sur les écrans de l'événement, après relecture."

  majSalle(salleCourante)
  void rafraichirMur()
  // La journée avance pendant que la page reste ouverte sur un téléphone posé
  // sur une table : sans relecture, elle annoncerait le talk d'il y a une heure.
  setInterval(() => void rafraichirTalk(), 60_000)

  /** Le protocole oRPC en HTTP tient en un objet { json: ... } : pas besoin de client. */
  async function appeler(chemin, entree) {
    const reponse = await fetch('/rpc/' + chemin, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: entree }),
    })
    const corps = await reponse.json()
    if (!reponse.ok) throw new Error(corps?.json?.message || 'Échec de la requête')
    return corps.json
  }

  function avis(message, erreur) {
    const el = $('avis')
    el.textContent = message
    el.className = 'avis visible ' + (erreur ? 'ko' : 'ok')
    clearTimeout(el.__t)
    el.__t = setTimeout(() => el.classList.remove('visible'), 4000)
  }

  const compteur = (champ, cible) => {
    $(champ).addEventListener('input', () => { $(cible).textContent = $(champ).value.length })
  }
  compteur('message', 'compteur-message')
  compteur('question', 'compteur-question')

  $('onglet-mur').onclick = () => { basculer(true); rafraichirMur() }
  $('onglet-questions').onclick = () => { basculer(false); rafraichirQuestions() }
  function basculer(mur) {
    $('vue-mur').hidden = !mur
    $('vue-questions').hidden = mur
    $('onglet-mur').classList.toggle('actif', mur)
    $('onglet-questions').classList.toggle('actif', !mur)
  }

  /**
   * Ce qui est déjà projeté, relu régulièrement.
   *
   * C'est la moitié sociale du mur : sans elle, déposer un message revenait à
   * parler dans le vide. Elle montre aussi, sans rien expliquer, ce qui passe
   * la relecture et ce qui n'y passe pas.
   */
  async function rafraichirMur() {
    const conteneur = $('liste-mur')
    try {
      const liste = await appeler('wall/recent', { limit: 12 })
      conteneur.innerHTML = ''
      if (liste.length === 0) {
        const vide = document.createElement('div')
        vide.className = 'rounded-[10px] border border-dashed border-bord p-4 text-center text-sm text-attenue'
        vide.textContent = 'Rien encore. Le premier message de la journée peut être le vôtre.'
        conteneur.appendChild(vide)
        return
      }
      for (const message of liste) {
        const carte = document.createElement('div')
        carte.className = 'rounded-[10px] border border-bord bg-surface p-3'
        const auteur = document.createElement('div')
        auteur.className = 'mb-1 text-xs text-attenue'
        // Le handle quand la source en a un : c'est ce qui distingue un post
        // repris des réseaux d'un message déposé ici.
        auteur.textContent = message.authorHandle
          ? message.author + ' · ' + message.authorHandle
          : message.author
        const texte = document.createElement('div')
        texte.className = 'text-[15px] leading-snug'
        texte.textContent = message.text
        carte.append(auteur, texte)
        conteneur.appendChild(carte)
      }
    } catch {
      // Silencieux : le mur reste utilisable sans, et un participant n'a rien
      // à faire d'une erreur de rafraîchissement.
    }
  }

  $('form-message').onsubmit = async (evenement) => {
    evenement.preventDefault()
    const bouton = evenement.target.querySelector('button')
    bouton.disabled = true
    try {
      await appeler('wall/post', {
        // Toujours nul : un message du public s'adresse à l'événement, pas à la
        // pièce où son auteur se trouve. Côté hub, une salle nulle vaut
        // « toutes les salles » — c'est déjà ce que faisait un message social.
        roomId: null,
        author: $('auteur').value.trim(),
        text: $('message').value.trim(),
      })
      $('message').value = ''
      $('compteur-message').textContent = '0'
      avis('Envoyé — il apparaîtra sur les écrans après relecture.')
    } catch (cause) {
      avis(cause.message, true)
    } finally {
      bouton.disabled = false
    }
  }

  $('form-question').onsubmit = async (evenement) => {
    evenement.preventDefault()
    if (!salleCourante) { avis('Choisissez votre salle pour poser une question.', true); return }
    const bouton = evenement.target.querySelector('button')
    bouton.disabled = true
    try {
      await appeler('questions/post', {
        roomId: salleCourante,
        // Rattachée au talk en cours : en régie, une question sans conférence
        // ne dit pas à quoi elle répond.
        sessionId: sessionCourante,
        author: $('auteur').value.trim() || null,
        text: $('question').value.trim(),
      })
      $('question').value = ''
      $('compteur-question').textContent = '0'
      avis('Question envoyée.')
      await rafraichirQuestions()
    } catch (cause) {
      avis(cause.message, true)
    } finally {
      bouton.disabled = false
    }
  }

  async function voter(id, bouton) {
    if (votes.has(id)) return
    try {
      const resultat = await appeler('questions/vote', { id, deviceId })
      votes.add(id)
      localStorage.setItem('mur-votes', JSON.stringify([...votes]))
      bouton.querySelector('.n').textContent = resultat.votes
      bouton.classList.add('vote')
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  async function rafraichirQuestions() {
    if (!salleCourante) return
    const conteneur = $('liste-questions')
    /**
     * Les questions de **cette** conférence, jamais celles de la journée.
     *
     * À 16 h, la liste remontait encore les questions du talk de 10 h — les
     * mieux votées, donc en tête — et le public votait pour des questions que
     * plus personne ne poserait. Une question ne survit pas à son talk.
     */
    // Titre du talk posé en textContent et non concaténé dans du HTML : il
    // vient de l'export amont, et le reste de cette page compose déjà en nœuds
    // pour cette raison.
    const vide = (texte) => {
      conteneur.innerHTML = ''
      const bloc = document.createElement('div')
      bloc.className = 'py-[26px] text-center text-sm text-attenue'
      bloc.textContent = texte
      conteneur.appendChild(bloc)
    }

    if (!sessionCourante) {
      vide('Aucune conférence annoncée dans cette salle pour le moment.')
      return
    }
    try {
      const liste = await appeler('questions/list', { roomId: salleCourante, sessionId: sessionCourante })
      if (liste.length === 0) {
        vide(titreCourant
          ? 'Aucune question sur \\u00ab\\u00a0' + titreCourant + '\\u00a0\\u00bb pour l\\'instant.'
          : 'Aucune question pour l\\'instant.')
        return
      }
      conteneur.innerHTML = ''
      for (const question of liste) {
        const carte = document.createElement('div')
        carte.className = 'question'
        const bouton = document.createElement('button')
        bouton.className = 'voter' + (votes.has(question.id) ? ' vote' : '')
        bouton.innerHTML = '<span class="text-[17px] font-bold">' + question.votes + '</span><span class="text-[10px] tracking-[.08em] uppercase">vote</span>'
        bouton.onclick = () => voter(question.id, bouton)
        const texte = document.createElement('div')
        texte.className = 'texte'
        texte.textContent = question.text
        if (question.author) {
          const auteur = document.createElement('div')
          auteur.className = 'auteur'
          auteur.textContent = question.author
          texte.appendChild(auteur)
        }
        carte.append(bouton, texte)
        conteneur.appendChild(carte)
      }
    } catch {
      // Silencieux : un rafraîchissement raté ne doit pas alarmer un participant.
    }
  }

  setInterval(() => { if (!$('vue-questions').hidden) rafraichirQuestions() }, 15_000)
  // Le mur vit pendant qu'on le regarde : un téléphone posé sur une table doit
  // voir arriver les messages des autres, sinon la page a l'air morte.
  setInterval(() => { if (!$('vue-mur').hidden) rafraichirMur() }, 15_000)
})()
</script>
</body>
</html>`
}
