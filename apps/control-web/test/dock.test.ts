import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App.vue'
import { readDock } from '../src/boot.js'
import { useRoomStore } from '../src/stores/room.js'
import { payload } from './fixtures.js'

/**
 * The control app docked in OBS.
 *
 * A narrow pane next to the program: everything that drives must stay within
 * reach, and the VU meter — which OBS's own mixer repeats right beside it — goes.
 */

let streams: string[]
const mounted: { unmount: () => void }[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  streams = []
  vi.stubGlobal(
    'EventSource',
    class {
      onopen: unknown = null
      onerror: unknown = null
      onmessage: unknown = null
      constructor(url: string) {
        streams.push(url)
      }
      addEventListener(): void {}
      close(): void {}
    },
  )
  vi.stubGlobal(
    'fetch',
    async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
  )
})

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount()
  globalThis.history.replaceState({}, '', '/regie')
})

async function mountAt(address: string): Promise<ReturnType<typeof mount>> {
  globalThis.history.replaceState({}, '', address)
  useRoomStore().seed(payload())
  const wrapper = mount(App, { attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

describe('the dock mode', () => {
  it('is asked for in the address', () => {
    expect(readDock('?dock')).toBe(true)
    expect(readDock('?dock=obs')).toBe(true)
    expect(readDock('')).toBe(false)
    expect(readDock('?docking')).toBe(false)
  })

  it('drops the VU meter, and its stream with it', async () => {
    const wrapper = await mountAt('/regie?dock')

    expect(wrapper.find('[data-role="levels"]').exists()).toBe(false)
    expect(streams).not.toContain('/display/audio')
  })

  it('leaves the full window as it was', async () => {
    const wrapper = await mountAt('/regie')

    expect(wrapper.find('[data-role="levels"]').exists()).toBe(true)
    expect(streams).toContain('/display/audio')
  })
})

describe('the single column, below 1024 px', () => {
  it('never squeezes a column under its own panels', async () => {
    /*
     * A grid row allowed down to zero is squeezed into the window's height, and
     * its panels overflow onto the next one: the OBS dock showed buttons hidden
     * underneath the following panel. `min-h-0` only makes sense from `lg`,
     * where each column scrolls on its own.
     */
    const wrapper = await mountAt('/regie?dock')
    const columns = wrapper.findAll('main > div')

    expect(columns).toHaveLength(3)
    for (const column of columns) {
      expect(column.classes()).not.toContain('min-h-0')
      expect(column.classes()).toContain('lg:min-h-0')
    }
  })
})
