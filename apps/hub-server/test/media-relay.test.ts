import { describe, expect, it, vi } from 'vitest'
import { chunkedRange, relayMedia, RELAY_CHUNK_BYTES } from '../src/services/media-relay.js'

describe('relaying a take to the montage page', () => {
  it('never asks for more than one chunk at a time', () => {
    expect(chunkedRange('bytes=0-')).toBe(`bytes=0-${RELAY_CHUNK_BYTES - 1}`)
    expect(chunkedRange(undefined)).toBe(`bytes=0-${RELAY_CHUNK_BYTES - 1}`)
    expect(chunkedRange('bytes=100-', 50)).toBe('bytes=100-149')
    expect(chunkedRange('bytes=100-120', 50)).toBe('bytes=100-120')
    expect(chunkedRange('bytes=100-900', 50)).toBe('bytes=100-149')
  })

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
