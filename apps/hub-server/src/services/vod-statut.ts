import type { MontageState, UploadState, VodStatut } from '@conference-operator/contract'

/** What one talk's folder holds, reduced to what its status is read from. */
export interface VodStatutSources {
  /** The takes attached to the talk, as its folder lists them. */
  captations: { enCours: boolean }[]
  /** Its files at the storage, rush and sidecar alike. */
  televersements: { state: UploadState }[]
  /** Its latest montage, if one was ever asked. */
  montage: { state: MontageState } | null
}

/**
 * Where a talk's capture stands, in one word and one sentence.
 *
 * Read from the furthest step reached, because that is the question asked of the
 * list: "how far did this one get?". Two exceptions come first. A take still
 * running says so whatever came before — the talk is on air. A failure says so
 * wherever it happened — an upload or a montage that gave up waits for someone,
 * and that someone reads the list, not the logs.
 */
export function vodStatut({ captations, televersements, montage }: VodStatutSources): {
  statut: VodStatut
  detail: string
} {
  if (captations.some((take) => take.enCours)) {
    return { statut: 'en-cours', detail: 'Captation en cours' }
  }
  if (montage?.state === 'echoue') {
    return { statut: 'erreur', detail: 'Montage en échec' }
  }
  if (televersements.some((upload) => upload.state === 'echoue' || upload.state === 'abandonne')) {
    return { statut: 'erreur', detail: 'Téléversement en échec' }
  }
  switch (montage?.state) {
    case 'termine':
      return { statut: 'prete', detail: 'VOD montée' }
    case 'a-valider':
      return { statut: 'a-valider', detail: 'Coupe à valider avant le montage' }
    case 'attente':
    case 'en-cours':
      return { statut: 'montage', detail: 'Montage en cours' }
    default:
      break
  }
  if (televersements.some((upload) => upload.state === 'attente' || upload.state === 'en-cours')) {
    return { statut: 'televersement', detail: 'Téléversement en cours' }
  }
  if (televersements.length > 0) {
    return { statut: 'sur-le-stockage', detail: 'Rush sur le stockage, pas encore monté' }
  }
  if (captations.length > 0) {
    return { statut: 'sur-la-machine', detail: 'Rush sur la machine de la salle, pas encore téléversé' }
  }
  return { statut: 'aucune', detail: 'Aucune captation' }
}
