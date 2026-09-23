import type { Program } from './model.js'

/**
 * The key a sponsor is recognised by, from one tier to the next.
 *
 * The upstream export gives one identifier **per tier**: "ape factory", which
 * took three packs, carries three different ones. The website is the only thing
 * that does not move from one row to another; the name serves as a fallback for
 * the rare sponsors that declare none.
 */
export function sponsorKey(sponsor: { website: string | null; name: string }): string {
  return (sponsor.website || sponsor.name || '').trim().toLowerCase().replace(/\/+$/, '')
}

/** A partner of the program, once, whatever the number of packs it took. */
export interface ProgramSponsor {
  key: string
  name: string
  website: string | null
  logoUrl: string | null
  /** Names of the tiers it appears in, in rank order. */
  tiers: string[]
}

/** The program's partners, deduplicated by `sponsorKey`, in tier rank order. */
export function programSponsors(program: Pick<Program, 'sponsorTiers'>): ProgramSponsor[] {
  const byKey = new Map<string, ProgramSponsor>()
  for (const tier of program.sponsorTiers) {
    for (const sponsor of tier.sponsors) {
      const key = sponsorKey(sponsor)
      const known = byKey.get(key)
      if (known) {
        if (!known.tiers.includes(tier.name)) known.tiers.push(tier.name)
        known.logoUrl ??= sponsor.logoUrl
        continue
      }
      byKey.set(key, { key, name: sponsor.name, website: sponsor.website, logoUrl: sponsor.logoUrl, tiers: [tier.name] })
    }
  }
  return [...byKey.values()]
}

/**
 * A sponsor placed on a page of the loop. Structural twin of the contract's
 * `sponsorRefSchema` — the program package cannot import the contract.
 */
export interface SponsorPlacement {
  /** `sponsorKey` of a program sponsor, or a free name for one it does not know. */
  sponsor: string
  /** Name shown instead of the program's, or the name of a sponsor it lacks. */
  nom: string | null
  /** Logo shown instead of the program's. */
  logo: string | null
  /** Room the logo takes in its circle (0.7 by default, 1 = edge to edge). */
  echelle: number
}

export interface SponsorPageLayout {
  titre: string
  /** Seconds on screen for this page; absent or `null` = the sponsor pages' duration. */
  duree?: number | null
  rangs: { taille: number; logos: SponsorPlacement[] }[]
}

/**
 * One page per tier, when the organiser has laid out nothing.
 *
 * The first tier — the one that paid the most — gets no title: its logos are the
 * page, as in the reference loop. Rows hold four logos at most, split evenly: six
 * sponsors give two rows of three rather than four and two.
 */
export function defaultSponsorPages(program: Pick<Program, 'sponsorTiers'>): SponsorPageLayout[] {
  const tiers = program.sponsorTiers.filter((tier) => tier.sponsors.length > 0)
  return tiers.map((tier, index) => {
    const seen = new Set<string>()
    const logos: SponsorPlacement[] = []
    for (const sponsor of tier.sponsors) {
      const key = sponsorKey(sponsor)
      if (seen.has(key)) continue
      seen.add(key)
      logos.push({ sponsor: key, nom: null, logo: null, echelle: 0.8 })
    }
    const rowCount = Math.ceil(logos.length / 4)
    const perRow = Math.ceil(logos.length / rowCount)
    const rangs: SponsorPageLayout['rangs'] = []
    for (let i = 0; i < logos.length; i += perRow) rangs.push({ taille: 1, logos: logos.slice(i, i + perRow) })
    return { titre: index === 0 ? '' : tier.name, rangs }
  })
}

export interface ResolvedSponsor {
  nom: string
  /** Logo address before localisation — the override first, then the program's. */
  logoUrl: string | null
  echelle: number
  /** The placement names a sponsor the program does not (or no longer) know. */
  missing: boolean
}

const simplify = (text: string) =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Finds a placement's sponsor in the program: by key, then by name. */
export function resolveSponsorRef(ref: SponsorPlacement, catalogue: ProgramSponsor[]): ResolvedSponsor {
  const wanted = simplify(ref.sponsor)
  const found = catalogue.find((s) => s.key === ref.sponsor)
    ?? (wanted ? catalogue.find((s) => simplify(s.name) === wanted || simplify(s.key) === wanted) : undefined)
  return {
    nom: ref.nom ?? found?.name ?? ref.sponsor,
    logoUrl: ref.logo ?? found?.logoUrl ?? null,
    echelle: ref.echelle,
    missing: found == null,
  }
}
