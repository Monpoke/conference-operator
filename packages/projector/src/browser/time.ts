import type { DisplayPayload } from '@conference-operator/contract'

/**
 * Time on the screen: always the hub's corrected clock, always the event's
 * timezone — whatever the machine thinks. The hub can run on a simulated clock
 * weeks away from the machine's, and the reference loop's `?heure=` rehearsal is
 * exactly that, decided on the hub rather than in the address.
 */
const formateurs = new Map<string, Intl.DateTimeFormat>()

const formateur = (tz: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  const cle = tz + JSON.stringify(options)
  let f = formateurs.get(cle)
  if (f == null) {
    f = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, ...options })
    formateurs.set(cle, f)
  }
  return f
}

export const maintenant = (data: DisplayPayload | null): number =>
  Date.now() + (data?.state.serverTimeOffsetMs ?? 0)

export const heureDans = (ms: number, tz: string): string =>
  formateur(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)

/** "25 min", "2 h", or the text as given. */
export function dateLisible(valeur: string, now: number): string {
  if (!valeur) return ''
  const t = Date.parse(valeur)
  if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}/.test(valeur)) return valeur
  const min = Math.round((now - t) / 60000)
  if (min < 1) return "à l'instant"
  if (min < 60) return `${min} min`
  const h = Math.round(min / 60)
  return h < 24 ? `${h} h` : `${Math.round(h / 24)} j`
}
