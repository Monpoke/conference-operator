import type { MontageJobView } from '@conference-operator/contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { redactSecrets } from '../src/router.js'
import { createHub, type Hub } from '../src/server.js'
import { videosDuPartage } from '../src/services/partages.js'

const job = (id: string, sessionId: string, take: string, state: string, outputKey: string | null = 'k') =>
  ({ id, sessionId, sidecarUploadId: take, state, outputKey }) as MontageJobView

describe('the videos of a shared page', () => {
  const jobs = [
    job('recent', 'a', 'prise-1', 'en-cours', null),
    job('ancien', 'a', 'prise-1', 'termine'),
    job('fini', 'a', 'prise-2', 'termine'),
    job('autre', 'b', 'prise-3', 'termine'),
    job('refuse', 'c', 'prise-4', 'termine'),
  ]

  it('opens the whole edition, a take being judged on its latest edit, and never a refused talk', () => {
    expect(videosDuPartage(null, jobs, new Set(['c'])).map((video) => video.id).sort()).toEqual(['autre', 'fini'])
  })

  it('opens only its own talk', () => {
    expect(videosDuPartage('b', jobs, new Set()).map((video) => video.id)).toEqual(['autre'])
  })

  it('keeps the password out of the log', () => {
    expect(redactSecrets({ sessionId: null, motDePasse: 'secret-123' })).toEqual({ sessionId: null, motDePasse: '•••' })
  })
})

describe('a shared page, over HTTP', () => {
  let hub: Hub
  let origin: string

  beforeEach(async () => {
    hub = await createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: ':memory:',
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
    })
    await hub.app.listen({ port: 0, host: '127.0.0.1' })
    const address = hub.app.server.address()
    origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`
  })

  afterEach(async () => {
    await hub.close()
  })

  const post = (id: string, motDePasse: string) =>
    fetch(`${origin}/partage/${id}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ motDePasse }),
    })

  it('asks for the password, refuses a wrong one, opens with the right one and closes once removed', async () => {
    const { id } = hub.services.partages.create({ sessionId: null, motDePasse: 'bon-mot-de-passe', createdBy: null }, () => null)

    const asked = await fetch(`${origin}/partage/${id}`)
    expect(asked.status).toBe(200)
    expect(await asked.text()).toContain('name="motDePasse"')
    expect(asked.headers.get('x-robots-tag')).toBe('noindex')

    expect((await post(id, 'mauvais')).status).toBe(401)
    expect((await fetch(`${origin}/partage/${id}/video/x`)).status).toBe(403)

    const opened = await post(id, 'bon-mot-de-passe')
    expect(opened.status).toBe(303)
    const cookie = opened.headers.get('set-cookie')!.split(';')[0]!
    expect(opened.headers.get('set-cookie')).toContain('HttpOnly')

    const page = await fetch(`${origin}/partage/${id}`, { headers: { cookie } })
    expect(await page.text()).not.toContain('name="motDePasse"')
    expect((await fetch(`${origin}/partage/${id}/video/x`, { headers: { cookie } })).status).toBe(404)

    hub.services.partages.remove(id)
    expect((await fetch(`${origin}/partage/${id}`, { headers: { cookie } })).status).toBe(404)
  })

  it('stops the guesses', async () => {
    const { id } = hub.services.partages.create({ sessionId: null, motDePasse: 'bon-mot-de-passe', createdBy: null }, () => null)
    const statuses: number[] = []
    for (let attempt = 0; attempt < 6; attempt++) statuses.push((await post(id, 'mauvais')).status)
    expect(statuses.at(-1)).toBe(429)
  })
})
