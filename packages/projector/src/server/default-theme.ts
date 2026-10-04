import { THEME_API_VERSION, type ThemeBundle } from '@conference-operator/contract'

/**
 * The theme the screens wear when the hub has chosen none: sober, any event's.
 *
 * Every colour token is set here — a theme package only overrides — and its
 * typefaces are the loop's base ones (Open Sans, shipped with the room), so it
 * needs no file of its own. An event's look (Cloud Nord's, in `themes/cloudnord`)
 * comes as a package imported from the console.
 */
export const DEFAULT_THEME: ThemeBundle = {
  manifest: {
    apiVersion: THEME_API_VERSION,
    id: 'defaut',
    nom: 'Par défaut',
    version: '1',
    couleurs: {
      violet: '#3b5bdb',
      magenta: '#7048e8',
      cyan: '#15aabf',
      orange: '#fcc419',
      creme: '#f8f9fa',
      marine: '#1c2a4a',
      rose: '#748ffc',
      'bulle-debut': '#5c7cfa',
      'bulle-milieu': '#3bc9db',
      'bulle-fin': '#22b8cf',
      nuit: '#0b1220',
      'vague-rose': '#bac8ff',
      'vague-ciel': '#99e9f2',
      'merci-ombre-1': '#3b5bdb',
      'merci-ombre-2': '#1c2a4a',
      seance: '#1b2745',
      'pastille-encours': '#0b1220',
      'ciel-pale': '#c5d3ea',
      'sur-orange': '#1a1b2e',
      'orange-fonce': '#b7791f',
      'carte-fond': '#ffffff',
      'carte-texte': '#1a2236',
      'carte-discret': '#64748b',
      'carte-filet': '#e2e8f0',
      ombre: '#0b1220',
      barre: '#0b1220',
      urgent: '#7a1420',
      'vod-ombre': '#0b1220',
      'avatar-0': '#3b5bdb',
      'avatar-1': '#7048e8',
      'avatar-2': '#1098ad',
      'avatar-3': '#2f9e44',
      'avatar-4': '#e8590c',
      'avatar-5': '#c2255c',
      'overlay-1': '#22b8cf',
      'overlay-2': '#4c6ef5',
      'overlay-accent': '#748ffc',
      'overlay-rayures': '#4c6ef5',
      'overlay-discret': '#a5b4cf',
      'overlay-titre': '#dbe4ff',
      'overlay-date': '#e7ecf5',
      'overlay-pied': '#e2e8f0',
      'overlay-site': '#ffffff',
      'overlay-carte': '#0b1220',
      'overlay-fond-1': '#1b2440',
      'overlay-fond-2': '#141b30',
      'overlay-fond-3': '#0b1220',
    },
    fond: 'linear-gradient(135deg, #1f2a4d 0%, #172036 55%, #0f1626 100%)',
    polices: {
      roles: {
        titre: '"Open Sans", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        texte: '"Open Sans", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        accueil: '"Open Sans", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        script: '"Open Sans", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      },
      fichiers: [],
    },
    decor: {
      svg: 'decor.svg',
      bulles: [],
    },
    overlay: {},
  },
  css: '',
  // Two quiet rings in opposite corners, in the theme's accents: a frame, not a pattern.
  decor: `<svg viewBox="0 0 1920 1080" width="1920" height="1080">
      <circle cx="1820" cy="40" r="220" fill="none" style="stroke: var(--bulle-debut)" stroke-width="3" opacity=".35"/>
      <circle cx="100" cy="1040" r="260" fill="none" style="stroke: var(--bulle-fin)" stroke-width="3" opacity=".3"/>
    </svg>`,
  overlay: null,
}
