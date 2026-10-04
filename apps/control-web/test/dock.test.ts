import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App.vue'
import { readDock } from '../src/boot.js'
import { useActionsStore } from '../src/stores/actions.js'
import { useRoomStore } from '../src/stores/room.js'
import { payload } from './fixtures.js'

/**
 * The control app docked in OBS.
 *
 * A narrow pane next to the program: everything that drives must stay within
 * reach, and the VU meter — which OBS's own mixer repeats right beside it — goes.
 */

let streams: string[]
let closed: string[]
const mounted: { unmount: () => void }[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  streams = []
  closed = []
  vi.stubGlobal(
    'EventSource',
    class {
      onopen: unknown = null
      onerror: unknown = null
      onmessage: unknown = null
      constructor(private readonly url: string) {
        streams.push(url)
      }
      addEventListener(): void {}
      close(): void {
        closed.push(this.url)
      }
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

  it('is recognised in OBS, as the room\'s server does', () => {
    expect(readDock('', 'Mozilla/5.0 (Windows NT 10.0) Chrome/127.0 OBS/31.0.2')).toBe(true)
    expect(readDock('', 'Mozilla/5.0 (Windows NT 10.0) Chrome/127.0 Safari/537.36')).toBe(false)
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

describe('the VU meter\'s stream', () => {
  let state: DocumentVisibilityState = 'visible'
  beforeEach(() => {
    state = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  })
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState')
  })
  const show = (next: DocumentVisibilityState) => {
    state = next
    document.dispatchEvent(new Event('visibilitychange'))
  }

  it('closes while the window is hidden, and opens again when it is back', async () => {
    await mountAt('/regie')
    expect(streams.filter((url) => url === '/display/audio')).toHaveLength(1)

    // Minimised, behind OBS: nobody reads the meters, OBS stops metering.
    show('hidden')
    expect(closed).toContain('/display/audio')

    show('visible')
    expect(streams.filter((url) => url === '/display/audio')).toHaveLength(2)
  })

  it('does not open at all in a window that starts hidden', async () => {
    state = 'hidden'
    await mountAt('/regie')
    expect(streams).not.toContain('/display/audio')
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

describe('the server-mode offer', () => {
  afterEach(() => globalThis.sessionStorage.clear())

  /** Mounts with this payload already in the store, before the first render. */
  async function mountWith(address: string, dockConnected: boolean): Promise<ReturnType<typeof mount>> {
    globalThis.history.replaceState({}, '', address)
    useRoomStore().seed({ ...payload(), dockConnected })
    const wrapper = mount(App, { attachTo: document.body })
    mounted.push(wrapper)
    await flushPromises()
    return wrapper
  }

  const offer = (wrapper: ReturnType<typeof mount>) => wrapper.find('[data-role="server-mode-offer"]')

  it('tells the machine the stream comes from a dock', async () => {
    await mountAt('/regie?dock')
    expect(streams).toContain('/display/state?vue=regie&partiel=1&dock=1')
  })

  it('says nothing of a dock from the machine window', async () => {
    await mountAt('/regie')
    expect(streams).toContain('/display/state?vue=regie&partiel=1')
  })

  it('is offered while a dock drives the room, and only then', async () => {
    const wrapper = await mountAt('/regie')
    expect(offer(wrapper).exists()).toBe(false)

    useRoomStore().seed({ ...payload(), dockConnected: true })
    await flushPromises()
    expect(offer(wrapper).exists()).toBe(true)
  })

  it('never shows in the dock itself', async () => {
    const wrapper = await mountWith('/regie?dock', true)
    expect(offer(wrapper).exists()).toBe(false)
  })

  it('goes once declined, and comes back with the next dock', async () => {
    const wrapper = await mountWith('/regie', true)
    const room = useRoomStore()

    await wrapper.find('[data-role="btn-stay"]').trigger('click')
    expect(offer(wrapper).exists()).toBe(false)

    room.seed({ ...payload(), dockConnected: false })
    await flushPromises()
    room.seed({ ...payload(), dockConnected: true })
    await flushPromises()
    expect(offer(wrapper).exists()).toBe(true)
  })

  it('is not offered again on the way back from server mode', async () => {
    const wrapper = await mountWith('/regie?console', true)
    expect(offer(wrapper).exists()).toBe(false)
  })

  it('stays reachable from the screens menu, in this window', async () => {
    const wrapper = await mountAt('/regie')
    await wrapper.find('[data-role="btn-screens"]').trigger('click')
    const link = wrapper.find('[data-role="screens-list"] a[href="/regie/serveur"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('target')).toBeUndefined()
  })

  it('leaves it out of the dock menu, and this page in another window too', async () => {
    const wrapper = await mountAt('/regie?dock')
    await wrapper.find('[data-role="btn-screens"]').trigger('click')
    const list = wrapper.find('[data-role="screens-list"]')
    expect(list.find('a[href="/regie/serveur"]').exists()).toBe(false)
    expect(list.find('a[href="/regie"]').exists()).toBe(false)
  })
})

describe('server mode by itself, once the dock acts', () => {
  afterEach(() => {
    globalThis.sessionStorage.clear()
    vi.restoreAllMocks()
  })

  async function windowWith(dockActedAt: number | null): Promise<ReturnType<typeof vi.spyOn>> {
    const assign = vi.spyOn(globalThis.location, 'assign').mockImplementation(() => {})
    globalThis.history.replaceState({}, '', '/regie')
    useRoomStore().seed({ ...payload(), dockConnected: true, dockActedAt })
    mounted.push(mount(App, { attachTo: document.body }))
    await flushPromises()
    return assign
  }

  it('tells the machine a gesture comes from the dock', async () => {
    const sent: { headers?: HeadersInit }[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { headers?: HeadersInit }) => {
      sent.push(init)
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
    })
    await mountAt('/regie?dock')
    await useActionsStore().act({ action: 'display.set', mode: 'loop' })
    expect(sent.at(-1)?.headers).toMatchObject({ 'x-regie-dock': '1' })
  })

  it('switches the window when the dock acts', async () => {
    const assign = await windowWith(null)
    useRoomStore().seed({ ...payload(), dockConnected: true, dockActedAt: 1_000 })
    await flushPromises()
    expect(assign).toHaveBeenCalledWith('/regie/serveur')
  })

  it('stays on the console once the window itself was used', async () => {
    const assign = await windowWith(null)
    await useActionsStore().act({ action: 'display.set', mode: 'loop' })
    useRoomStore().seed({ ...payload(), dockConnected: true, dockActedAt: 1_000 })
    await flushPromises()
    expect(assign).not.toHaveBeenCalled()
  })

  it('does not bounce back out on a gesture older than the page', async () => {
    const assign = await windowWith(500)
    useRoomStore().seed({ ...payload(), dockConnected: true, dockActedAt: 500 })
    await flushPromises()
    expect(assign).not.toHaveBeenCalled()
  })
})
