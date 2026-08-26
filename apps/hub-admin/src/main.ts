import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { readBoot } from './boot.js'
import { createConsoleRouter } from './router.js'
import { useSessionStore } from './stores/session.js'
import './style.css'

/**
 * Boot.
 *
 * `createPinia()` per application rather than a module-level `reactive()`: the
 * singleton form leaks state from one test file to the next without a word,
 * which in a repository that has no vitest configuration at all is a defect
 * nobody would think to look for.
 */
const app = createApp(App)
app.use(createPinia())
app.use(createConsoleRouter())

useSessionStore().start(readBoot(document))

app.mount('#console-root')
