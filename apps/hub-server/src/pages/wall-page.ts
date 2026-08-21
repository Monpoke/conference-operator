import { TAILWIND_CSS } from '@cloudnord/ui'

export interface WallPageOptions {
  roomId: string | null
  rooms: { id: string; name: string }[]
}

/**
 * Mur public, scanné au QR code depuis un mobile.
 *
 * Contraintes qui expliquent la forme : elle s'ouvre sur la 4G d'une salle de
 * conférence, sur des téléphones quelconques, en une poignée de secondes. D'où
 * du HTML autonome, aucune dépendance externe, et des appels au contrat via un
 * `fetch` minimal — le protocole oRPC en HTTP est un simple `{ json: … }`.
 */
export function renderWallPage({ roomId, rooms }: WallPageOptions): string {
  const donnees = JSON.stringify({ roomId, rooms }).replace(/</g, '\\u003c')

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#10121a">
<title>Cloud Nord — mur & questions</title>
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
  <h1 class="text-[21px] font-bold">Cloud Nord 2026</h1>
  <div class="mt-1 text-sm text-attenue" id="salle"></div>
</header>

<div class="onglets my-3.5 flex gap-1.5">
  <button id="onglet-mur" class="actif">Mur</button>
  <button id="onglet-questions">Questions</button>
</div>

<section id="vue-mur">
  <form class="carte" id="form-message">
    <label for="auteur">Votre prénom</label>
    <input class="mb-3.5 rounded-[10px] p-[13px]" id="auteur" maxlength="80" autocomplete="given-name" required>
    <label for="message">Votre message</label>
    <textarea class="mb-3.5 w-full rounded-[10px] border border-bord bg-fond p-[13px] text-texte" id="message" maxlength="500" required></textarea>
    <div class="-mt-2.5 mb-3 text-right text-xs text-attenue"><span id="compteur-message">0</span>/500</div>
    <button class="envoyer" type="submit">Envoyer</button>
  </form>
  <div class="mt-3.5 text-[13px] leading-relaxed text-attenue">
    Les messages sont relus avant d'apparaître sur l'écran de la salle.
  </div>
</section>

<section id="vue-questions" hidden>
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
  let deviceId = localStorage.getItem('cloudnord-device')
  if (!deviceId || deviceId.length < 8) {
    deviceId = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    localStorage.setItem('cloudnord-device', deviceId)
  }
  const votes = new Set(JSON.parse(localStorage.getItem('cloudnord-votes') || '[]'))

  const salle = rooms.find((r) => r.id === roomId)
  $('salle').textContent = salle ? salle.name : 'Toutes salles'

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

  $('onglet-mur').onclick = () => basculer(true)
  $('onglet-questions').onclick = () => { basculer(false); rafraichirQuestions() }
  function basculer(mur) {
    $('vue-mur').hidden = !mur
    $('vue-questions').hidden = mur
    $('onglet-mur').classList.toggle('actif', mur)
    $('onglet-questions').classList.toggle('actif', !mur)
  }

  $('form-message').onsubmit = async (evenement) => {
    evenement.preventDefault()
    const bouton = evenement.target.querySelector('button')
    bouton.disabled = true
    try {
      await appeler('wall/post', {
        roomId,
        author: $('auteur').value.trim(),
        text: $('message').value.trim(),
      })
      $('message').value = ''
      $('compteur-message').textContent = '0'
      avis('Message envoyé — il apparaîtra après relecture.')
    } catch (cause) {
      avis(cause.message, true)
    } finally {
      bouton.disabled = false
    }
  }

  $('form-question').onsubmit = async (evenement) => {
    evenement.preventDefault()
    if (!roomId) { avis('Ouvrez le lien de votre salle pour poser une question.', true); return }
    const bouton = evenement.target.querySelector('button')
    bouton.disabled = true
    try {
      await appeler('questions/post', {
        roomId,
        sessionId: null,
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
      localStorage.setItem('cloudnord-votes', JSON.stringify([...votes]))
      bouton.querySelector('.n').textContent = resultat.votes
      bouton.classList.add('vote')
    } catch (cause) {
      avis(cause.message, true)
    }
  }

  async function rafraichirQuestions() {
    if (!roomId) return
    try {
      const liste = await appeler('questions/list', { roomId, sessionId: null })
      const conteneur = $('liste-questions')
      if (liste.length === 0) {
        conteneur.innerHTML = '<div class="py-[26px] text-center text-sm text-attenue">Aucune question pour l\\'instant.</div>'
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
})()
</script>
</body>
</html>`
}
