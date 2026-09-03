import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useClockStore } from '../src/stores/clock.js'
import { STREAM_DEAD_MS, useRoomStore, type StateStream } from '../src/stores/room.js'
import { payload } from './fixtures.js'

/**
 * Le flux d'état, et la seule panne que la page ait à diagnostiquer elle-même.
 *
 * `EventSource` se reconnecte tout seul et ne lève rien : un poste de salle
 * redémarré sous une fenêtre ouverte laisse cette fenêtre vivante en apparence
 * — l'horloge tourne, le compte à rebours descend — et figée en fait. C'est
 * exactement ce qu'on ne peut pas voir depuis la salle.
 */

/** Un flux qu'on ouvre, coupe et rouvre à la main. */
function fakeStream(): StateStream & {
  emit: (data: unknown) => void
  emitDelta: (data: unknown) => void
  fail: () => void
  reopen: () => void
  closed: boolean
} {
  const listeners = new Map<string, (event: MessageEvent) => void>()
  const stream = {
    onopen: null as ((event: Event) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    closed: false,
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      listeners.set(type, listener)
    },
    close() {
      stream.closed = true
    },
    emit(data: unknown) {
      stream.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
    },
    emitDelta(data: unknown) {
      listeners.get('delta')?.({ data: JSON.stringify(data) } as MessageEvent)
    },
    fail() {
      stream.onerror?.(new Event('error'))
    },
    reopen() {
      stream.onopen?.(new Event('open'))
    },
  }
  return stream
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('état de la salle', () => {
  it('part de l’état embarqué dans la coquille, avant tout octet du flux', () => {
    const room = useRoomStore()
    room.seed(payload({ roomName: 'Track #2' }))

    // Un F5 arrive presque toujours au pire moment : la fenêtre a gelé, et
    // c'est en plein talk. Attendre le flux donnerait un écran vide là.
    expect(room.payload?.roomName).toBe('Track #2')
  })

  it('remplace tout sur un instantané, fusionne sur un delta', () => {
    const room = useRoomStore()
    const stream = fakeStream()
    room.connect(() => stream)

    stream.emit(payload({ roomName: 'Track #1' }))
    stream.emitDelta({ roomName: 'Track #7' })

    expect(room.payload?.roomName).toBe('Track #7')
    // Le delta ne portait que le nom : le reste doit avoir survécu.
    expect(room.payload?.state.roomId).toBe('track-1')
  })

  it('ignore un delta arrivé avant tout instantané', () => {
    const room = useRoomStore()
    const stream = fakeStream()
    room.connect(() => stream)

    stream.emitDelta({ roomName: 'Track #7' })

    // Un delta seul décrit une salle dont on ne connaît pas le reste. Le
    // peindre à moitié serait pire que d'attendre l'instantané, qui suit de
    // toute façon toute reconnexion.
    expect(room.payload).toBe(null)
  })
})

describe('flux mort', () => {
  it('ne crie pas sur une reconnexion d’une seconde', () => {
    const clock = useClockStore()
    const room = useRoomStore()
    const stream = fakeStream()
    room.connect(() => stream)

    stream.fail()
    clock.advance(1000)

    expect(room.dead).toBe(false)
  })

  it('le dit passé le délai de grâce', () => {
    const clock = useClockStore()
    const room = useRoomStore()
    const stream = fakeStream()
    room.connect(() => stream)

    stream.fail()
    clock.advance(STREAM_DEAD_MS + 1000)

    expect(room.dead).toBe(true)
  })

  it('se tait dès qu’un message repasse, sans attendre la réouverture', () => {
    const clock = useClockStore()
    const room = useRoomStore()
    const stream = fakeStream()
    room.connect(() => stream)

    stream.fail()
    clock.advance(STREAM_DEAD_MS + 1000)
    stream.emit(payload())

    expect(room.dead).toBe(false)
  })

  it('ne compte pas deux coupures pour une', () => {
    const clock = useClockStore()
    const room = useRoomStore()
    const stream = fakeStream()
    room.connect(() => stream)

    stream.fail()
    clock.advance(3000)
    // `onerror` repart à chaque tentative de reconnexion : redémarrer le
    // décompte à chacune repousserait l'avertissement indéfiniment sur une
    // machine éteinte, ce qui est précisément le cas qu'il doit couvrir.
    stream.fail()
    clock.advance(2000)

    expect(room.dead).toBe(true)
  })

  it('repart à zéro après une vraie réouverture', () => {
    const clock = useClockStore()
    const room = useRoomStore()
    const stream = fakeStream()
    room.connect(() => stream)

    stream.fail()
    clock.advance(STREAM_DEAD_MS + 1000)
    stream.reopen()

    expect(room.dead).toBe(false)
  })
})

describe('heure de la salle', () => {
  it('porte le décalage du hub, pas l’heure du poste', () => {
    const clock = useClockStore()
    const room = useRoomStore()
    room.seed(payload({ state: { ...payload().state, serverTimeOffsetMs: 3_600_000 } }))

    // Le décalage est ce qui explique un compte à rebours qui ne colle pas à la
    // montre de l'opérateur — il ne peut donc pas être perdu en route.
    expect(room.now).toBe(clock.real + 3_600_000)
  })
})

describe('ouverture', () => {
  it('n’ouvre qu’un flux, même appelé deux fois', () => {
    const room = useRoomStore()
    const streams: StateStream[] = []
    const open = (): StateStream => {
      const stream = fakeStream()
      streams.push(stream)
      return stream
    }

    room.connect(open)
    room.connect(open)

    expect(streams).toHaveLength(1)
  })
})
