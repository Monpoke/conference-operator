import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commandSchema, type Command, type CommandPayloadInput } from '@cloudnord/contract'
import { normalizeProgram } from '@cloudnord/program'
import { LocalStore } from '../src/core/store.js'
import { RoomRuntime } from '../src/core/runtime.js'

const program = normalizeProgram(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
      'utf8',
    ),
  ),
)

const TRACK_1 = 'track-1-teilhard-de-chardin'
const ISSUED_AT = '2026-10-30T10:20:00.000+00:00'

let store: LocalStore
let clockMs: number

beforeEach(() => {
  store = new LocalStore(':memory:')
  clockMs = Date.parse(ISSUED_AT)
})

function makeRuntime(effects = {}) {
  const runtime = new RoomRuntime(store, effects, () => clockMs)
  runtime.setRoomId(TRACK_1)
  runtime.setProgram('hash-1', program)
  return runtime
}

let nextSeq = 0
const command = (payload: CommandPayloadInput, ttlSeconds: number | null = null): Command => {
  nextSeq += 1
  return commandSchema.parse({ seq: nextSeq, issuedAt: ISSUED_AT, ttlSeconds, payload })
}

describe('état de la salle', () => {
  it('positionne la session en cours et la suivante depuis le programme', () => {
    const runtime = makeRuntime()
    const state = runtime.state()
    // 10:20 UTC : « HoneySwamp » court de 10:00 à 10:50.
    expect(state.currentSession?.title).toContain('HoneySwamp')
    expect(state.nextSession?.title).toContain('Coupable')
  })

  it('démarre sur les sponsors, sans dépendre du réseau', () => {
    expect(new RoomRuntime(store, {}, () => clockMs).state()).toMatchObject({
      mode: 'sponsors',
      connectivity: 'OFFLINE',
    })
  })

  it('corrige l\'horloge avec l\'offset serveur', () => {
    const runtime = makeRuntime()
    // Le PC de régie retarde de 40 minutes : sans correction, l'écran
    // annoncerait encore le talk précédent (10:20 → HoneySwamp au lieu de 11:00).
    expect(runtime.state().currentSession?.title).toContain('HoneySwamp')
    runtime.setClockOffset(40 * 60_000)
    runtime.refreshSessions()
    expect(runtime.state().currentSession?.title).toContain('Coupable')
    // L'offset est persisté : un redémarrage ne le reperd pas.
    expect(store.settings().clockOffsetMs).toBe(2_400_000)
  })
})

describe('application des commandes', () => {
  it('bascule la scène OBS demandée', async () => {
    const setSceneRole = vi.fn(async () => {})
    const runtime = makeRuntime({ setSceneRole })

    const outcome = await runtime.applyCommand(command({ type: 'scene.force', role: 'LIVE' }))
    expect(outcome).toEqual({ applied: true })
    expect(setSceneRole).toHaveBeenCalledWith('LIVE')
    expect(runtime.state().sceneRole).toBe('LIVE')
  })

  it('affiche en salle un message destiné au public', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command(
        { type: 'message.broadcast', text: 'Évacuation', level: 'urgent', target: 'audience' },
        600,
      ),
    )
    expect(runtime.state()).toMatchObject({
      mode: 'message',
      message: { text: 'Évacuation', level: 'urgent' },
    })
    // La régie est prévenue de ce qui est projeté chez elle.
    expect(runtime.state().notifications.at(-1)?.text).toContain('Affiché en salle')
  })

  it('garde pour l\'opérateur un message qui lui est adressé', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command({
        type: 'message.broadcast',
        text: 'Ton speaker est arrivé',
        level: 'info',
        target: 'operator',
        from: 'organisateur@cloudnord.fr',
      }),
    )

    // Basculer l'écran l'afficherait en grand devant le public.
    expect(runtime.state().mode).toBe('sponsors')
    expect(runtime.state().message).toBeNull()
    expect(runtime.state().notifications.at(-1)?.text).toContain('Ton speaker est arrivé')
    expect(runtime.state().notifications.at(-1)?.text).toContain('organisateur@cloudnord.fr')
  })

  it('écarte une commande rattrapée après expiration', async () => {
    const runtime = makeRuntime()
    const lunch = command({ type: 'message.broadcast', text: 'Pause déjeuner', level: 'info' }, 600)

    // Reconnexion 40 minutes plus tard : le message n'a plus lieu d'être.
    clockMs += 40 * 60_000
    const outcome = await runtime.applyCommand(lunch)

    expect(outcome).toEqual({ applied: false, reason: 'expired' })
    expect(runtime.state().mode).toBe('sponsors')
    // Marquée appliquée malgré tout, sinon chaque reconnexion la relivrerait.
    expect(store.hasApplied(lunch.seq)).toBe(true)
  })

  it('ignore un rejeu de commande déjà appliquée', async () => {
    const setSceneRole = vi.fn(async () => {})
    const runtime = makeRuntime({ setSceneRole })
    const forced = command({ type: 'scene.force', role: 'HOLD' })

    await runtime.applyCommand(forced)
    const replay = await runtime.applyCommand(forced)

    expect(replay).toEqual({ applied: false, reason: 'already-applied' })
    expect(setSceneRole).toHaveBeenCalledTimes(1)
  })

  it('déclenche une resynchronisation sur invalidation du programme', async () => {
    const resync = vi.fn()
    const runtime = makeRuntime({ resync })
    await runtime.applyCommand(command({ type: 'program.invalidate', contentHash: 'hash-2' }))
    expect(resync).toHaveBeenCalledWith('hash-2')
  })

  it('ne boucle pas sur une commande pas encore supportée', async () => {
    const runtime = makeRuntime()
    const later = command({ type: 'wall.approved', commentId: 'c-1' })

    expect(await runtime.applyCommand(later)).toEqual({ applied: false, reason: 'unsupported' })
    // Sans marquage, la reconnexion suivante la relivrerait indéfiniment.
    expect(store.hasApplied(later.seq)).toBe(true)
    expect(await runtime.applyCommand(later)).toEqual({ applied: false, reason: 'already-applied' })
  })

  it('retire le message quand son TTL est écoulé', async () => {
    const runtime = makeRuntime()
    await runtime.applyCommand(
      command(
        { type: 'message.broadcast', text: 'Reprise dans 5 min', level: 'info', target: 'audience' },
        300,
      ),
    )
    expect(runtime.state().mode).toBe('message')

    clockMs += 301_000
    runtime.expireMessage()
    expect(runtime.state()).toMatchObject({ mode: 'sponsors', message: null })
  })
})

describe('état observé sur OBS', () => {
  it('fait foi sur l\'état local', () => {
    const runtime = makeRuntime()
    const seen: string[] = []
    runtime.on('state', (state) => seen.push(String(state.sceneRole)))

    // L'opérateur a basculé dans OBS directement : la régie doit suivre.
    runtime.observeSceneRole('LIVE')
    expect(runtime.state().sceneRole).toBe('LIVE')
    expect(seen).toContain('LIVE')
  })
})

describe('conférence pilotable', () => {
  /** Décale l'horloge du runtime à un instant donné (UTC). */
  const a = (iso: string) => {
    clockMs = Date.parse(iso)
    return makeRuntime()
  }

  it('vise la conférence en cours quand il y en a une', () => {
    // 10:20 UTC = 11:20 à Paris, en plein « HoneySwamp ».
    const runtime = a('2026-10-30T10:20:00Z')
    expect(runtime.state().targetSession?.title).toContain('HoneySwamp')
    expect(runtime.state().targetIsUpcoming).toBe(false)
  })

  it('vise la suivante dans un inter-créneau', () => {
    /**
     * Le cas signalé : 14:50 à Paris, soit 13:50 UTC. « Platform Engineering »
     * vient de finir, « Blind ops » commence à 14:55. Rien n'est en cours —
     * et c'est justement le moment où l'opérateur veut démarrer.
     */
    const runtime = a('2026-10-30T13:50:00Z')
    expect(runtime.state().currentSession).toBeNull()
    expect(runtime.state().targetSession?.title).toContain('Blind ops')
    expect(runtime.state().targetIsUpcoming).toBe(true)
  })

  it('vise le talk suivant pendant une pause', () => {
    // 14:20 UTC = 15:20 à Paris, en pleine « Pause café ».
    const runtime = a('2026-10-30T14:20:00Z')
    expect(runtime.state().currentSession?.kind).toBe('break')
    // Une pause ne se « démarre » pas : ce qu'on pilote, c'est le talk qui suit.
    expect(runtime.state().targetSession?.kind).toBe('talk')
    expect(runtime.state().targetSession?.title).toContain('DevEx')
  })

  it("n'a plus de cible après le dernier talk", () => {
    const runtime = a('2026-10-31T12:00:00Z')
    expect(runtime.state().targetSession).toBeNull()
  })
})
