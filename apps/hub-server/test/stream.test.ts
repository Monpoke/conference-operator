import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { room } from '@conference-operator/db/hub'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { RoomService } from '../src/services/rooms.js'
import { createSecretBox } from '../src/secrets.js'
import { testSecrets } from './helpers/secrets.js'

/**
 * Where a room streams.
 *
 * The setting is entered once, on the hub, and comes back down to its room at
 * every `sync`. Four things hold this feature up, and each is the answer to a
 * way of getting it wrong:
 *
 *  - the key is **encrypted** in the column, and above all never lands in
 *    `config_json`, which is the one place it would have leaked into every log
 *    and every console view at once;
 *  - **half a setting is no setting**: a server with no key lights a "Diffuser"
 *    that fails at the moment the talk starts;
 *  - **absent is not empty** on the way in: correcting a typo in the address
 *    must not wipe the key, which the console does not hold and cannot resend;
 *  - a **rotated hub secret** makes the keys unreadable, and the hub must then
 *    say "no key" rather than hand OBS a corpse.
 */

const TRACK_1 = 'track-1-teilhard-de-chardin'
const TRACK_2 = 'track-2-marie-fourcade'

let db: HubDatabase
beforeEach(() => {
  db = openHubDatabase(':memory:').orm
})

function seed(rooms: RoomService, id: string, name: string): void {
  rooms.upsert({
    id,
    name,
    trackId: id,
    obs: {
      A: { url: 'ws://127.0.0.1:4455', password: null },
      B: { url: 'ws://127.0.0.1:4456', password: null },
    },
    sceneRoles: { A: { LIVE: 'Capture' }, B: { TALK: 'Talk' } },
  })
}

describe('secret box', () => {
  it('reads back what it sealed, and nothing else can', () => {
    const mine = createSecretBox('secret-du-hub-assez-long-pour-hkdf')
    const sealed = mine.seal('cle-rtmp-tres-secrete')

    expect(sealed).not.toContain('cle-rtmp-tres-secrete')
    expect(mine.open(sealed)).toBe('cle-rtmp-tres-secrete')

    // Another hub — a restore onto a different deployment — reads nothing.
    const other = createSecretBox('un-tout-autre-secret-assez-long-aussi')
    expect(other.open(sealed)).toBeNull()
  })

  it('does not reuse its nonce', () => {
    // Two rooms on the same streaming platform very often share a key prefix,
    // and GCM under a repeated nonce surrenders both plaintexts at once.
    const box = createSecretBox('secret-du-hub-assez-long-pour-hkdf')
    expect(box.seal('meme-cle')).not.toBe(box.seal('meme-cle'))
  })

  it('returns null on a truncated or foreign ciphertext instead of throwing', () => {
    // This value is read on the `sync` path: an exception here would take down
    // the room's synchronization, not just its stream.
    const box = createSecretBox('secret-du-hub-assez-long-pour-hkdf')
    expect(box.open('n-importe-quoi')).toBeNull()
    expect(box.open('v1.aaaa.bbbb.cccc')).toBeNull()
    expect(box.open(box.seal('cle').slice(0, -4))).toBeNull()
  })
})

describe('RoomService — diffusion', () => {
  it('keeps the key out of `config_json`, and encrypted in its own column', () => {
    const rooms = new RoomService(db, testSecrets)
    seed(rooms, TRACK_1, 'Track #1')

    rooms.setStream({
      roomId: TRACK_1,
      rtmpUrl: 'rtmp://live.exemple.fr/app',
      streamKey: 'cle-tres-secrete',
    })

    const row = db.select().from(room).where(eq(room.id, TRACK_1)).get()
    expect(row?.configJson).not.toContain('cle-tres-secrete')
    expect(row?.streamKeyEnc).not.toContain('cle-tres-secrete')
    expect(row?.streamRtmpUrl).toBe('rtmp://live.exemple.fr/app')
    // And it is genuinely readable again, not merely written.
    expect(rooms.streamOf(TRACK_1)).toEqual({
      rtmpUrl: 'rtmp://live.exemple.fr/app',
      streamKey: 'cle-tres-secrete',
    })
  })

  it('never lets the key back out through the configuration', () => {
    const rooms = new RoomService(db, testSecrets)
    seed(rooms, TRACK_1, 'Track #1')
    rooms.setStream({ roomId: TRACK_1, rtmpUrl: 'rtmp://live/app', streamKey: 'cle' })

    // `get` and `list` feed the console and the logs. `streamOf` is the one way
    // to the real value, and the `sync` handler is its one caller.
    expect(rooms.get(TRACK_1)?.stream).toBeNull()
    expect(rooms.list()[0]?.stream).toBeNull()
    expect(rooms.streams()).toEqual([
      { roomId: TRACK_1, name: 'Track #1', rtmpUrl: 'rtmp://live/app', hasKey: true },
    ])
  })

  it('serves nothing at all when only half the setting is there', () => {
    const rooms = new RoomService(db, testSecrets)
    seed(rooms, TRACK_1, 'Track #1')

    // A server, no key: the console must say so, and the room must not offer
    // a button that would fail on the click.
    rooms.setStream({ roomId: TRACK_1, rtmpUrl: 'rtmp://live/app' })
    expect(rooms.streams()[0]).toMatchObject({ rtmpUrl: 'rtmp://live/app', hasKey: false })
    expect(rooms.streamOf(TRACK_1)).toBeNull()

    // A key, no server: the mirror image, and just as unusable.
    rooms.setStream({ roomId: TRACK_1, rtmpUrl: '', streamKey: 'cle' })
    expect(rooms.streams()[0]).toMatchObject({ rtmpUrl: '', hasKey: true })
    expect(rooms.streamOf(TRACK_1)).toBeNull()
  })

  it('leaves the key alone when the patch says nothing about it', () => {
    // The console does not hold the key, so it cannot resend it to preserve it.
    // Without this rule, fixing a typo in the address would silently unstream the
    // room — and nothing on the page would say so.
    const rooms = new RoomService(db, testSecrets)
    seed(rooms, TRACK_1, 'Track #1')
    rooms.setStream({ roomId: TRACK_1, rtmpUrl: 'rtmp://ancien/app', streamKey: 'cle' })

    rooms.setStream({ roomId: TRACK_1, rtmpUrl: 'rtmp://nouveau/app' })

    expect(rooms.streamOf(TRACK_1)).toEqual({
      rtmpUrl: 'rtmp://nouveau/app',
      streamKey: 'cle',
    })
  })

  it('erases the key when asked explicitly, and only then', () => {
    const rooms = new RoomService(db, testSecrets)
    seed(rooms, TRACK_1, 'Track #1')
    rooms.setStream({ roomId: TRACK_1, rtmpUrl: 'rtmp://live/app', streamKey: 'cle' })

    rooms.setStream({ roomId: TRACK_1, rtmpUrl: '', streamKey: null })

    expect(rooms.streams()[0]).toEqual({
      roomId: TRACK_1,
      name: 'Track #1',
      rtmpUrl: '',
      hasKey: false,
    })
    expect(rooms.streamOf(TRACK_1)).toBeNull()
  })

  it('does not mix up two rooms', () => {
    const rooms = new RoomService(db, testSecrets)
    seed(rooms, TRACK_1, 'Track #1')
    seed(rooms, TRACK_2, 'Track #2')

    rooms.setStream({ roomId: TRACK_1, rtmpUrl: 'rtmp://live/un', streamKey: 'cle-un' })
    rooms.setStream({ roomId: TRACK_2, rtmpUrl: 'rtmp://live/deux', streamKey: 'cle-deux' })

    expect(rooms.streamOf(TRACK_1)?.streamKey).toBe('cle-un')
    expect(rooms.streamOf(TRACK_2)?.streamKey).toBe('cle-deux')
  })

  it('reports no key once the hub secret has been rotated', () => {
    /*
     * The day `BETTER_AUTH_SECRET` changes, every stored key becomes unreadable.
     * The hub must read back empty rather than start refusing to serve: the
     * console shows an empty field, the operator retypes the key, and the event
     * carries on. Announcing `hasKey: true` over a key nothing can decrypt would
     * leave someone hunting a stream that was never going to start.
     */
    const rooms = new RoomService(db, testSecrets)
    seed(rooms, TRACK_1, 'Track #1')
    rooms.setStream({ roomId: TRACK_1, rtmpUrl: 'rtmp://live/app', streamKey: 'cle' })

    const rotated = new RoomService(db, createSecretBox('le-hub-a-change-de-secret-entre-temps'))

    expect(rotated.streams()[0]).toMatchObject({ rtmpUrl: 'rtmp://live/app', hasKey: false })
    expect(rotated.streamOf(TRACK_1)).toBeNull()
  })

  it('does not invent a room', () => {
    const rooms = new RoomService(db, testSecrets)
    expect(rooms.setStream({ roomId: 'salle-inconnue', rtmpUrl: 'rtmp://live/app' })).toBeNull()
    expect(rooms.streamOf('salle-inconnue')).toBeNull()
  })

  it('survives a configuration round trip without leaking the key into the JSON', () => {
    /*
     * The trap this closes: `rooms.configure` reads the config, merges a patch
     * and writes it back. If that config had come from a `sync` — where `stream`
     * is filled in — the key would land in `config_json` in clear, and from
     * there into `rooms.list`, the console, and every log line that prints a
     * room. `served` and `upsert` blank the field at both ends.
     */
    const rooms = new RoomService(db, testSecrets)
    seed(rooms, TRACK_1, 'Track #1')
    rooms.setStream({ roomId: TRACK_1, rtmpUrl: 'rtmp://live/app', streamKey: 'cle-secrete' })

    const asSynced = { ...rooms.get(TRACK_1)!, stream: rooms.streamOf(TRACK_1) }
    rooms.upsert({ ...asSynced, displayPort: 7999 })

    const row = db.select().from(room).where(eq(room.id, TRACK_1)).get()
    expect(row?.configJson).not.toContain('cle-secrete')
    // And the real setting is untouched: the columns were never in play.
    expect(rooms.get(TRACK_1)?.displayPort).toBe(7999)
    expect(rooms.streamOf(TRACK_1)?.streamKey).toBe('cle-secrete')
  })
})
