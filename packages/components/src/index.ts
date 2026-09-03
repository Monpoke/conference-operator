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
 * Primitives, built on Reka.
 *
 * They are added only as the views that need them appear. Copying the six entry
 * points in one go would bring in some fifty files to review without a single one
 * being exercised — and a primitive no view mounts has never met the scroll lock,
 * the automatic focus, or the control app's touchscreen.
 */
/*
 * Business components: what the console and the control app really show of the
 * same object. Nothing enters here before both need it — a shared component only
 * one surface uses is just one more file.
 */
export { default as StatusDot } from './domain/StatusDot.vue'
export { DOT_LEVELS, type DotLevel } from './domain/status-levels.js'

export { default as Dialog } from './ui/Dialog.vue'
export { default as ConfirmDialog } from './ui/ConfirmDialog.vue'
