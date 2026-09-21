import { describe, expect, it } from 'vitest'
import { decideOpening } from '../src/core/window-opening.js'

const LOCAL = 'http://127.0.0.1:7788'

describe('decideOpening', () => {
  it('keeps the projection for the placed window', () => {
    expect(decideOpening(`${LOCAL}/display/projector`, LOCAL)).toBe('projector')
  })

  it('opens the machine’s other screens as ordinary windows', () => {
    expect(decideOpening(`${LOCAL}/display/overlay`, LOCAL)).toBe('window')
    expect(decideOpening(`${LOCAL}/display/mur`, LOCAL)).toBe('window')
  })

  it('sends the pairing address to the default browser', () => {
    expect(decideOpening('https://hub.example/admin/devices?user_code=ABCD-1234', LOCAL)).toBe('browser')
  })

  // A hub served over plain HTTP on the venue's network is the ordinary case.
  it('sends a http hub to the browser too', () => {
    expect(decideOpening('http://hub.local:8787/admin/devices', LOCAL)).toBe('browser')
  })

  // Same host, other port: another server on the machine is not this one.
  it('treats another local port as outside', () => {
    expect(decideOpening('http://127.0.0.1:5173/regie', LOCAL)).toBe('browser')
  })

  it('refuses what is not the web', () => {
    expect(decideOpening('file:///etc/passwd', LOCAL)).toBe('refuse')
    expect(decideOpening('mailto:regie@cloudnord.fr', LOCAL)).toBe('refuse')
    expect(decideOpening('pas une adresse', LOCAL)).toBe('refuse')
  })
})
