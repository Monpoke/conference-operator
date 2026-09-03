import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_EVENT_IDENTITY, type EventIdentity } from '@cloudnord/contract'
import { escapeHtml } from '@cloudnord/format'

/**
 * Coquille de la régie mobile.
 *
 * Le même bundle que sert une machine de salle, servi cette fois par le hub —
 * d'où un second rendu de coquille plutôt qu'un partage avec
 * `room-client/src/core/regie-shell.ts` : les deux applications ne peuvent pas
 * dépendre l'une de l'autre, et ce qu'elles embarquent diffère justement là où
 * ça compte.
 *
 * **Aucun état de salle ici.** Le poste de salle inline son `DisplayPayload`
 * entier parce qu'un F5 en régie arrive en plein talk et que la fenêtre pilote
 * le vidéoprojecteur. Un téléphone qui ne pilote rien tant que personne n'a pris
 * la salle n'a pas cet argument : il se connecte, choisit une salle, et la vue
 * arrive au premier sondage. Embarquer un état exigerait ici de résoudre
 * l'opérateur avant de rendre la page, pour économiser une seconde à celui qui
 * vient de se connecter.
 *
 * L'invariant tient comme ailleurs : **aucune ressource hors de l'origine**.
 */
export interface RegieShellOptions {
  event?: EventIdentity
  /** La salle pilotée, ou `null` pour l'écran de choix. */
  roomId?: string | null
  /**
   * Les salles, nom compris, posées avant tout appel réseau.
   *
   * Ces noms sont déjà publics — le mur scanné par les participants les affiche
   * —, et les poser ici permet à l'écran de choix de s'afficher avant même la
   * connexion. Sans eux, un opérateur qui se connecte voit une liste vide le
   * temps d'un aller-retour, ce qui se lit comme un hub sans programme.
   */
  salles?: { id: string; name: string }[]
  /**
   * Google est-il configuré ?
   *
   * Sur un téléphone, taper une adresse et un mot de passe au fond d'une salle
   * est exactement la friction qu'on retire. Le bouton n'apparaît que si le hub
   * sait le servir — proposer une connexion qui échoue coûte plus qu'un
   * formulaire.
   */
  google?: { domaine: string } | null
  assets: RegieAssets
}

export interface RegieAssets {
  scripts: string[]
  styles: string[]
}

/**
 * Dossier du bundle, cherché plutôt que compté.
 *
 * Même raison que `resoudreConsole()` : ce fichier est lu à des profondeurs
 * différentes selon qu'on tourne depuis les sources ou depuis une image, et un
 * nombre de `..` juste pour l'un est faux pour l'autre.
 */
export function resoudreRegie(): { dossier: string; manifeste: string } | null {
  let dossier = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidat = join(dossier, 'apps', 'regie-web', 'dist')
    const manifeste = join(candidat, '.vite', 'manifest.json')
    if (existsSync(manifeste)) return { dossier: candidat, manifeste }
    const parent = dirname(dossier)
    if (parent === dossier) break
    dossier = parent
  }
  return null
}

interface EntreeManifeste {
  file: string
  css?: string[]
}

/** Assets de production, lus dans le manifeste : les noms portent une empreinte. */
export function assetsDeProductionRegie(manifeste: string, base = '/regie/'): RegieAssets {
  const contenu = JSON.parse(readFileSync(manifeste, 'utf8')) as Record<string, EntreeManifeste>
  const entree = contenu['index.html']
  if (entree == null) {
    throw new Error(`Manifeste sans entrée « index.html » : ${manifeste}`)
  }
  return {
    scripts: [base + entree.file],
    styles: (entree.css ?? []).map((chemin) => base + chemin),
  }
}

/** Assets de développement : le serveur Vite, derrière le hub. */
export function assetsDeDeveloppementRegie(base = '/regie/'): RegieAssets {
  return { scripts: [`${base}@vite/client`, `${base}src/main.ts`], styles: [] }
}

/**
 * Amorce de la portée, lue par le bundle avant son montage.
 *
 * Un second script d'amorce plutôt qu'un champ de plus dans `#etat-initial` :
 * les deux hôtes n'en servent pas le même contenu, et fusionner les deux
 * obligerait le poste de salle à fabriquer une portée qu'il n'a jamais eu à
 * dire. Son absence vaut « locale », ce qui est aussi le cas de `vite dev`
 * servant `index.html` tel quel.
 */
export const PORTEE_ELEMENT_ID = 'regie-portee'

export function renderRegieMobileShell(options: RegieShellOptions): string {
  const identite = options.event ?? DEFAULT_EVENT_IDENTITY
  const titre = `Régie mobile — ${identite.shortName}`
  const amorce = JSON.stringify({
    portee: 'distante',
    roomId: options.roomId ?? null,
    salles: options.salles ?? [],
    google: options.google == null ? null : { domain: options.google.domaine },
  }).replace(/</g, '\\u003c')

  const styles = options.assets.styles
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('\n')
  const scripts = options.assets.scripts
    .map((src) => `<script type="module" src="${escapeHtml(src)}"></script>`)
    .join('\n')

  /*
   * `viewport-fit=cover` et `user-scalable=no` : c'est un pupitre, pas un
   * document. Un double-tap qui zoome au moment où l'on vise « Terminer »
   * transforme un geste en accident, et la mise à l'échelle n'apporte rien sur
   * une page dont tout le contenu est déjà dimensionné pour le pouce.
   */
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(titre)}</title>
${styles}
</head>
<body>
<div id="regie-root"></div>
<script id="${PORTEE_ELEMENT_ID}" type="application/json">${amorce}</script>
${scripts}
</body>
</html>
`
}
