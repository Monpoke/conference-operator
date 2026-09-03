import { TAILWIND_CSS } from '@cloudnord/ui'

/**
 * Fenêtre de saisie de l'adresse du hub, au tout premier lancement.
 *
 * Elle précède tout le reste : le hub est ce qui donne la liste des salles,
 * donc le code d'appairage, donc le programme. Tant qu'on ne sait pas à qui
 * parler, il n'y a rien à afficher.
 *
 * La sonde de joignabilité **n'allowed rien** : elle informe. « Le hub peut
 * être lancé après les salles » est une propriété du produit, pas une
 * tolérance — un poste de régie doit pouvoir démarrer la veille, hub éteint,
 * et rejoindre tout seul le lendemain. Bloquer « Continuer » sur une réponse
 * HTTP transformerait cette propriété en panne un matin d'événement.
 */
export interface AdresseHubPageOptions {
  /** Pré-remplissage du champ : dernière adresse connue, ou défaut de développement. */
  valeurInitiale: string
}

export function renderAdresseHubPage({ valeurInitiale }: AdresseHubPageOptions): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Adresse du hub</title>
<style>${TAILWIND_CSS}</style>
<style>html, body { height: 100%; } body { overflow: hidden; }</style>
</head>
<body class="flex h-screen items-center justify-center bg-fond p-8 font-sans text-texte">

<form class="w-full max-w-[520px] rounded-2xl border border-bord bg-surface px-10 py-9" id="formulaire">
  <h1 class="mb-1.5 text-[20px] font-semibold">Régie de salle</h1>
  <p class="mb-6 text-sm leading-relaxed text-attenue">
    Adresse du hub auquel ce poste se connecte. Celle du dernier lancement est
    proposée&nbsp;: valider repart sur le même hub.
  </p>

  <label for="adresse">Adresse du hub</label>
  <input class="w-full min-w-0 rounded-lg border border-bord bg-fond px-3 py-2.5 text-sm text-texte focus:border-marque focus:outline-none"
         id="adresse" type="text" spellcheck="false" autocomplete="off"
         placeholder="http://192.168.1.10:8787" value="${echapperAttribut(valeurInitiale)}">

  <div class="mt-2.5 min-h-5 text-[13px] text-attenue" id="etat"></div>
  <div class="min-h-5 text-[13px] text-alerte" id="erreur"></div>

  <div class="mt-5 flex items-end justify-between gap-5">
    <span class="text-[12px] leading-snug text-attenue">
      Le hub peut être lancé après les salles&nbsp;: continuer sans réponse ne bloque rien.
    </span>
    <button class="cursor-pointer rounded-lg border border-marque bg-marque px-6 py-3.5 text-sm font-semibold text-[#05070d]"
            type="submit">Continuer</button>
  </div>
</form>

<script>
  const champ = document.getElementById('adresse')
  const etat = document.getElementById('etat')
  const erreur = document.getElementById('erreur')

  /*
   * Numéro de sonde.
   *
   * Une frappe rapide en lance plusieurs : sans ce compteur, la réponse d'une
   * adresse à moitié tapée écrasait celle de l'adresse complète, et le champ
   * affichait « pas de réponse » sur un hub parfaitement joignable.
   */
  let sonde = 0
  let minuteur = null

  function afficher(couleur, texte) {
    etat.className = 'mt-2.5 min-h-5 text-[13px] ' + couleur
    etat.textContent = texte
  }

  async function tester() {
    const valeur = champ.value.trim()
    const numero = ++sonde
    if (valeur === '') return afficher('text-attenue', '')
    afficher('text-attenue', 'vérification…')
    const joignable = await window.hub.tester(valeur)
    if (numero !== sonde) return
    afficher(
      joignable ? 'text-ok' : 'text-attention',
      joignable ? '✓ hub joignable' : '✗ pas de réponse — on peut continuer quand même',
    )
  }

  champ.addEventListener('input', () => {
    erreur.textContent = ''
    clearTimeout(minuteur)
    minuteur = setTimeout(tester, 400)
  })

  document.getElementById('formulaire').addEventListener('submit', async (evenement) => {
    evenement.preventDefault()
    const reponse = await window.hub.valider(champ.value)
    if (!reponse.ok) erreur.textContent = reponse.message
  })

  champ.focus()
  champ.select()
  void tester()
</script>

</body>
</html>`
}

function echapperAttribut(valeur: string): string {
  return valeur
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
