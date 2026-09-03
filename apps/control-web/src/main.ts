import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { readInitialPayload, readScope } from './boot.js'
import { useGatewayStore } from './stores/gateway.js'
import { useRoomStore } from './stores/room.js'
import './style.css'

/**
 * Bootstrap.
 *
 * `createPinia()` per application rather than a module-scoped `reactive()`: the
 * singleton shape leaks state from one test file to the next without a word.
 *
 * The embedded state is laid down **before** mounting: that is what makes an F5
 * mid-talk repaint the screen as it was, without passing through "connecting to
 * the room machine…".
 *
 * The **scope** is laid down before it, because it decides everything else: the
 * same bundle is served by a room machine — which drives its own room and
 * authenticates nobody — and by the hub, which has them all and waits for one to
 * be chosen. Its absence means "locale", which is also what `vite dev` serves.
 */
const app = createApp(App)
app.use(createPinia())

useGatewayStore().start(readScope(document))
useRoomStore().seed(readInitialPayload(document))

app.mount('#regie-root')
