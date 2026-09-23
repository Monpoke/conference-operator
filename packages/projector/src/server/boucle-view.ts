import { DUREES_PAR_DEFAUT, type Boucle, type BoucleLogo, type BoucleView, type SponsorRef } from '@conference-operator/contract'
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
  /** The walls.io embed address set on the hub. */
  wallsIoUrl: string | null
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
  const { options, ...wallsio } = boucle.wallsio

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
    mur: {
      titre: boucle.mur.titre,
      hashtag: boucle.mur.hashtag,
      posts: boucle.mur.posts.map(({ photo, image, ...post }) => ({
        ...post,
        photoUrl: localize(photo),
        imageUrl: localize(image),
      })),
    },
    wallsio: { ...wallsio, src: wallsIoSrc(sources.wallsIoUrl, options) },
    conduite: { ...conduite, qrSvg: boucle.conduite.url == null ? null : sources.qr(boucle.conduite.url) },
    feedbacks: { ...feedbacks, qrSvg: feedbackUrl == null ? null : sources.qr(feedbackUrl) },
  }
}

/**
 * The embed address with the display options merged in.
 *
 * The options win over what the address already carries: they are the setting
 * made for the screens, the address is what walls.io handed over.
 */
export function wallsIoSrc(url: string | null, options: string): string | null {
  if (url == null) return null
  try {
    const src = new URL(url)
    for (const [key, value] of new URLSearchParams(options)) src.searchParams.set(key, value)
    return src.toString()
  } catch {
    return null
  }
}

/** Every address the loop draws as a QR code — drawn ahead, at sync. */
export function boucleQrUrls(boucle: Boucle, openFeedbackProjectId: string | null): string[] {
  const urls: string[] = []
  if (boucle.conduite.url != null) urls.push(boucle.conduite.url)
  if (boucle.feedbacks.url != null) urls.push(boucle.feedbacks.url)
  else if (openFeedbackProjectId) urls.push(`https://openfeedback.io/${encodeURIComponent(openFeedbackProjectId)}`)
  return urls
}
