import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import UrgentConfirmDialog from '../src/components/UrgentConfirmDialog.vue'

/** The urgent confirmation, offering what the account allows — and nothing it does not. */
const mounted: { unmount: () => void }[] = []
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})

async function dialog(proof: { password: boolean; sso: boolean; fresh: boolean }) {
  const wrapper = mount(UrgentConfirmDialog, {
    props: { open: true, proof, summary: 'Projeté en urgence', text: 'Évacuez' },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

describe('urgent confirmation', () => {
  it('asks nothing more of a fresh SSO session, even on an account with a password', async () => {
    await dialog({ password: true, sso: true, fresh: true })
    expect(document.querySelector('[data-role="urgent-fresh"]')).not.toBeNull()
    expect(document.querySelector('#urgent-password')).toBeNull()
  })

  it('offers both ways once the session is old', async () => {
    await dialog({ password: true, sso: true, fresh: false })
    expect(document.querySelector('#btn-urgent-reauth')).not.toBeNull()
    expect(document.querySelector('#urgent-password')).not.toBeNull()
  })

  it('offers only the password to a password-only account', async () => {
    await dialog({ password: true, sso: false, fresh: true })
    expect(document.querySelector('#btn-urgent-reauth')).toBeNull()
    expect(document.querySelector('#urgent-password')).not.toBeNull()
  })
})
