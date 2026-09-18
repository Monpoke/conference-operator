import { createSecretBox } from '../../src/secrets.js'

/**
 * A secret box for the tests, real algorithm and all.
 *
 * Not a stub: the point of encrypting the stream keys is that what lands in the
 * column is unreadable, and a test double that handed the plaintext straight
 * back would let a regression through precisely where it matters. The tests pay
 * one HKDF derivation for that, which is nothing.
 */
export const testSecrets = createSecretBox('secret-de-test-assez-long-pour-hkdf')
