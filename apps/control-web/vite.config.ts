import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * La régie, bâtie en bundle que le poste de salle sert lui-même.
 *
 * `base` porte l'invariant d'autonomie, sous la forme qu'il a prise depuis la
 * console : **aucune ressource hors de l'origine servie**. Ici il pèse plus
 * lourd qu'ailleurs — la machine de régie tourne parfois sans réseau du tout,
 * et tout ce qu'elle affiche vient de son propre `127.0.0.1`.
 *
 * `manifest`, comme pour la console : le serveur lit les noms hachés plutôt que
 * de les deviner, ce qui lui permet de servir les assets en `immutable` et de
 * garder la coquille sous sa main — la régie a besoin de son état initial
 * embarqué avant le premier octet, sans quoi un rechargement laisse un écran
 * vide au milieu d'un talk.
 */
export default defineConfig({
  base: '/regie/',
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    manifest: true,
    target: 'es2023',
    sourcemap: true,
  },
  server: {
    // Distinct du 5173 de la console : les deux se développent ensemble, une
    // salle de démonstration branchée sur un hub local.
    port: 5174,
    strictPort: true,
    origin: 'http://127.0.0.1:5174',
  },
})
