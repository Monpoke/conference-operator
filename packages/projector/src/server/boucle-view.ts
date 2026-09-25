import {
  DUREES_PAR_DEFAUT,
  type Boucle,
  type BoucleLogo,
  type BoucleView,
  type Comment,
  type SponsorRef,
  type WallCard,
} from '@conference-operator/contract'
import {
  defaultSponsorPages,
  programSponsors,
  resolveSponsorRef,
  type Program,
} from '@conference-operator/program'

export interface BoucleSources {
  /** The loop's settings, cached from the hub. */
  boucle: Boucle
  /** The active program, **not** localised: the addresses are cache keys. */
  program: Program | null
  /** The event's OpenFeedback project — the feedback QR's default address. */
  openFeedbackProjectId: string | null
  /** The event's short name — the signature's default text. */
  eventShortName: string | null
  /** An image's local address, or `null` when it is not cached. */
  localize: (ref: string | null) => string | null
  /** A QR code already drawn for this address, or `null` while it is being drawn. */
  qr: (url: string) => string | null
}

/**
 * The loop's content as the room screen reads it.
 *
 * Pure, and built by the room rather than the hub: only the room knows which
 * images are in its cache, and the page must never be handed a remote address —
 * a logo that is missing is replaced by the sponsor's name, not fetched.
 */
export function buildBoucleView(sources: BoucleSources): BoucleView {
  const { boucle, program, localize } = sources
  const catalogue = program == null ? [] : programSponsors(program)
  const logo = (ref: SponsorRef): BoucleLogo => {
    const resolved = resolveSponsorRef(ref, catalogue)
    return { nom: resolved.nom, logoUrl: localize(resolved.logoUrl), echelle: resolved.echelle }
  }
  const pages = boucle.sponsorPages ?? (program == null ? [] : defaultSponsorPages(program))

  const feedbackUrl = boucle.feedbacks.url
    ?? (sources.openFeedbackProjectId ? `https://openfeedback.io/${encodeURIComponent(sources.openFeedbackProjectId)}` : null)

  const { url: _conduiteUrl, ...conduite } = boucle.conduite
  const { url: _feedbackUrl, ...feedbacks } = boucle.feedbacks

  return {
    logoUrl: localize(boucle.logo ?? program?.event.logoUrl ?? null),
    accueil: boucle.accueil,
    signature: boucle.signature == null
      ? null
      : { texte: boucle.signature.texte || sources.eventShortName || '', icone: boucle.signature.icone },
    barreBas: boucle.barreBas,
    agenda: boucle.agenda,
    messages: boucle.messages,
    annonces: boucle.annonces.map((annonce) => ({
      titre: annonce.titre,
      sousTitre: annonce.sousTitre,
      logos: annonce.logos.map(logo),
    })),
    merciSponsors: boucle.merciSponsors,
    durees: { ...DUREES_PAR_DEFAUT, ...boucle.durees },
    sponsorPages: pages.map((page) => ({
      titre: page.titre,
      duree: page.duree ?? null,
      rangs: page.rangs.map((row) => ({ taille: row.taille, logos: row.logos.map(logo) })),
    })),
    wallsio: boucle.wallsio,
    conduite: { ...conduite, qrSvg: boucle.conduite.url == null ? null : sources.qr(boucle.conduite.url) },
    feedbacks: { ...feedbacks, qrSvg: feedbackUrl == null ? null : sources.qr(feedbackUrl) },
  }
}

/**
 * The social wall's posts as the room screen draws them.
 *
 * Pure, like the loop's view: the images go through `localize`, and a photo the
 * room does not hold yet is `null` — the card shows without it, never with a
 * remote address.
 */
export function buildWallCards(posts: readonly Comment[], localize: (ref: string | null) => string | null): WallCard[] {
  return posts.map((post) => ({
    id: post.id,
    source: post.source,
    author: post.author,
    authorSubtitle: post.authorSubtitle,
    avatarUrl: localize(post.avatar),
    text: post.text,
    imageUrl: localize(post.image),
    network: post.network ?? NETWORK_BY_SOURCE[post.source] ?? null,
    postedAt: post.postedAt ?? post.createdAt,
    featured: post.featured,
    sponsor: post.sponsor == null ? null : { name: post.sponsor.name, logoUrl: localize(post.sponsor.logo) },
  }))
}

/** What the card's foot says when the post does not name its network. */
const NETWORK_BY_SOURCE: Partial<Record<Comment['source'], string>> = {
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  x: 'X',
  form: 'Sur place',
}

/** Every address the loop draws as a QR code — drawn ahead, at sync. */
export function boucleQrUrls(boucle: Boucle, openFeedbackProjectId: string | null): string[] {
  const urls: string[] = []
  if (boucle.conduite.url != null) urls.push(boucle.conduite.url)
  if (boucle.feedbacks.url != null) urls.push(boucle.feedbacks.url)
  else if (openFeedbackProjectId) urls.push(`https://openfeedback.io/${encodeURIComponent(openFeedbackProjectId)}`)
  return urls
}
