import type { ConfigVisible, ObsInstance } from '@cloudnord/contract'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useActionsStore } from './actions.js'
import { useRoomStore } from './room.js'

/**
 * Les rôles proposés par instance, et rien d'autre.
 *
 * Trois par OBS : ce sont ceux que la page pilote. Un rôle mappé hors de cette
 * liste — cas rare mais légitime — survit à l'enregistrement, parce que le
 * brouillon repart de l'existant plutôt que de le remplacer.
 */
export const ROLES: Record<ObsInstance, { role: string; label: string }[]> = {
  A: [
    { role: 'LIVE', label: 'Direct' },
    { role: 'HOLD', label: 'Habillage' },
    { role: 'RELAY', label: 'Relais' },
  ],
  B: [
    { role: 'TALK', label: 'Talk complet' },
    { role: 'CAM_ONLY', label: 'Caméra seule' },
    { role: 'SLIDES_ONLY', label: 'Slides seules' },
  ],
}

/** Ce qui manque pour piloter la salle, dit en clair. */
export interface Manque {
  /** Repère stable : le rendu et les tests s'y accrochent, pas au libellé. */
  code: string
  texte: string
}

interface ObsDraft {
  url: string
  /** Saisi. Vide vaut « inchangé » : la page n'a jamais eu le mot de passe. */
  password: string
  clearPassword: boolean
}

export interface ConfigDraft {
  obs: Record<ObsInstance, ObsDraft>
  sceneRoles: Record<ObsInstance, Record<string, string>>
  displayPort: string
  recordingRoot: string
  fileSlug: string
  relaySourceRoomId: string
  promptRecordingOnStart: boolean
  promptRecordingOnStop: boolean
  sceneOnStart: string
}

/**
 * La configuration de la salle, saisie sur un brouillon.
 *
 * Le formulaire est peuplé **à l'ouverture**, jamais à chaque état reçu : la
 * régie en reçoit un toutes les quelques secondes, et repeupler les champs sous
 * les doigts effacerait la saisie en cours. Il se repeuple une seule autre
 * fois — après un enregistrement réussi — et sur l'état qui revient du hub, pas
 * sur ce qu'on vient de taper : c'est la seule façon de voir ce qui a réellement
 * été retenu.
 *
 * Ne suivent en direct que l'état des deux OBS, la liste de leurs scènes, et la
 * possibilité même d'enregistrer.
 */
export const useConfigStore = defineStore('config', () => {
  const room = useRoomStore()
  const actions = useActionsStore()

  const open = ref(false)
  const draft = ref<ConfigDraft | null>(null)
  const saving = ref(false)
  const notice = ref<{ text: string; tone: 'quiet' | 'ok' | 'alerte' } | null>(null)

  /**
   * Le panneau a été ouvert par la vérification de démarrage, pas par l'opérateur.
   *
   * Sert au bandeau : un panneau qui s'ouvre tout seul doit dire pourquoi, sans
   * quoi il se lit comme une fausse manœuvre.
   */
  const ouvertAuDemarrage = ref(false)

  const config = computed(() => room.payload?.diagnostics?.config ?? null)

  /**
   * Le hub est la source de vérité.
   *
   * Hors ligne, enregistrer serait une promesse en l'air : la saisie repartirait
   * au premier sync réussi, sans que rien ne l'ait dit.
   */
  const online = computed(() => room.payload?.state.connectivity === 'ONLINE')

  function seed(): void {
    const current = config.value
    if (current == null) {
      draft.value = null
      return
    }
    const obs = (instance: ObsInstance): ObsDraft => ({
      url: current.obs[instance].url,
      password: '',
      clearPassword: false,
    })
    draft.value = {
      obs: { A: obs('A'), B: obs('B') },
      sceneRoles: {
        A: { ...(current.sceneRoles.A ?? {}) },
        B: { ...(current.sceneRoles.B ?? {}) },
      },
      displayPort: String(current.displayPort),
      recordingRoot: current.recordingRoot ?? '',
      fileSlug: current.fileSlug ?? '',
      relaySourceRoomId: current.relaySourceRoomId ?? '',
      promptRecordingOnStart: current.promptRecordingOnStart !== false,
      promptRecordingOnStop: current.promptRecordingOnStop !== false,
      sceneOnStart: current.sceneOnStart ?? '',
    }
  }

  function show(motif: 'operateur' | 'demarrage' = 'operateur'): void {
    seed()
    notice.value = null
    ouvertAuDemarrage.value = motif === 'demarrage'
    open.value = true
  }

  /**
   * Ce qui manque pour que la salle soit pilotable.
   *
   * Deux lecteurs : le bandeau du panneau, et la vérification de démarrage qui
   * décide de l'ouvrir. Les deux disent la même chose, ce qui évite qu'un
   * panneau s'ouvre sur une raison qu'il n'affiche pas.
   *
   * Rien tant que le hub n'a pas rendu la configuration : une salle dont on ne
   * sait rien n'est pas une salle mal réglée.
   */
  const manques = computed<Manque[]>(() => {
    const current = config.value
    if (current == null) return []
    const diagnostics = room.payload?.diagnostics ?? null
    const liste: Manque[] = []

    for (const instance of ['A', 'B'] as const) {
      const quoi = instance === 'A' ? 'projection' : 'captation'
      const etat = diagnostics?.obs[instance] ?? null

      // L'adresse passe avant la connexion : « pas connecté » sur une instance
      // dont l'adresse est vide enverrait chercher du côté du réseau.
      if (current.obs[instance].url.trim() === '') {
        liste.push({
          code: `obs-${instance}-url`,
          texte: `Adresse d'OBS-${instance} (${quoi}) non renseignée.`,
        })
      } else if (etat?.connected !== true) {
        liste.push({
          code: `obs-${instance}`,
          texte: `OBS-${instance} (${quoi}) n'est pas connecté.`,
        })
      }

      // Un rôle configuré mais absent d'OBS échouera au milieu d'un talk, et
      // c'est ici qu'il se corrige. Vaut pour les deux instances.
      const introuvables = etat?.unresolvedRoles ?? []
      if (introuvables.length > 0) {
        liste.push({
          code: `roles-${instance}`,
          texte: `Rôles introuvables dans OBS-${instance} : ${introuvables.join(', ')}.`,
        })
      }
    }

    /*
     * Seulement OBS-A. La projection sans rôle mappé n'a aucun bouton : ni
     * direct, ni habillage. La captation, elle, s'enregistre très bien sans
     * qu'aucun rôle de scène soit associé — beaucoup de salles ne changent
     * jamais de plan pendant un talk, et les signaler serait un faux motif.
     */
    if (Object.keys(current.sceneRoles.A ?? {}).length === 0) {
      liste.push({ code: 'scenes-A', texte: "Aucune scène associée aux rôles d'OBS-A." })
    }

    if ((current.recordingRoot ?? '').trim() === '') {
      liste.push({
        code: 'vod',
        texte:
          'Dossier des VOD non renseigné : la régie le demande alors à OBS-B, et ' +
          "n'a plus rien à relire dès qu'il est éteint.",
      })
    }

    return liste
  })

  const verification = ref<'attente' | 'armee' | 'faite'>('attente')
  let arreterVeille: (() => void) | null = null

  function juger(): boolean {
    if (config.value == null) return false
    verification.value = 'faite'
    arreterVeille?.()
    arreterVeille = null
    if (manques.value.length > 0) show('demarrage')
    return true
  }

  /**
   * Ouvre la configuration au démarrage si la salle n'est pas prête.
   *
   * **Tout de suite**, dès que la machine est appairée et que le hub a rendu la
   * configuration : c'est le premier instant où le panneau a un sens, et
   * l'installation d'une salle se fait avant la première conférence, pas
   * pendant. Rien n'est différé — une salle mal réglée doit le dire à
   * l'ouverture de la fenêtre, quand quelqu'un est encore devant l'écran.
   *
   * Les lignes « OBS n'est pas connecté » peuvent disparaître seules quelques
   * secondes plus tard, le poste réessayant toutes les trois secondes : la liste
   * est un calcul sur l'état courant, elle se vide à mesure que les instances se
   * branchent, panneau ouvert.
   *
   * **Une seule fois par chargement de page.** Un panneau qui se rouvre après
   * qu'on l'a fermé n'est plus un rappel, c'est un obstacle : une salle sans
   * OBS-B branché reste pilotable pour tout le reste, et l'opérateur qui a lu
   * la liste doit pouvoir travailler.
   */
  function verifierAuDemarrage(): void {
    if (verification.value !== 'attente') return
    verification.value = 'armee'
    if (juger()) return
    // Le hub n'a pas encore rendu la configuration. On juge dès qu'elle
    // arrive : sinon une salle lente à synchroniser ne serait jamais examinée.
    arreterVeille = watch(config, () => void juger())
  }

  /** Ce que le formulaire dit, sous la forme attendue par le hub. */
  function patch(): Record<string, unknown> | null {
    const current = config.value
    const form = draft.value
    if (current == null || form == null) return null

    const point = (instance: ObsInstance): Record<string, unknown> => {
      const value: Record<string, unknown> = { url: form.obs[instance].url.trim() }
      if (form.obs[instance].clearPassword) value.password = null
      else if (form.obs[instance].password.length > 0) value.password = form.obs[instance].password
      return value
    }

    // On repart de l'existant : un rôle mappé hors des trois proposés ici ne
    // doit pas disparaître à l'enregistrement.
    const roles = (instance: ObsInstance): Record<string, string> => {
      const next: Record<string, string> = { ...(current.sceneRoles[instance] ?? {}) }
      for (const { role } of ROLES[instance]) {
        const value = form.sceneRoles[instance][role] ?? ''
        if (value === '') delete next[role]
        else next[role] = value
      }
      return next
    }

    const text = (value: string): string | null => (value.trim() === '' ? null : value.trim())

    return {
      obs: { A: point('A'), B: point('B') },
      sceneRoles: { A: roles('A'), B: roles('B') },
      displayPort: Number(form.displayPort) || current.displayPort,
      recordingRoot: text(form.recordingRoot),
      fileSlug: text(form.fileSlug),
      relaySourceRoomId: form.relaySourceRoomId === '' ? null : form.relaySourceRoomId,
      promptRecordingOnStart: form.promptRecordingOnStart,
      promptRecordingOnStop: form.promptRecordingOnStop,
      sceneOnStart: form.sceneOnStart === '' ? null : form.sceneOnStart,
    }
  }

  async function save(): Promise<void> {
    const body = patch()
    if (body == null) return
    saving.value = true
    notice.value = { text: 'Enregistrement…', tone: 'quiet' }
    const result = await actions.act({ action: 'room.configure', patch: body })
    saving.value = false
    notice.value = result.ok
      ? { text: 'Enregistré.', tone: 'ok' }
      : { text: result.message ?? 'Échec', tone: 'alerte' }
    // Repeuplé sur l'état qui revient du hub, pas sur ce qu'on vient de taper.
    if (result.ok) seed()
  }

  /**
   * Connecter une instance, réglages compris.
   *
   * Enregistrer d'abord : brancher sur l'ancienne adresse pendant que la
   * nouvelle est à l'écran donnerait une connexion réussie sur le mauvais OBS,
   * et rien pour le dire.
   */
  async function connect(instance: ObsInstance): Promise<void> {
    if (online.value) {
      const body = patch()
      if (body != null) {
        const saved = await actions.act({ action: 'room.configure', patch: body })
        if (!saved.ok) return
        seed()
      }
    }
    await actions.act({ action: 'obs.connect', instance })
  }

  async function refreshScenes(): Promise<void> {
    await actions.act({ action: 'obs.refreshScenes' })
  }

  /**
   * Le poste sait-il ouvrir un sélecteur de dossier ?
   *
   * La page ne peut pas le deviner : elle tourne aussi bien dans la fenêtre
   * Electron du poste que dans un navigateur ouvert à côté, et le même bundle
   * sert les deux. C'est le poste qui répond.
   */
  const peutParcourir = computed(() => config.value?.peutParcourir === true)

  /**
   * Ouvre le sélecteur du **poste** et remplit le champ du dossier des VOD.
   *
   * Un chemin de disque se saisit à la main sans erreur seulement quand on l'a
   * sous les yeux — et c'est le disque de la machine de salle qu'il désigne, où
   * qu'on lise cette page.
   *
   * **Rien n'est enregistré au passage** : c'est « Enregistrer » qui décide,
   * comme pour tout le reste du panneau. Un sélecteur qui écrirait dans la
   * foulée ferait d'un coup d'œil dans l'arborescence une modification de la
   * salle. Et renoncer laisse le champ tel quel : fermer un sélecteur est un
   * geste, pas une panne.
   */
  async function parcourir(): Promise<void> {
    const { detail } = await useActionsStore().act({ action: 'config.chooseFolder' }, { silent: true })
    if (typeof detail === 'string' && detail !== '' && draft.value != null) {
      draft.value.recordingRoot = detail
    }
  }

  return {
    open,
    draft,
    saving,
    notice,
    config,
    online,
    peutParcourir,
    manques,
    ouvertAuDemarrage,
    show,
    seed,
    patch,
    save,
    connect,
    refreshScenes,
    parcourir,
    verifierAuDemarrage,
  }
})
