/**
 * Components shared by the operator surfaces.
 *
 * Three circles, and the boundary between them is worth keeping:
 *
 *  - `common/` — the design system. Written here, because the decisions in it
 *    (target size, label weight, the shortcut badge) are the ones this product
 *    made on purpose and an off-the-shelf library would undo.
 *  - `ui/` — primitives copied from shadcn-vue, kept as upstream writes them so
 *    they stay diffable against the source.
 *  - `domain/` — the pieces that know what a room is. Shared only where the
 *    console and the room control genuinely show the same object; where they
 *    merely share a noun, they each keep their own.
 */
export { cn } from './common/cn.js'
export { default as Badge } from './common/Badge.vue'
export { default as Button } from './common/Button.vue'
export { default as Empty } from './common/Empty.vue'
export { default as Field } from './common/Field.vue'
export { default as Hint } from './common/Hint.vue'
export { default as Key } from './common/Key.vue'
export { default as Panel } from './common/Panel.vue'
export { default as Select } from './common/Select.vue'
export { default as Toaster } from './common/Toaster.vue'
export { useToast, NOTICE_MS, type Notice } from './common/toast.js'

/*
 * Primitives, montées sur Reka.
 *
 * Elles ne sont posées qu'au fur et à mesure des vues qui en ont besoin. Copier
 * les six entrées d'un coup ferait entrer une cinquantaine de fichiers à
 * relire sans qu'aucun ne soit exercé — et une primitive qu'aucune vue ne monte
 * n'a jamais rencontré ni le verrou de défilement, ni le focus automatique, ni
 * l'écran tactile de la régie.
 */
export { default as Dialog } from './ui/Dialog.vue'
