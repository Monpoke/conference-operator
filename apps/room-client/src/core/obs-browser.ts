/**
 * Ce qu'une Browser Source OBS met à disposition de la page, et ce qu'on en fait.
 *
 * OBS injecte `window.obsstudio` dans chaque Browser Source. Cet objet n'existe
 * nulle part ailleurs : ni dans un navigateur ordinaire, ni dans la fenêtre
 * Electron de secours, ni dans les aperçus hors ligne. **Tout ce qui est ici
 * doit donc être strictement facultatif** — une page qui en dépendrait ne
 * s'afficherait plus en dehors d'OBS.
 *
 * ## Ce que l'objet expose
 *
 * | Membre | Ce qu'il rend |
 * |---|---|
 * | `pluginVersion` | version du plugin navigateur, ex. `2.17.0` |
 * | `getCurrentScene(cb)` | `{ name, width, height }` de la scène programme |
 * | `getStatus(cb)` | `{ recording, streaming, recordingPaused, replaybuffer, virtualcam }` |
 * | `getControlLevel(cb)` | 0 à 5 — ce que la page a le droit de faire |
 * | `startRecording()` … | pilotage d'OBS, réservé aux niveaux élevés |
 *
 * ⚠️ **Les méthodes de requête sont derrière un réglage.** Dans les propriétés
 * de la source, « Autorisations de la page » vaut *Aucune* par défaut : dans ce
 * cas `getCurrentScene` et `getStatus` sont absents ou muets. Les **événements**,
 * eux, sont diffusés sans condition — c'est pourquoi tout ce qui compte ici
 * passe par eux, et que les requêtes ne servent qu'à enrichir un diagnostic.
 *
 * ## Les événements, diffusés sur `window`
 *
 * - `obsSceneChanged` — `detail.name` : la scène programme a changé
 * - `obsSourceActiveChanged` — `detail.active` : **cette source est-elle rendue
 *   dans la scène programme**. C'est le sens strict de « à l'antenne » : en mode
 *   Studio, une source en préparation n'est pas active.
 * - `obsSourceVisibleChanged` — `detail.visible` : œil allumé dans la scène
 *   courante. Plus permissif, et ce n'est pas ce qu'on veut ici.
 * - `obsStreamingStarted` / `obsRecordingStarted` / … : état de la sortie, sans
 *   rapport avec le fait que *cette* source soit vue.
 * - `obsExit` : OBS se ferme.
 *
 * ## Deux pièges de configuration qui priment sur tout ce code
 *
 * 1. **« Éteindre la source lorsqu'elle n'est pas visible »** détruit la page
 *    quand la scène change : aucun script ne tourne, il n'y a rien à mettre en
 *    pause, et au retour la page repart de zéro (reconnexion SSE comprise).
 * 2. **« Rafraîchir le navigateur lorsque la scène devient active »** recharge
 *    la page à chaque retour, avec le même effet.
 *
 * Ces deux réglages doivent rester **décochés** pour que la mise en pause ait
 * un sens — et de toute façon pour que l'écran de salle ne clignote pas à
 * chaque bascule de scène.
 */

/**
 * Gel des animations hors antenne.
 *
 * `animation-play-state: paused` fige sans détruire : au retour, l'animation
 * reprend où elle en était au lieu de resauter à son début. Les transitions
 * sont coupées net, faute d'équivalent.
 *
 * Ce qui n'est PAS gelé : les minuteries JavaScript. L'horloge, la boucle de
 * pages et le flux SSE continuent, sinon la page reviendrait à l'antenne en
 * affichant l'heure d'il y a dix minutes.
 */
export const OBS_ANTENNE_CSS = `
  body[data-antenne="non"] *,
  body[data-antenne="non"] *::before,
  body[data-antenne="non"] *::after {
    animation-play-state: paused !important;
    transition: none !important;
  }
`

/**
 * Script inliné dans les pages servies à OBS.
 *
 * Écrit en chaîne, comme le reste de ces pages : elles n'ont pas d'étape de
 * build et ne peuvent pas `import`.
 */
export const OBS_ANTENNE_JS = `
(() => {
  const obs = window.obsstudio
  const corps = document.body

  /*
   * Hors OBS — navigateur, aperçu hors ligne, fenêtre Electron de secours — on
   * ne pose rien du tout. L'absence de l'attribut vaut « à l'antenne », donc la
   * page s'anime normalement partout ailleurs.
   */
  corps.dataset.obs = obs ? 'oui' : 'non'
  if (!obs) return

  if (obs.pluginVersion) corps.dataset.obsVersion = obs.pluginVersion

  /**
   * État consolidé, lisible depuis la console d'OBS et depuis un test.
   *
   * Exposé sur window et non gardé en fermeture : c'est le seul moyen de
   * diagnostiquer une source depuis l'inspecteur d'OBS, qui n'a pas de
   * point d'arrêt commode dans une page inlinée.
   */
  const etat = window.__obs = {
    version: obs.pluginVersion ?? null,
    antenne: true,
    scene: null,
    sortie: null,
    depuis: Date.now(),
  }

  function poser(actif) {
    if (etat.antenne === actif) return
    etat.antenne = actif
    etat.depuis = Date.now()
    corps.dataset.antenne = actif ? 'oui' : 'non'
    window.dispatchEvent(new CustomEvent('antenne', { detail: { actif } }))
  }

  /*
   * On part à l'antenne, délibérément.
   *
   * OBS n'émet obsSourceActiveChanged que sur *changement* : une source déjà
   * active au chargement n'émet rien. Partir de « hors antenne » figerait donc
   * un écran qui est en train d'être projeté devant la salle, jusqu'au prochain
   * changement de scène. Le sens de l'erreur est choisi : au pire on anime pour
   * rien, jamais l'inverse.
   */
  corps.dataset.antenne = 'oui'

  window.addEventListener('obsSourceActiveChanged', (evenement) => {
    poser(evenement.detail?.active !== false)
  })

  // Nom de scène : pour le diagnostic seulement, rien n'en dépend.
  window.addEventListener('obsSceneChanged', (evenement) => {
    etat.scene = evenement.detail?.name ?? null
  })

  for (const [nom, sortie] of [
    ['obsStreamingStarted', 'diffusion'],
    ['obsRecordingStarted', 'enregistrement'],
    ['obsStreamingStopped', null],
    ['obsRecordingStopped', null],
  ]) {
    window.addEventListener(nom, () => { etat.sortie = sortie })
  }

  /*
   * Les requêtes, en dernier et sans y compter.
   *
   * Elles dépendent du réglage « Autorisations de la page » de la source, qui
   * vaut Aucune par défaut. Absentes ou muettes, on garde simplement les
   * valeurs nulles : rien de ce qui est affiché n'en dépend.
   */
  try {
    obs.getCurrentScene?.((scene) => { etat.scene = scene?.name ?? null })
    obs.getStatus?.((statut) => {
      etat.sortie = statut?.streaming ? 'diffusion' : statut?.recording ? 'enregistrement' : null
    })
  } catch (cause) {
    console.warn('obsstudio : requêtes indisponibles', cause)
  }
})()
`
