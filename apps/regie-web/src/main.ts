import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { readInitialPayload, readPortee } from './boot.js'
import { usePorteStore } from './stores/porte.js'
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
 *
 * La **portée** est posée avant lui, parce qu'elle décide de tout le reste : le
 * même bundle est servi par une machine de salle — qui pilote sa salle et
 * n'authentifie personne — et par le hub, qui les a toutes et attend qu'on en
 * choisisse une. Son absence vaut « locale », ce que sert aussi `vite dev`.
 */
const app = createApp(App)
app.use(createPinia())

usePorteStore().start(readPortee(document))
useRoomStore().seed(readInitialPayload(document))

app.mount('#regie-root')
