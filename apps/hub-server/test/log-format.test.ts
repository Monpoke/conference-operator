import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { hubLoggerOptions } from '../src/log-format.js'

/** A Fastify app whose log lines land in an array, as written. */
function capture(level = 'info') {
  const lines: string[] = []
  const app = Fastify({ logger: { ...hubLoggerOptions(level), stream: { write: (line: string) => lines.push(line) } } })
  return { app, lines }
}

describe('hub log lines', () => {
  it('have the montage worker’s shape: ISO time first, then the level label', () => {
    const { app, lines } = capture()
    app.log.warn({ roomId: 'salle-1' }, 'salle injoignable')

    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!)
    expect(Object.keys(parsed)).toEqual(['time', 'level', 'roomId', 'msg'])
    expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(parsed).toMatchObject({ level: 'warn', roomId: 'salle-1', msg: 'salle injoignable' })
    expect(parsed).not.toHaveProperty('pid')
    expect(parsed).not.toHaveProperty('hostname')
  })

  it('date every line, rather than the first one of each level', () => {
    vi.useFakeTimers({ now: new Date('2026-10-30T08:00:00.000Z'), toFake: ['Date'] })
    try {
      const { app, lines } = capture()
      app.log.info('a')
      vi.setSystemTime(new Date('2026-10-30T08:00:05.000Z'))
      app.log.info('b')

      expect(lines.map((line) => JSON.parse(line).time)).toEqual([
        '2026-10-30T08:00:00.000Z',
        '2026-10-30T08:00:05.000Z',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stay valid JSON for errors, child loggers and requests', async () => {
    const { app, lines } = capture('debug')
    app.log.error(new Error('boom'))
    app.log.child({ roomId: 'salle-1' }).debug('enfant')
    app.get('/health', async () => ({ ok: true }))
    await app.inject('/health')

    const parsed = lines.map((line) => JSON.parse(line))
    expect(parsed.map((line) => line.level)).toEqual(['error', 'debug', 'info', 'info'])
    expect(parsed[0].err.message).toBe('boom')
    expect(parsed.at(-1)).toMatchObject({ msg: 'request completed', res: { statusCode: 200 } })
    for (const line of parsed) expect(Object.keys(line)[0]).toBe('time')
  })

  it('keep their level even when the context carries a `level` field', () => {
    const { app, lines } = capture()
    app.log.info({ level: 'n’importe quoi' }, 'collision')
    expect(JSON.parse(lines[0]!).level).toBe('info')
  })

  it('still honour the configured level', () => {
    const { app, lines } = capture('warn')
    app.log.info('tu')
    app.log.warn('dit')
    expect(lines.map((line) => JSON.parse(line).msg)).toEqual(['dit'])
  })
})
