import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IDENTITE_PAR_DEFAUT, type EventIdentity, type ModeExecution } from '@cloudnord/contract'
import { escapeHtml } from '@cloudnord/format'

/**
 * Coquille de la console.
 *
 * Le hub sert un bundle, mais il rend toujours la page qui le charge — et c'est
 * délibéré. Trois choses doivent être connues de la console **avant** son
 * premier appel réseau, exactement comme du temps du gabarit : le nom de
 * l'événement, qui est le premier mot lu ; le mode, dont dépend l'existence même
 * de la vue de développement ; et si le bouton Google a une raison d'être.
 *
 * Ce qui change, c'est ce que la coquille contient : des balises vers des
 * fichiers hachés, servis par ce même hub. L'invariant d'autonomie n'est pas
 * abandonné, il est reformulé — **aucune ressource hors de l'origine**. Une
 * balise vers un CDN casserait la page à la première coupure ; un asset servi
 * par le processus qui sert déjà la page ne le peut pas.
 */
export interface ConsoleShellOptions {
  mode?: ModeExecution
  event?: EventIdentity
  google?: { domaine: string } | null
  /** Assets à charger. Résolus par `resoudreConsole()`, ou pointés sur Vite en dev. */
  assets: ConsoleAssets
}

export interface ConsoleAssets {
  /** Modules à charger, dans l'ordre. */
  scripts: string[]
  /** Feuilles à poser avant le premier rendu, pour éviter le flash. */
  styles: string[]
}

/**
 * Dossier du bundle, cherché plutôt que compté.
 *
 * Même raison que pour les migrations du client de salle (`store.ts`) : ce
 * fichier est lu à des profondeurs différentes selon qu'on tourne depuis les
 * sources ou depuis une image, et un nombre de `..` juste pour l'un est faux
 * pour l'autre. Le défaut se découvre au déploiement, sur un 404 qui ne nomme
 * rien.
 */
export function resoudreConsole(): { dossier: string; manifeste: string } | null {
  const visites: string[] = []
  let dossier = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidat = join(dossier, 'apps', 'hub-admin', 'dist')
    visites.push(candidat)
    const manifeste = join(candidat, '.vite', 'manifest.json')
    if (existsSync(manifeste)) return { dossier: candidat, manifeste }
    const parent = dirname(dossier)
    if (parent === dossier) break
    dossier = parent
  }
  return null
}

/** Ce que le manifeste de Vite dit de l'entrée. */
interface EntreeManifeste {
  file: string
  css?: string[]
}

/**
 * Assets de production, lus dans le manifeste.
 *
 * Lire le manifeste plutôt que deviner les noms : ils portent une empreinte,
 * c'est ce qui permet de les servir en `immutable` et de ne plus retélécharger
 * 45 Ko de CSS à chaque navigation.
 */
export function assetsDeProduction(manifeste: string, base = '/admin/'): ConsoleAssets {
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
 * Assets de développement : le serveur Vite, derrière le hub.
 *
 * Le sens du proxy est imposé, et pas par commodité. Le hub porte les cookies
 * de Better Auth, `/rpc`, le WebSocket des salles, et surtout `/sw.js` — dont
 * la **portée dépend du chemin depuis lequel il est servi**. Mettre Vite devant
 * casserait la portée du service worker et l'origine des cookies.
 */
export function assetsDeDeveloppement(base = '/admin/'): ConsoleAssets {
  return { scripts: [`${base}@vite/client`, `${base}src/main.ts`], styles: [] }
}

export function renderConsoleShell(options: ConsoleShellOptions): string {
  const identite = options.event ?? IDENTITE_PAR_DEFAUT
  const nom = escapeHtml(identite.name)
  const amorce = JSON.stringify({
    mode: options.mode ?? 'production',
    event: identite,
    google: options.google == null ? null : { domain: options.google.domaine },
  }).replace(/</g, '\\u003c')

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
<title>${nom} — console hub</title>
${styles}
</head>
<body class="bg-fond font-sans text-texte">
<div id="console-root"></div>
<script id="console-boot" type="application/json">${amorce}</script>
${scripts}
</body>
</html>
`
}
