import { z } from 'zod'

/**
 * The welcome loop's own content: everything the room screens show that the
 * program export does not carry.
 *
 * A hub setting, like the social accounts and the walls.io address, and for the
 * same reason: a slogan, a hashtag or a sponsor's place on a page is corrected
 * during the event, and doing so must not require shipping a release to the room
 * machines. The defaults reproduce the reference loop (`donnees.js` and the fixed
 * texts of its `index.html`), so a fresh hub shows that loop as it was designed.
 *
 * Field names stay in French, as in the reference data file the organisers
 * already know.
 */

/**
 * Where an image comes from.
 *
 * Either an address the hub downloads into its asset store, or an image uploaded
 * from the console (`hub-image:<sha256>.<ext>`). Both end up in the same cache the
 * rooms read from: the screen never goes to the Internet for a logo.
 */
export const imageRefSchema = z
  .string()
  .max(600)
  .refine(
    (value) => /^https?:\/\//.test(value) || /^hub-image:[0-9a-f]{64}\.(png|jpe?g|webp|gif|svg)$/.test(value),
    { message: 'adresse http(s) ou image déposée attendue' },
  )
export type ImageRef = z.infer<typeof imageRefSchema>

export const isUploadedImage = (ref: string): boolean => ref.startsWith('hub-image:')

/**
 * How an animated message comes in.
 *
 * `claque` and `mots` bring the text word by word, with the violet outline;
 * `eclate`, `lettres` and `machine` letter by letter, in white run through by a
 * wave of colours.
 */
export const effetMessageSchema = z.enum(['claque', 'mots', 'eclate', 'lettres', 'machine'])
export type EffetMessage = z.infer<typeof effetMessageSchema>

const messageSchema = z.object({
  /** `\n` forces a line break. Empty = the scene is skipped. */
  texte: z.string().max(200),
  sousTitre: z.string().max(120).default(''),
  effet: effetMessageSchema.default('claque'),
})

/** A sponsor placed on a page: one of the program's, or one it does not know. */
export const sponsorRefSchema = z.object({
  /** `sponsorKey()` of a program sponsor (its website), or its name. */
  sponsor: z.string().min(1).max(200),
  /** Name shown instead of the program's — or the name of a sponsor it lacks. */
  nom: z.string().max(80).nullable().default(null),
  /** Logo shown instead of the program's. */
  logo: imageRefSchema.nullable().default(null),
  /** Room the logo takes in its white circle: 0.7 by default, 1 = edge to edge. */
  echelle: z.number().min(0.2).max(2).default(0.7),
})
export type SponsorRef = z.infer<typeof sponsorRefSchema>

export const sponsorPageSchema = z.object({
  /** Title above the circles; may hold a `\n`. Empty = the logos alone. */
  titre: z.string().max(120).default(''),
  rangs: z
    .array(
      z.object({
        /** Diameter of the row's circles: 1 = 240 px on the 1920 stage. */
        taille: z.number().min(0.3).max(2).default(1),
        logos: z.array(sponsorRefSchema).max(12),
      }),
    )
    .max(4),
  /** Seconds on screen for this page; `null` = the sponsor pages' duration. */
  duree: z.number().int().min(3).max(600).nullable().default(null),
})
export type SponsorPage = z.infer<typeof sponsorPageSchema>

export const annonceSchema = z.object({
  titre: z.string().max(80),
  sousTitre: z.string().max(80).default(''),
  logos: z.array(sponsorRefSchema).max(6).default([]),
})
export type Annonce = z.infer<typeof annonceSchema>

/** A post on the hand-fed social wall — the offline fallback of walls.io. */
export const postSchema = z.object({
  auteur: z.string().min(1).max(80),
  titre: z.string().max(120).default(''),
  photo: imageRefSchema.nullable().default(null),
  /** `2026-10-30T10:42` (shown "25 min", computed live) or free text ("2 h"). */
  date: z.string().max(40).default(''),
  texte: z.string().max(1500),
  image: imageRefSchema.nullable().default(null),
  reactions: z.number().int().min(0).nullable().default(null),
  commentaires: z.number().int().min(0).nullable().default(null),
  reseau: z.string().max(30).default('LinkedIn'),
})
export type Post = z.infer<typeof postSchema>

const sloganSchema = z.object({
  /** The hollow word above ("Passez"). */
  creux: z.string().max(40),
  /** The orange, outlined lines below; `\n` breaks. */
  orange: z.string().max(80),
})

export const MAX_ANNONCES = 4
export const MAX_SPONSOR_PAGES = 8

/**
 * How long each kind of scene stays on screen, in seconds — the reference loop's
 * `data-duration`. The pages of a kind share theirs: every sponsor page, every
 * announcement.
 */
export const DUREES_PAR_DEFAUT = {
  accueil: 10,
  agenda: 20,
  annonces: 8,
  merci: 6,
  sponsors: 8,
  posts: 15,
  'message-bienvenue': 7,
  salles: 12,
  'agenda-rappel': 20,
  'message-partage': 7,
  reseaux: 10,
  wallsio: 25,
  'message-silence': 7,
  conduite: 14,
  feedbacks: 10,
} as const satisfies Record<string, number>

export type DureeScene = keyof typeof DUREES_PAR_DEFAUT

/** How long another room's schedule stays on screen when nothing is set. */
export const DUREE_PLANNING_PAR_DEFAUT = 15
/** The other rooms' schedules mounted at most — scenes are mounted ahead. */
export const MAX_PLANNINGS = 6

/** Another room's schedule in the loop: shown or not, and for how long. */
export const planningSchema = z.object({
  afficher: z.boolean().default(true),
  duree: z.number().int().min(3).max(600).default(DUREE_PLANNING_PAR_DEFAUT),
})
export type Planning = z.infer<typeof planningSchema>

/** The public preview link's key: long enough not to be guessed. */
export const lienPublicSchema = z.string().regex(/^[A-Za-z0-9_-]{24,64}$/)
export const dureeSceneSchema = z.enum(Object.keys(DUREES_PAR_DEFAUT) as [DureeScene, ...DureeScene[]])

export const boucleSchema = z.object({
  /** Logo top left of every scene and large on the welcome. `null` = the program's. */
  logo: imageRefSchema.nullable().default(null),
  accueil: z.object({ texte: z.string().max(60) }).default({ texte: 'Bienvenue à' }),
  /** Bottom right of some scenes. `null` removes it. */
  signature: z
    .object({
      texte: z.string().max(40),
      icone: z.enum(['linkedin', 'aucune']).default('linkedin'),
    })
    .nullable()
    .default({ texte: 'Cloud Nord', icone: 'linkedin' }),
  /** The permanent band: the room's next session, a message with the hashtag, the time. */
  barreBas: z
    .object({
      afficher: z.boolean().default(true),
      libelle: z.string().max(30).default('À suivre'),
      message: z.string().max(60).default('Partagez la journée avec'),
      hashtag: z.string().max(40).default('#CloudNord2026'),
      finJournee: z.string().max(80).default("Merci et à l'année prochaine !"),
    })
    .default({
      afficher: true,
      libelle: 'À suivre',
      message: 'Partagez la journée avec',
      hashtag: '#CloudNord2026',
      finJournee: "Merci et à l'année prochaine !",
    }),
  agenda: z
    .object({
      /** Finished sessions leave the screen and the rest of the day takes the room. */
      masquerTerminees: z.boolean().default(true),
    })
    .default({ masquerTerminees: true }),
  messages: z
    .object({ bienvenue: messageSchema, partage: messageSchema, silence: messageSchema })
    .default({
      bienvenue: { texte: 'Bienvenue chez\nCloud Nord !', sousTitre: '30 octobre 2026', effet: 'eclate' },
      partage: {
        texte: 'Partagez la journée\navec #CloudNord2026',
        sousTitre: "Vos posts s'affichent sur le mur",
        effet: 'claque',
      },
      silence: {
        texte: 'Pensez à couper le son\nde votre téléphone',
        sousTitre: 'Merci pour les speakers !',
        effet: 'machine',
      },
    }),
  /** "Offered by" scenes, one each. */
  annonces: z
    .array(annonceSchema)
    .max(MAX_ANNONCES)
    .default([
      {
        titre: 'Petit déjeuner',
        sousTitre: 'offert par',
        logos: [{ sponsor: 'APE Factory', nom: null, logo: null, echelle: 0.72 }],
      },
    ]),
  merciSponsors: z.string().max(80).default('Merci à nos\nSponsors'),
  /**
   * The other rooms' schedules, by room identifier. A room absent here is shown,
   * for `DUREE_PLANNING_PAR_DEFAUT` seconds.
   */
  plannings: z.record(z.string().max(120), planningSchema).default({}),
  /**
   * The key of the public link to the loop's preview (`/boucle/apercu?cle=…`),
   * or `null`: no public link. One key for every room — the address picks the
   * room. Regenerating it cuts the links already shared.
   */
  lienPublic: lienPublicSchema.nullable().default(null),
  /** Seconds per kind of scene; absent = the reference's (`DUREES_PAR_DEFAUT`). */
  durees: z.partialRecord(dureeSceneSchema, z.number().int().min(3).max(600)).default({}),
  /** `null` = one page per tier of the program, laid out automatically. */
  sponsorPages: z.array(sponsorPageSchema).max(MAX_SPONSOR_PAGES).nullable().default(null),
  mur: z
    .object({
      titre: z.string().max(60).default('Ils en parlent sur LinkedIn'),
      hashtag: z.string().max(40).default('#CloudNord2026'),
      posts: z.array(postSchema).max(40).default([]),
    })
    .default({ titre: 'Ils en parlent sur LinkedIn', hashtag: '#CloudNord2026', posts: [] }),
  wallsio: z
    .object({
      /** Added to the wall's address: layout, background, header. */
      options: z.string().max(300).default('nobackground=1&show_header=0&layout=kiosk'),
      /** Enlargement: the wall is laid out smaller, then scaled up, fewer columns. */
      zoom: z.number().min(0.5).max(3).default(1.2),
      /** Reload off screen every N minutes (stable memory over a day). 0 = never. */
      rechargeMinutes: z.number().int().min(0).max(1440).default(60),
      titre: z.string().max(60).default('Le mur Cloud Nord'),
      hashtag: z.string().max(40).default('#CloudNord2026'),
    })
    .default({
      options: 'nobackground=1&show_header=0&layout=kiosk',
      zoom: 1.2,
      rechargeMinutes: 60,
      titre: 'Le mur Cloud Nord',
      hashtag: '#CloudNord2026',
    }),
  conduite: z
    .object({
      paragraphes: z.array(z.string().max(300)).max(6),
      /** Address of the full code of conduct, drawn as a QR code. `null` = no QR. */
      url: z.url().nullable().default(null),
      legende: z.string().max(80).default("L'intégralité de notre\nCode de conduite"),
      slogan: sloganSchema.default({ creux: 'Passez', orange: 'Une bonne\nconférence' }),
    })
    .default({
      paragraphes: [
        'Nous sommes une communauté ouverte et engagée,\nrespectant les différences et la diversité.',
        "Ceci implique qu'aucun comportement ou propos\ndéplacé n'est accepté lors de nos événements.",
        'Voici un rappel de ce que nous n\'accepterons pas :\nblagues ou offenses à propos de la sexualité / race /\nreligion / nationalité / morphologie / âge.',
      ],
      url: null,
      legende: "L'intégralité de notre\nCode de conduite",
      slogan: { creux: 'Passez', orange: 'Une bonne\nconférence' },
    }),
  feedbacks: z
    .object({
      /** Drawn as a QR code. `null` = the event's OpenFeedback page. */
      url: z.url().nullable().default(null),
      slogan: sloganSchema.default({ creux: 'Pensez', orange: 'À donner vos\nfeedbacks' }),
      merci: z.tuple([z.string().max(30), z.string().max(30)]).default(['Merci', 'beaucoup !']),
    })
    .default({
      url: null,
      slogan: { creux: 'Pensez', orange: 'À donner vos\nfeedbacks' },
      merci: ['Merci', 'beaucoup !'],
    }),
})
export type Boucle = z.infer<typeof boucleSchema>
export type BoucleInput = z.input<typeof boucleSchema>

export const DEFAULT_BOUCLE: Boucle = boucleSchema.parse({})

/** Every image the loop settings name — what the hub downloads and the rooms cache. */
export function boucleImageRefs(boucle: Boucle): string[] {
  const refs: (string | null)[] = [boucle.logo]
  for (const annonce of boucle.annonces) for (const logo of annonce.logos) refs.push(logo.logo)
  for (const page of boucle.sponsorPages ?? []) {
    for (const row of page.rangs) for (const logo of row.logos) refs.push(logo.logo)
  }
  for (const post of boucle.mur.posts) refs.push(post.photo, post.image)
  return [...new Set(refs.filter((ref): ref is string => ref != null))]
}

/**
 * A logo in its white circle, resolved for the screen.
 *
 * `logoUrl` is already local (`/assets/…`) or `null` — then the name is written
 * in the circle, never a remote address.
 */
export interface BoucleLogo {
  nom: string
  logoUrl: string | null
  echelle: number
}

/**
 * The loop's content as the room screen reads it: settings and program merged,
 * images localised, QR codes drawn. Built by the room, which alone knows what is
 * in its cache.
 */
export interface BoucleView {
  logoUrl: string | null
  accueil: { texte: string }
  signature: { texte: string; icone: 'linkedin' | 'aucune' } | null
  barreBas: Boucle['barreBas']
  agenda: Boucle['agenda']
  messages: Boucle['messages']
  annonces: { titre: string; sousTitre: string; logos: BoucleLogo[] }[]
  merciSponsors: string
  /** Every kind of scene's duration, the settings over the reference's. */
  durees: Record<DureeScene, number>
  sponsorPages: { titre: string; duree: number | null; rangs: { taille: number; logos: BoucleLogo[] }[] }[]
  mur: {
    titre: string
    hashtag: string
    posts: (Omit<Post, 'photo' | 'image'> & { photoUrl: string | null; imageUrl: string | null })[]
  }
  /** `src` is the embed address with the options merged in; `null` = no wall. */
  wallsio: Omit<Boucle['wallsio'], 'options'> & { src: string | null }
  conduite: Omit<Boucle['conduite'], 'url'> & { qrSvg: string | null }
  feedbacks: Omit<Boucle['feedbacks'], 'url'> & { qrSvg: string | null }
}
