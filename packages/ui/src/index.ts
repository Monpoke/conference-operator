/**
 * Habillage partagé par les pages autonomes du hub et des salles.
 *
 * Les pages n'ont pas d'étape de build : elles inlinent cette feuille dans un
 * `<style>`, ce qui leur permet d'utiliser Tailwind tout en restant ouvrables
 * sans réseau, sans CDN et sans bundler.
 */
export { TAILWIND_CSS } from './generated/styles.js'

export { aplatirCouches, aplatirCouchesHtml } from './couches.js'
