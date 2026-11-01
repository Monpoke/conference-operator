import type { StatistiqueTalk, Statistiques } from '@conference-operator/contract'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/** An average with what it rests on: « sur 12 talks » is half of what it says. */
export interface Moyenne {
  valeur: number | null
  sur: number
}

const moyenne = (values: readonly (number | null)[]): Moyenne => {
  const known = values.filter((value): value is number => value != null)
  return { valeur: known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0) / known.length, sur: known.length }
}

/** Above this at the start, a talk counts as late rather than as a room settling in. */
export const RETARD_NOTABLE_MS = 5 * 60_000

/** The figures of the talks in view: everything is worked out again when a filter moves. */
export function synthese(talks: readonly StatistiqueTalk[]) {
  const attendus = talks.filter((talk) => !talk.sansCaptation)
  const retards = talks.map((talk) => talk.retardMs)
  return {
    prevus: talks.length,
    tenus: talks.filter((talk) => talk.tenue).length,
    retard: moyenne(retards),
    enRetard: retards.filter((value) => value != null && value >= RETARD_NOTABLE_MS).length,
    depassement: moyenne(talks.map((talk) => talk.depassementMs)),
    autos: talks.filter((talk) => talk.auto).length,
    rushAttendus: attendus.length,
    rushRentres: attendus.filter((talk) => talk.rush === 'rentre').length,
    rushManquants: attendus.filter((talk) => talk.rush === 'manquant' || talk.rush === 'echec').length,
    octets: talks.reduce((sum, talk) => sum + talk.rushOctets, 0),
    lufs: moyenne(talks.map((talk) => talk.lufs)),
    piresPics: talks.reduce<number | null>((worst, talk) => (talk.truePeak == null ? worst : Math.max(worst ?? -Infinity, talk.truePeak)), null),
    saturation: talks.reduce((sum, talk) => sum + talk.alertesSaturation, 0),
    silence: talks.reduce((sum, talk) => sum + talk.alertesSilence, 0),
    videos: talks.filter((talk) => talk.montages.includes('termine')).length,
    aValider: talks.filter((talk) => talk.montages.includes('a-valider')).length,
    enEchec: talks.filter((talk) => talk.montages.includes('echoue')).length,
    videoMs: talks.reduce((sum, talk) => sum + talk.videoMs, 0),
    confiance: {
      haute: talks.filter((talk) => talk.confiance === 'haute').length,
      moyenne: talks.filter((talk) => talk.confiance === 'moyenne').length,
      basse: talks.filter((talk) => talk.confiance === 'basse').length,
    },
    consentements: {
      accordes: talks.filter((talk) => talk.consentement === 'accorde').length,
      refuses: talks.filter((talk) => talk.consentement != null && talk.consentement !== 'accorde').length,
      inconnus: talks.filter((talk) => talk.consentement == null).length,
    },
  }
}

const cell = (value: string | number | null) => {
  const text = value == null ? '' : String(value)
  // Opened in a spreadsheet: a cell starting with these would be run as a formula.
  const safe = /^[=+\-@\t\r]/.test(text) && typeof value === 'string' ? `'${text}` : text
  return /[";\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}
const toMinutes = (ms: number | null) => (ms == null ? null : Math.round(ms / 60_000))

/** One line per talk, for the association's assessment. Semicolons: the French spreadsheet's separator. */
export function talksCsv(talks: readonly StatistiqueTalk[]): string {
  const head = ['Début prévu', 'Talk', 'Salle', 'Retard (min)', 'Écart de fin (min)', 'Rush', 'Niveau (LUFS)', 'Pic (dB)', 'Alertes saturation', 'Alertes silence', 'Montage', 'Vidéo (min)', 'Diffusion']
  const rows = talks.map((talk) => [talk.startsAt, talk.title, talk.roomName, toMinutes(talk.retardMs), toMinutes(talk.depassementMs), talk.rush, talk.lufs, talk.truePeak, talk.alertesSaturation, talk.alertesSilence, talk.montages.at(-1) ?? null, toMinutes(talk.videoMs), talk.consentement])
  return [head, ...rows].map((row) => row.map(cell).join(';')).join('\n')
}

export const useStatistiquesStore = defineStore('statistiques', () => {
  const data = ref<Statistiques | null>(null)
  const session = useSessionStore()

  async function load(): Promise<void> {
    data.value = await session.client.rpc.statistiques.bilan()
  }

  return { data, load }
})
