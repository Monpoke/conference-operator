/**
 * No test leaves this machine.
 *
 * The suites boot a real hub and a real room on the Cloud Nord fixture, and a
 * room's sync prefetches the programme's images with the global `fetch`. With a
 * fresh data directory per test and a test hub holding no image, every
 * `beforeEach` went to download all of them from OpenPlanner's storage: one run
 * of the room-client suite made some 3,500 requests there. Its owner saw 13 GB
 * leave in a day, and 403s by the thousand on the fixture's images that have
 * since been deleted upstream.
 *
 * Loopback still goes through: it is how the tests reach the hub they started.
 * Anything else is refused the way a network outage would be — a rejected
 * `fetch` — which the code already lives with: an image that cannot be fetched
 * is recorded as failed, and the screen keeps its fallback. A test that needs an
 * answer from outside passes its own `fetchImpl`, as the asset tests do.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

const realFetch = globalThis.fetch

globalThis.fetch = (input, init) => {
  const url = URL.parse(input instanceof Request ? input.url : String(input))
  if (url == null || LOOPBACK.has(url.hostname)) return realFetch(input, init)
  return Promise.reject(new TypeError(`fetch failed: réseau sortant coupé en test (${url.href})`))
}
