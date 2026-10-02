import { z } from 'zod'

/**
 * The loop's theme: what makes the room screens look like one event rather than
 * another — the colours, the typefaces, the decor behind the scenes — apart from
 * the content (`boucle`), which says what is shown.
 *
 * A theme is a package the console imports (`theme.json` and its files, zipped),
 * so that an event can bring its own look without a release: the hub keeps it,
 * the rooms fetch it at sync and project it offline. With no theme chosen, the
 * screens wear the default one, built into the code.
 *
 * Field names stay in French, as in `boucle`: the organisers write these files.
 */

/** The version of the package format this code reads. */
export const THEME_API_VERSION = 1

/**
 * The colour tokens, each one a `--<name>` variable of the stylesheets (and a
 * `--<name>-rgb` triplet, for the translucent shades).
 *
 * A theme sets the ones it cares about; the others keep the default theme's.
 */
export const THEME_COULEURS = [
  // The palette proper.
  'violet',
  'magenta',
  'cyan',
  'orange',
  'creme',
  'marine',
  'rose',
  // The bubbles' gradient, which also runs through the stinger and the progress bar.
  'bulle-debut',
  'bulle-milieu',
  'bulle-fin',
  // Deep shades: the transition veil, the text shadows, the control panel.
  'nuit',
  // The colour wave of the « arc-en-ciel » style.
  'vague-rose',
  'vague-ciel',
  // The « Merci beaucoup ! » double shadow.
  'merci-ombre-1',
  'merci-ombre-2',
  // The agenda.
  'seance',
  'pastille-encours',
  'ciel-pale',
  'sur-orange',
  'orange-fonce',
  // The white cards (walls, other rooms, networks).
  'carte-fond',
  'carte-texte',
  'carte-discret',
  'carte-filet',
  'ombre',
  // The bottom band, the urgent message, the VOD's shadows.
  'barre',
  'urgent',
  'vod-ombre',
  // The authors' avatars, picked by name.
  'avatar-0',
  'avatar-1',
  'avatar-2',
  'avatar-3',
  'avatar-4',
  'avatar-5',
  // The capture overlay, a frame of its own around the slides and the webcam.
  'overlay-1',
  'overlay-2',
  'overlay-accent',
  'overlay-rayures',
  'overlay-discret',
  'overlay-titre',
  'overlay-date',
  'overlay-pied',
  'overlay-carte',
  'overlay-fond-1',
  'overlay-fond-2',
  'overlay-fond-3',
] as const
export type ThemeCouleur = (typeof THEME_COULEURS)[number]

/** The typefaces' roles, each one a `--f-<role>` font stack. */
export const THEME_POLICES = ['titre', 'texte', 'accueil', 'script'] as const
export type ThemePolice = (typeof THEME_POLICES)[number]

export const couleurThemeSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'couleur #rrggbb attendue')

/**
 * A value written into a stylesheet as is: a font stack, a gradient. Nothing
 * that could close the rule or fetch from elsewhere — the rooms are offline,
 * and the page takes nothing it did not ship.
 */
const valeurCssSchema = z
  .string()
  .min(1)
  .max(400)
  .refine((value) => !/[;{}<>\\]|url\s*\(|@import|expression\s*\(/i.test(value), {
    message: 'valeur CSS non autorisée',
  })

/** A file of the package, by its path inside it. */
export const cheminThemeSchema = z
  .string()
  .max(120)
  .regex(/^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/, 'chemin relatif au paquet attendu')
  .refine((value) => !value.split('/').includes('..'), { message: 'chemin relatif au paquet attendu' })

export const FORMATS_POLICE = ['woff2', 'woff', 'otf', 'ttf'] as const

/** One font file of the package. */
export const fichierPoliceSchema = z.object({
  famille: z.string().min(1).max(60).regex(/^[\p{L}\p{N} _-]+$/u, 'nom de famille simple attendu'),
  graisse: z.number().int().min(100).max(900).default(400),
  style: z.enum(['normal', 'italic']).default('normal'),
  fichier: cheminThemeSchema.refine(
    (value) => FORMATS_POLICE.some((format) => value.toLowerCase().endsWith(`.${format}`)),
    { message: 'police woff2, woff, otf ou ttf attendue' },
  ),
})
export type FichierPolice = z.infer<typeof fichierPoliceSchema>

/** A floating bubble of the decor, on the 1920×1080 stage. */
export const bulleThemeSchema = z.object({
  x: z.number().min(-200).max(2120),
  y: z.number().min(-200).max(1280),
  taille: z.number().min(4).max(600),
  /** Seconds for one swing. */
  duree: z.number().min(1).max(60).default(9),
  /** Seconds, negative: where in its swing the bubble starts. */
  delai: z.number().min(-60).max(60).default(0),
})
export type BulleTheme = z.infer<typeof bulleThemeSchema>

/** `theme.json`, at the root of the package. */
export const themeManifestSchema = z.object({
  apiVersion: z.literal(THEME_API_VERSION),
  /** Stable name, for the files and the logs. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'identifiant en minuscules, chiffres et tirets'),
  nom: z.string().min(1).max(60),
  version: z.string().max(20).default('1'),
  auteur: z.string().max(80).optional(),
  couleurs: z.partialRecord(z.enum(THEME_COULEURS), couleurThemeSchema).default({}),
  /** The stage's background: a CSS gradient or colour. */
  fond: valeurCssSchema.optional(),
  polices: z
    .object({
      roles: z.partialRecord(z.enum(THEME_POLICES), valeurCssSchema).default({}),
      fichiers: z.array(fichierPoliceSchema).max(16).default([]),
    })
    .default({ roles: {}, fichiers: [] }),
  decor: z
    .object({
      /** An `<svg>` drawn behind every scene, 1920×1080. Absent: none. */
      svg: cheminThemeSchema.optional(),
      bulles: z.array(bulleThemeSchema).max(40).default([]),
    })
    .default({ bulles: [] }),
  overlay: z
    .object({
      /** What fills the capture overlay around its holes, inside a 1920×1080 `<svg>`. Absent: the default's. */
      svg: cheminThemeSchema.optional(),
    })
    .default({}),
  /** A stylesheet of the theme's own, added after the loop's (effects, adjustments). */
  css: cheminThemeSchema.optional(),
})
export type ThemeManifest = z.infer<typeof themeManifestSchema>

/**
 * A theme as the hub and the rooms hold it: the manifest, and the text files it
 * names, read. Fonts and images stay files, served from `<base>/<path>`.
 */
export interface ThemeBundle {
  manifest: ThemeManifest
  /** `theme.css`, or the file `css` names. */
  css: string
  /** The decor's `<svg>`, or `null`. */
  decor: string | null
  /** The overlay's fill, or `null`. */
  overlay: string | null
}

/** The theme a hub has chosen, as the loop's settings carry it to the rooms. */
export const themeRefSchema = z.object({
  id: z.string().max(40),
  nom: z.string().max(60),
  /** The package's sha-256: the rooms fetch it once, and keep it. */
  sha: z.string().regex(/^[0-9a-f]{64}$/),
})
export type ThemeRef = z.infer<typeof themeRefSchema>

/** A theme the hub keeps, as the console lists it. */
export const themeInfoSchema = themeRefSchema.extend({
  version: z.string(),
  auteur: z.string().nullable(),
  importeLe: z.string(),
  taille: z.number().int(),
})
export type ThemeInfo = z.infer<typeof themeInfoSchema>
