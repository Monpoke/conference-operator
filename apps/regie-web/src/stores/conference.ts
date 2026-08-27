import { remaining, time } from '@cloudnord/format'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useActionsStore } from './actions.js'
import { useRoomStore } from './room.js'

/**
 * Au-delà, un démarrage cesse d'être « un peu en avance » et devient une erreur
 * de cible.
 *
 * Un quart d'heure : c'est le battement le plus large du programme, donc la
 * limite en deçà de laquelle lancer le talk suivant est un geste normal — on a
 * fini plus tôt, le speaker est branché, la salle est pleine. Au-delà, on vise
 * presque toujours autre chose que ce qu'on croit.
 */
export const TOO_EARLY_MS = 15 * 60_000

/**
 * Commencer et terminer, avec ce qui se met en travers.
 *
 * Trois questions, et leur ordre est le fond du sujet. Celle du démarrage très
 * en avance passe **avant** celle de l'enregistrement : la première porte sur
 * la conférence qu'on est en train de lancer, la seconde sur la manière de la
 * lancer. Les poser dans l'autre ordre ferait démarrer une captation pour un
 * talk qu'on va renoncer à lancer.
 *
 * Le flux vit dans un store et non dans le panneau parce que ce sont des
 * enchaînements, pas un rendu : « si l'enregistrement ne part pas, ne commence
 * pas » se relit et se vérifie ici, sans monter trois modales.
 */
export const useConferenceStore = defineStore('conference', () => {
  const room = useRoomStore()
  const actions = useActionsStore()

  const tooEarlyOpen = ref(false)
  const recordingOpen = ref(false)
  const endEarlyOpen = ref(false)

  const session = computed(() => room.payload?.state.targetSession ?? null)

  /**
   * Réglages du démarrage, défauts compris.
   *
   * Les défauts vivent dans le contrat, où le hub les applique. La page les
   * répète pour un état reçu avant ce réglage : lire un champ absent comme
   * « ne rien faire » désactiverait un garde-fou en silence, ce qui est
   * exactement ce qu'il est censé empêcher. Une valeur nulle, elle, reste un
   * choix explicite.
   */
  const settings = computed(() => {
    const config = room.payload?.diagnostics?.config
    return {
      warn: config?.promptRecordingOnStart !== false,
      scene: config?.sceneOnStart === undefined ? 'LIVE' : config.sceneOnStart,
    }
  })

  /** L'avance sur le créneau, ou `null` sans conférence à piloter. */
  const earlyByMs = computed(() =>
    session.value == null ? null : session.value.startsAtMs - room.now,
  )

  /** Ce qu'il reste au créneau, ou `null` sur un créneau sans heure de fin. */
  const leftMs = computed(() =>
    session.value?.endsAtMs == null ? null : session.value.endsAtMs - room.now,
  )

  const tooEarlyDetail = computed(() => {
    const target = session.value
    const early = earlyByMs.value
    if (target == null || early == null) return ''
    const at = time(target.startsAt, room.payload?.timezone)
    return (
      `« ${target.title} » est au programme à ${at}, dans ${remaining(early)}. ` +
      'La lancer maintenant l’inscrira comme tenue à cette heure-ci, ' +
      'dans le programme comme dans l’historique du hub.'
    )
  })

  const endEarlyDetail = computed(() => {
    const target = session.value
    const left = leftMs.value
    if (target == null || left == null) return ''
    return (
      `Il reste ${remaining(left)} au créneau de « ${target.title} ». ` +
      'La salle passera à « rien dans la salle », et les autres régies le verront. ' +
      '« Remettre à venir » annule, si c’est une erreur.'
    )
  })

  /** Premier garde-fou : vise-t-on bien cette conférence-là ? */
  function askStart(): void {
    const early = earlyByMs.value
    if (early == null || early <= TOO_EARLY_MS) {
      void start()
      return
    }
    tooEarlyOpen.value = true
  }

  /** Second garde-fou : la VOD, qui ne se rattrape pas le soir. */
  async function start(): Promise<void> {
    tooEarlyOpen.value = false
    const recording = room.payload?.diagnostics?.recording?.active === true
    if (settings.value.warn && !recording) {
      // La question n'a de sens qu'avant : une fois la conférence lancée,
      // l'enregistrement démarré manquera toujours les premières minutes.
      recordingOpen.value = true
      return
    }
    await launch(false)
  }

  /** @param record Lancer l'enregistrement d'abord, puis la conférence. */
  async function launch(record: boolean): Promise<void> {
    recordingOpen.value = false
    if (record) {
      const result = await actions.act({ action: 'recording.start' })
      // L'enregistrement d'abord, et seulement s'il part : commencer quand même
      // rendrait l'avertissement mensonger la prochaine fois.
      if (!result.ok) return
    }
    await actions.act({ action: 'session.start' })

    // Après le démarrage : la scène suit la conférence, et une bascule sans
    // conférence lancée laisserait la salle à l'antenne sur rien.
    const role = settings.value.scene
    if (role) await actions.act({ action: 'scene.set', role })
  }

  /**
   * Terminer, avec un garde-fou quand c'est en avance.
   *
   * En avance seulement : terminer à l'heure ou en dépassement est le geste
   * normal de la journée, et le confirmer à chaque fois en ferait un réflexe.
   * Un créneau sans heure de fin n'a pas d'avance possible — rien à demander.
   */
  function askEnd(): void {
    const left = leftMs.value
    if (left == null || left <= 0) {
      void actions.act({ action: 'session.end' })
      return
    }
    endEarlyOpen.value = true
  }

  async function end(): Promise<void> {
    endEarlyOpen.value = false
    await actions.act({ action: 'session.end' })
  }

  /** Remettre à venir, quand « Terminer » était une erreur. */
  async function reset(): Promise<void> {
    await actions.act({ action: 'session.reset' })
  }

  return {
    tooEarlyOpen,
    recordingOpen,
    endEarlyOpen,
    settings,
    earlyByMs,
    leftMs,
    tooEarlyDetail,
    endEarlyDetail,
    askStart,
    start,
    launch,
    askEnd,
    end,
    reset,
  }
})
