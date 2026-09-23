import { SCENE_IDS } from './browser/sequence.js'

/**
 * The stage's fixed markup, from the reference loop's `index.html`: the decor
 * redrawn to stay sharp in 1080p and beyond, one empty section per scene (the
 * scripts fill them), the permanent logo, the bottom band, the progress bar,
 * the transition layers, the loading screen and the control panel.
 */
export function projectorBody(): string {
  const scenes = SCENE_IDS.map((id) => `  <section class="scene" data-scene="${id}"></section>`).join('\n')
  return `<div id="stage">

  <div id="decor" aria-hidden="true">
    <svg viewBox="0 0 1920 1080" width="1920" height="1080">
      <defs>
        <linearGradient id="g-bulle" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stop-color="#e21bfb"/><stop offset="1" stop-color="#14d3dc"/>
        </linearGradient>
        <linearGradient id="g-anneau-bas" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="#20d0dc"/><stop offset="1" stop-color="#2a8fd0"/>
        </linearGradient>
        <linearGradient id="g-anneau-haut" x1="0" x2="1" y1="1" y2="0">
          <stop offset="0" stop-color="#c24fc8" stop-opacity=".75"/><stop offset="1" stop-color="#6a7ad8" stop-opacity=".75"/>
        </linearGradient>
        <pattern id="rayures" width="32" height="32" patternUnits="userSpaceOnUse" patternTransform="rotate(38)">
          <rect width="10" height="32" fill="#c868b4"/>
        </pattern>
        <clipPath id="clip-haut-gauche"><circle cx="250" cy="29" r="140"/></clipPath>
        <clipPath id="clip-bas-droite"><circle cx="1675" cy="1042" r="142"/></clipPath>
      </defs>
      <rect x="100" y="-120" width="300" height="300" fill="url(#rayures)" clip-path="url(#clip-haut-gauche)" opacity=".9"/>
      <rect x="1525" y="890" width="300" height="300" fill="url(#rayures)" clip-path="url(#clip-bas-droite)" opacity=".9"/>
      <circle cx="1764" cy="0" r="138" fill="none" stroke="url(#g-anneau-haut)" stroke-width="5"/>
      <circle cx="1642" cy="13" r="86" fill="url(#g-bulle)"/>
      <circle cx="189" cy="1068" r="158" fill="none" stroke="url(#g-anneau-bas)" stroke-width="8"/>
      <circle cx="69" cy="1066" r="82" fill="url(#g-bulle)"/>
    </svg>
    <i class="bulle" style="left:511px; top:337px; width:80px; height:80px; --d:9s"></i>
    <i class="bulle" style="left:455px; top:397px; width:40px; height:40px; --d:7s; --delai:-3s"></i>
    <i class="bulle" style="left:173px; top:552px; width:40px; height:40px; --d:8s; --delai:-5s"></i>
    <i class="bulle" style="left:584px; top:829px; width:64px; height:64px; --d:10s; --delai:-2s"></i>
    <i class="bulle" style="left:1234px; top:774px; width:40px; height:40px; --d:8s; --delai:-6s"></i>
    <i class="bulle" style="left:1466px; top:226px; width:28px; height:28px; --d:7s; --delai:-1s"></i>
    <i class="bulle" style="left:1679px; top:422px; width:28px; height:28px; --d:9s; --delai:-4s"></i>
    <i class="bulle" style="left:1575px; top:476px; width:64px; height:64px; --d:11s; --delai:-7s"></i>
    <i class="bulle" style="left:1639px; top:563px; width:22px; height:22px; --d:6s; --delai:-2s"></i>
  </div>

${scenes}

  <img id="logo" alt="" hidden>

  <div id="barre-bas">
    <p class="bb-prochain">
      <span class="bb-libelle" data-bb-libelle></span>
      <span class="bb-heure" data-bb-heure></span>
      <span class="bb-titre" data-bb-titre></span>
      <span class="pastille pastille-lieu" data-bb-salle hidden></span>
    </p>
    <p class="bb-partage">
      <span class="bb-message" data-bb-message></span>
      <span class="bb-hashtag respire" data-bb-hashtag></span>
    </p>
    <p class="bb-etat">
      <span class="pastille pastille-pause" id="break-badge" hidden></span>
      <span class="bb-lien" id="status-dot" title="Liaison avec le hub" hidden></span>
    </p>
    <p class="bb-horloge" data-bb-horloge></p>
  </div>

  <div id="progression" aria-hidden="true"><i></i></div>
  <div id="voile"></div>
  <div id="stinger"></div>
</div>

<div id="chargement"><p data-message>Préparation des scènes…</p></div>

<aside id="hud" hidden>
  <p class="hud-etat"><strong data-hud-etat>Lecture</strong><span data-hud-transition></span></p>
  <p class="hud-infos" data-hud-infos></p>
  <ol data-hud-liste></ol>
  <div class="hud-barre"><i data-hud-barre></i></div>
  <p class="hud-aide">Espace : pause. Flèches : scène précédente ou suivante. 1 à 9 et 0 : aller à une scène. T : forcer une transition. R : relire les données. F : plein écran. H : masquer ce panneau.</p>
</aside>`
}
