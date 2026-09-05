import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openHubDatabase, type HubDatabase } from '../src/db.js'
import { PushService } from '../src/services/push.js'
import { SupervisionWatch } from '../src/supervision.js'
import type { RoomStatus } from '@conference-operator/contract'

/**
 * Notifications pushed to closed consoles.
 *
 * What sets them apart from in-page notifications: nobody is watching any more.
 * The hub must therefore notice by itself what changes, and push only that — a
 * repeated notice gets notifications switched off for good.
 *
 * `technique`, `exploitation`, `essentiel` and `tout` are contract values: they
 * do not get renamed.
 */

/** A subscription that wants everything: the basis for the sending tests. */
const EVERYTHING = { technique: 'tout', exploitation: 'tout' } as const

const ROOM = (patch: Partial<RoomStatus> = {}): RoomStatus =>
  ({
    roomId: 'track-1',
    name: 'Track #1',
    connectivity: 'ONLINE',
    lastSeenAt: new Date().toISOString(),
    sceneRole: 'LIVE',
    currentSessionId: null,
    recording: false,
    streaming: false,
    outboxDepth: 0,
    programContentHash: 'h',
    currentSession: null,
    conference: 'en-cours',
    ...patch,
  }) as RoomStatus

describe('supervision watch', () => {
  it('says nothing on the first pass', () => {
    const watch = new SupervisionWatch()

    // Starting the hub on a room that is already down is not an event: it is a
    // state, and three notices at boot would make the following ones invisible.
    expect(watch.pass([ROOM({ connectivity: 'OFFLINE', conference: 'depassement' })])).toEqual([])
  })

  it('reports a room going down, then coming back', () => {
    const watch = new SupervisionWatch()
    watch.pass([ROOM()])

    const drop = watch.pass([ROOM({ connectivity: 'OFFLINE' })])
    expect(drop.map((notice) => notice.title)).toEqual(['Track #1 ne répond plus'])

    const back = watch.pass([ROOM()])
    expect(back.map((notice) => notice.title)).toEqual(['Track #1 est revenue'])
  })

  it('reports an overrun only once', () => {
    const watch = new SupervisionWatch()
    watch.pass([ROOM()])

    expect(watch.pass([ROOM({ conference: 'depassement' })])).toHaveLength(1)
    // Repeating would get notifications switched off within two minutes, and
    // nobody switches them back on.
    expect(watch.pass([ROOM({ conference: 'depassement' })])).toEqual([])
  })

  it('announces the machines arriving in the queue, not those already there', () => {
    const watch = new SupervisionWatch()
    watch.pass([ROOM()], [{ clientId: 'machine-a' }])

    expect(watch.pass([ROOM()], [{ clientId: 'machine-a' }])).toEqual([])
    const arrival = watch.pass([ROOM()], [{ clientId: 'machine-a' }, { clientId: 'machine-b' }])
    expect(arrival.map((notice) => notice.tag)).toEqual(['appairage'])
  })

  it('announces start and end from the lifecycle, not from the colour', () => {
    /**
     * A talk that ends on time goes straight from "running" to "none": deriving
     * the end from the aggregated state would have missed it.
     */
    const watch = new SupervisionWatch()
    const titles = (id: string) => (id === 'ses-1' ? 'HoneySwamp' : null)
    watch.pass([ROOM()], [], { 'track-1': { 'ses-1': 'scheduled' } }, titles)

    const start = watch.pass([ROOM()], [], { 'track-1': { 'ses-1': 'running' } }, titles)
    expect(start.map((notice) => [notice.title, notice.body, notice.level])).toEqual([
      ["Track #1 · c'est parti", 'HoneySwamp', 'tout'],
    ])

    const end = watch.pass([ROOM()], [], { 'track-1': { 'ses-1': 'ended' } }, titles)
    expect(end.map((notice) => notice.title)).toEqual(['Track #1 · terminé'])
  })

  it('keeps the machine tags apart from the run-of-day tags', () => {
    // A "we're off" must never come and erase a "no longer responding" left
    // unread on a lock screen.
    const watch = new SupervisionWatch()
    watch.pass([ROOM()], [], { 'track-1': { 'ses-1': 'scheduled' } })

    const notices = watch.pass(
      [ROOM({ connectivity: 'OFFLINE' })],
      [],
      { 'track-1': { 'ses-1': 'running' } },
    )
    const tags = notices.map((one) => one.tag)
    expect(new Set(tags).size).toBe(tags.length)
    expect(tags).toContain('salle-track-1')
    expect(tags).toContain('conf-track-1')
  })

  it('files every notice under its family and its level', () => {
    const watch = new SupervisionWatch()
    watch.pass([ROOM()])

    const classify = (notices: { family: string; level: string }[]) =>
      notices.map((one) => [one.family, one.level])

    expect(classify(watch.pass([ROOM({ connectivity: 'OFFLINE' })]))).toEqual([
      ['technique', 'essentiel'],
    ])
    // A relief, not a decision.
    expect(classify(watch.pass([ROOM()]))).toEqual([['technique', 'tout']])
    expect(classify(watch.pass([ROOM({ conference: 'fin-proche' })]))).toEqual([
      ['exploitation', 'tout'],
    ])
  })

  it('forgets a room removed from the program', () => {
    const watch = new SupervisionWatch()
    watch.pass([ROOM({ connectivity: 'OFFLINE' })])
    watch.pass([])

    // Without that forgetting, its return would read as a change of state when it
    // is a room being rediscovered.
    expect(watch.pass([ROOM()])).toEqual([])
  })
})

describe('subscriptions', () => {
  let db: HubDatabase
  let sqlite: Database.Database

  beforeEach(() => {
    const opened = openHubDatabase(':memory:')
    db = opened.orm
    sqlite = opened.sqlite
  })

  afterEach(() => {
    sqlite.close()
  })

  it('makes a key pair and keeps it across two starts', () => {
    const first = new PushService(db)
    const key = first.publicKey()
    expect(key).toBeTruthy()

    // Keys changing on every restart would invalidate every subscription, and
    // nobody subscribes twice.
    expect(new PushService(db).publicKey()).toBe(key)
  })

  it('prefers the keys from the configuration', async () => {
    const webpush = (await import('web-push')).default
    const pair = webpush.generateVAPIDKeys()

    const service = new PushService(db, { ...pair, subject: 'mailto:ops@cloudnord.fr' })
    expect(service.publicKey()).toBe(pair.publicKey)
  })

  it('switches push off on an unreadable key, without stopping the hub', () => {
    // A badly copied `.env` line must not condemn the event: push is a
    // supervision comfort, not the heart of the system.
    const service = new PushService(db, {
      publicKey: 'not-a-key',
      privateKey: 'not-a-key-either',
      subject: 'mailto:ops@cloudnord.fr',
    })

    expect(service.publicKey()).toBeNull()
    expect(service.unavailableReason()).toContain('VAPID')
  })

  it('replaces a subscription instead of doubling it', () => {
    const service = new PushService(db)
    const subscription = {
      endpoint: 'https://push.exemple/abc',
      p256dh: 'cle',
      auth: 'secret',
      userId: 'op-1',
      label: 'iPhone',
      levels: EVERYTHING,
    }
    service.subscribe(subscription)
    // The browser returns the same endpoint after a reinstall: a duplicate would
    // send every notice twice.
    service.subscribe({ ...subscription, label: 'iPhone de la régie' })

    expect(service.count()).toBe(1)
  })

  it('does not push beyond the chosen level', async () => {
    const service = new PushService(db)
    service.subscribe({
      endpoint: 'https://push.exemple/essentiel',
      p256dh: 'cle',
      auth: 'secret',
      userId: null,
      label: 'téléphone en poche',
      levels: { technique: 'essentiel', exploitation: 'essentiel' },
    })

    const webpush = (await import('web-push')).default
    const sent = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({} as never)

    await service.send({ title: 'rythme', body: '', tag: 't', family: 'exploitation', level: 'tout' })
    // The day's rhythm does not wake a phone set to the essentials.
    expect(sent).not.toHaveBeenCalled()

    await service.send({ title: 'écart', body: '', tag: 't', family: 'exploitation', level: 'essentiel' })
    expect(sent).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it('forgets a subscription the push service has revoked', async () => {
    const service = new PushService(db)
    service.subscribe({
      endpoint: 'https://push.exemple/mort',
      p256dh: 'cle',
      auth: 'secret',
      userId: null,
      label: null,
      levels: EVERYTHING,
    })

    const webpush = (await import('web-push')).default
    // 410 Gone: the browser has uninstalled the page or revoked the permission.
    vi.spyOn(webpush, 'sendNotification').mockRejectedValue(
      Object.assign(new Error('Gone'), { statusCode: 410 }),
    )

    await service.send({ title: 'x', body: 'y', tag: 'z', family: 'technique', level: 'essentiel' })
    expect(service.count()).toBe(0)
    vi.restoreAllMocks()
  })

  it('keeps a subscription after a transient failure', async () => {
    const service = new PushService(db)
    service.subscribe({
      endpoint: 'https://push.exemple/vivant',
      p256dh: 'cle',
      auth: 'secret',
      userId: null,
      label: null,
      levels: EVERYTHING,
    })

    const webpush = (await import('web-push')).default
    vi.spyOn(webpush, 'sendNotification').mockRejectedValue(
      Object.assign(new Error('timeout'), { statusCode: 502 }),
    )

    await service.send({ title: 'x', body: 'y', tag: 'z', family: 'technique', level: 'essentiel' })
    // Network or quota: the subscription is still good, and the next notice will
    // go through.
    expect(service.count()).toBe(1)
    vi.restoreAllMocks()
  })
})
