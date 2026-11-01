import { escapeHtml } from '@conference-operator/format'

/** A shared page: no script, no outside resource but the videos themselves. */
export function partageContentSecurityPolicy(videoOrigin: string | null): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    ...(videoOrigin == null ? [] : [`media-src ${videoOrigin}`]),
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

const STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b0e14; color: #e8ebf2; font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 32px 20px 56px; }
  h1 { margin: 0 0 4px; font-size: clamp(24px, 4vw, 34px); line-height: 1.2; }
  h2 { margin: 0; font-size: 19px; line-height: 1.3; }
  .dim { margin: 0; color: #a3abbd; font-size: 14px; }
  form { display: flex; flex-direction: column; gap: 10px; max-width: 360px; margin-top: 24px; }
  label { font-size: 14px; color: #a3abbd; }
  input { padding: 11px 12px; border: 1px solid #39415a; border-radius: 8px; background: #151a26; color: inherit; font: inherit; }
  button, .bouton { display: inline-block; width: fit-content; padding: 9px 16px; border: 1px solid #39415a; border-radius: 8px; background: #1e2534; color: inherit; font: 600 14px/1.4 system-ui, sans-serif; text-decoration: none; cursor: pointer; }
  button:hover, .bouton:hover { background: #2a3347; }
  :focus-visible { outline: 3px solid #7f9cff; outline-offset: 2px; }
  .erreur { margin: 0; color: #ff8a9a; font-size: 14px; }
  article { margin-top: 32px; }
  video { display: block; width: 100%; aspect-ratio: 16 / 9; margin: 12px 0 10px; border-radius: 10px; background: #000; }
`

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`
}

export function renderPartageLogin(options: { title: string; erreur: string | null }): string {
  return layout(options.title, `
<h1>${escapeHtml(options.title)}</h1>
<p class="dim">Cette page est protégée par un mot de passe.</p>
<form method="post">
  <label for="mot-de-passe">Mot de passe</label>
  <input id="mot-de-passe" name="motDePasse" type="password" autocomplete="current-password" required autofocus>
  ${options.erreur == null ? '' : `<p class="erreur" role="alert">${escapeHtml(options.erreur)}</p>`}
  <button type="submit">Voir les vidéos</button>
</form>`)
}

export interface PartageVideoLine {
  jobId: string
  title: string
  detail: string
}

export function renderPartagePage(options: { id: string; title: string; videos: readonly PartageVideoLine[] }): string {
  const base = `/partage/${encodeURIComponent(options.id)}/video`
  const videos = options.videos.map((video) => {
    const src = `${base}/${encodeURIComponent(video.jobId)}`
    return `
<article>
  <h2>${escapeHtml(video.title)}</h2>
  ${video.detail === '' ? '' : `<p class="dim">${escapeHtml(video.detail)}</p>`}
  <video controls preload="none" src="${src}"></video>
  <a class="bouton" href="${src}?telecharger=1">Télécharger la vidéo</a>
</article>`
  })
  return layout(options.title, `
<h1>${escapeHtml(options.title)}</h1>
${videos.length === 0 ? '<p class="dim">Aucune vidéo disponible pour le moment.</p>' : `<p class="dim">${videos.length} vidéo${videos.length > 1 ? 's' : ''}</p>${videos.join('')}`}`)
}
