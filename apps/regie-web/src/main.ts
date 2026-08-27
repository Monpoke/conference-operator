import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { readInitialPayload } from './boot.js'
import { useRoomStore } from './stores/room.js'
import './style.css'

/**
 * Amorçage.
 *
 * `createPinia()` par application plutôt qu'un `reactive()` de portée module :
 * la forme singleton fait fuir l'état d'un fichier de test au suivant sans un
 * mot.
 *
 * L'état embarqué est posé **avant** le montage : c'est ce qui fait qu'un F5 en
 * plein talk repeint l'écran tel qu'il était, sans passer par « connexion au
 * poste de salle… ».
 */
const app = createApp(App)
app.use(createPinia())

useRoomStore().seed(readInitialPayload(document))

app.mount('#regie-root')
