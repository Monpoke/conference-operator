import { SCENE_IDS } from './browser/sequence.js'
import { themeDecor, type ThemeSource } from './server/theme.js'

/**
 * The stage's fixed markup, from the reference loop's `index.html`: the decor
 * redrawn to stay sharp in 1080p and beyond, one empty section per scene (the
 * scripts fill them), the permanent logo, the bottom band, the progress bar,
 * the transition layers, the loading screen and the control panel.
 */
export function projectorBody(theme?: ThemeSource | null): string {
  const scenes = SCENE_IDS.map((id) => `  <section class="scene" data-scene="${id}"></section>`).join('\n')
  return `<div id="stage">

${themeDecor(theme)}

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
