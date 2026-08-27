import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DisplayPayload } from '@cloudnord/contract'
import { escapeHtml } from '@cloudnord/format'

/**
 * Coquille de la régie.
 *
 * Le poste sert un bundle, mais il rend toujours la page qui le charge, et pour
 * une raison plus forte qu'à la console : **l'état complet part dans la page**.
 * Un rechargement de la régie arrive presque toujours au pire moment — la
 * fenêtre a gelé, l'opérateur fait F5 pendant le talk. Attendre le premier
 * message du flux pour peindre quoi que ce soit donnerait une demi-seconde
 * d'écran vide à cet instant-là.
 *
 * L'invariant d'autonomie tient sous la forme qu'il a prise à la console :
 * **aucune ressource hors de l'origine servie**. Il pèse plus lourd ici — la
 * machine de salle tourne parfois sans réseau du tout, et tout ce qu'elle
 * affiche vient de son propre `127.0.0.1`.
 */
export interface RegieShellOptions {
  /** État complet de la salle, embarqué pour éviter l'écran vide au F5. */
  initialPayload: DisplayPayload
  assets: RegieAssets
  /** Nom de l'événement, pour titrer la fenêtre. */
  eventName?: string | null
}

export interface RegieAssets {
  scripts: string[]
  styles: string[]
}

/**
 * Dossier du bundle, cherché plutôt que compté.
 *
 * Même raison que pour la console du hub et les migrations du client : ce
 * fichier est lu à des profondeurs différentes selon qu'on tourne depuis les
 * sources, depuis le bundle esbuild, ou depuis un paquet Electron — et un
 * nombre de `..` juste pour l'un est faux pour les autres.
 */
export function resoudreRegie(): { dossier: string; manifeste: string } | null {
  return resoudreRegieDepuis(dirname(fileURLToPath(import.meta.url)))
}

/**
 * La remontée elle-même, séparée pour être éprouvée.
 *
 * Le chemin qu'elle finit par trouver sur un poste installé est écrit ailleurs :
 * dans `extraResources` de `electron-builder.yml`. Deux fichiers doivent
 * s'accorder, et leur désaccord ne se verrait qu'au montage d'une salle — la
 * régie répondrait 503 sur une machine où tout le reste marche. Un test noue
 * les deux.
 */
export function resoudreRegieDepuis(depart: string): { dossier: string; manifeste: string } | null {
  let dossier = depart
  for (;;) {
    const candidat = join(dossier, 'apps', 'regie-web', 'dist')
    const manifeste = join(candidat, '.vite', 'manifest.json')
    if (existsSync(manifeste)) return { dossier: candidat, manifeste }
    const parent = dirname(dossier)
    if (parent === dossier) return null
    dossier = parent
  }
}

interface EntreeManifeste {
  file: string
  css?: string[]
}

/**
 * Assets de production, lus dans le manifeste.
 *
 * Lire les noms plutôt que les deviner : ils portent une empreinte, ce qui
 * permet de les servir en `immutable` — sur un poste de salle, la régie est
 * rouverte plusieurs fois par jour.
 */
export function assetsDeProduction(manifeste: string, base = '/regie/'): RegieAssets {
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

/**
 * Assets de développement : le serveur Vite, derrière le poste de salle.
 *
 * Le sens du proxy est imposé, comme au hub : c'est le poste qui porte le flux
 * d'état, les actions de régie et le vumètre, tous sur son origine. Mettre Vite
 * devant demanderait de proxifier un flux SSE et un WebSocket OBS pour le seul
 * confort du rechargement à chaud.
 */
export function assetsDeDeveloppement(base = '/regie/'): RegieAssets {
  return { scripts: [`${base}@vite/client`, `${base}src/main.ts`], styles: [] }
}

export function renderRegieShell(options: RegieShellOptions): string {
  const titre = options.eventName == null ? 'Régie de salle' : `Régie — ${options.eventName}`
  const etat = JSON.stringify(options.initialPayload).replace(/</g, '\\u003c')

  const styles = options.assets.styles
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('\n')
  const scripts = options.assets.scripts
    .map((src) => `<script type="module" src="${escapeHtml(src)}"></script>`)
    .join('\n')

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(titre)}</title>
${styles}
</head>
<body>
<div id="regie-root"></div>
<script id="etat-initial" type="application/json">${etat}</script>
${scripts}
</body>
</html>
`
}
