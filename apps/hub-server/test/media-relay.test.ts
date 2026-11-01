import { describe, expect, it, vi } from 'vitest'
import { relayMedia } from '../src/services/media-relay.js'

describe('relaying a take to the montage page', () => {
  it('asks the storage for the range the browser asked for, and hands back its answer', async () => {
    const fetcher = vi.fn(async () => new Response('abc', {
      status: 206,
      headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-2/10', 'accept-ranges': 'bytes', 'x-amz-request-id': 'secret' },
    }))
    const media = await relayMedia('https://s3.test/rush?sig=x', 'bytes=0-2', fetcher as never)
    expect(fetcher).toHaveBeenCalledWith('https://s3.test/rush?sig=x', { headers: { range: 'bytes=0-2' } })
    expect(media.status).toBe(206)
    expect(media.headers).toEqual({ 'content-type': 'video/mp4', 'content-range': 'bytes 0-2/10', 'accept-ranges': 'bytes' })
    expect(await new Response(media.body).text()).toBe('abc')
  })
})
