/**
 * The « Nos réseaux » rows, checked before they leave for the hub.
 *
 * The form used to drop, without a word, any row with one field left empty — and
 * then said « Réseaux enregistrés ». The account typed was simply not there. A row
 * entirely empty is still dropped: adding a row then thinking better of it is a
 * normal gesture. A row half filled is an account someone meant to add, and it
 * stops the save with the field that is missing.
 *
 * The limits are the hub's (`socialLinkSchema`, at most eight accounts): said here,
 * next to the field, rather than as the hub's refusal after the click.
 */

export interface SocialRow {
  network: string
  handle: string
  url: string
}

export type SocialField = keyof SocialRow

export interface SocialRowError {
  fields: SocialField[]
  message: string
}

export const MAX_SOCIAL_LINKS = 8
const MAX_NETWORK = 40
const MAX_HANDLE = 80

/**
 * An address as typed, made into the one the hub stores.
 *
 * `cloudnord.fr` is what people type, and what the hub refuses: it gets its
 * `https://`. Anything that still does not read as a web address — no dot in the
 * host, another scheme — is `null`.
 */
export function normalizeUrl(raw: string): string | null {
  const typed = raw.trim()
  if (typed === '') return null
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!url.hostname.includes('.')) return null
    return url.href
  } catch {
    return null
  }
}

export function checkSocialLinks(rows: SocialRow[]): {
  links: SocialRow[]
  errors: Record<number, SocialRowError>
} {
  const links: SocialRow[] = []
  const errors: Record<number, SocialRowError> = {}

  rows.forEach((row, index) => {
    const network = row.network.trim()
    const handle = row.handle.trim()
    const typedUrl = row.url.trim()
    if (network === '' && handle === '' && typedUrl === '') return

    const missing: SocialField[] = []
    if (network === '') missing.push('network')
    if (handle === '') missing.push('handle')
    if (typedUrl === '') missing.push('url')
    if (missing.length > 0) {
      const names = { network: 'le réseau', handle: 'le texte affiché', url: "l'adresse" }
      errors[index] = { fields: missing, message: `Il manque ${missing.map((field) => names[field]).join(', ')}.` }
      return
    }
    if (network.length > MAX_NETWORK) {
      errors[index] = { fields: ['network'], message: `Le réseau tient en ${MAX_NETWORK} caractères au plus.` }
      return
    }
    if (handle.length > MAX_HANDLE) {
      errors[index] = { fields: ['handle'], message: `Le texte affiché tient en ${MAX_HANDLE} caractères au plus.` }
      return
    }
    const url = normalizeUrl(typedUrl)
    if (url == null) {
      errors[index] = { fields: ['url'], message: `« ${typedUrl} » n'est pas une adresse web (ex. https://cloudnord.fr).` }
      return
    }
    links.push({ network, handle, url })
  })

  if (Object.keys(errors).length === 0 && links.length > MAX_SOCIAL_LINKS) {
    errors[rows.length - 1] = {
      fields: [],
      message: `${MAX_SOCIAL_LINKS} comptes au plus : en retirer ${links.length - MAX_SOCIAL_LINKS}.`,
    }
  }
  return { links, errors }
}
