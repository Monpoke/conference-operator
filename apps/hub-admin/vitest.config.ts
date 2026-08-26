import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Le premier fichier de configuration vitest du dépôt, et il faut le dire.
 *
 * Partout ailleurs, l'environnement se choisit par pragma en tête de fichier et
 * la configuration par défaut suffit. Monter un composant Vue demande que
 * `@vitejs/plugin-vue` soit enregistré, ce qu'aucun pragma ne fait — d'où cette
 * exception, limitée aux applications qui contiennent des `.vue`.
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
})
