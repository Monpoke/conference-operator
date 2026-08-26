/**
 * Escapes a value interpolated into hand-built HTML.
 *
 * Five copies of this lived in the repository — two in the room-control page,
 * one in the console's server half, one in its client half, one in the wall.
 * They agreed, which is luck rather than design: nothing tied them together,
 * and a page that builds HTML by concatenation cannot afford an exception —
 * it is the exception nobody reopens the day the value starts coming from a
 * form instead of a config file.
 *
 * Vue escapes its own interpolations, so the migrated surfaces do not need
 * this. It stays for the pages that remain string templates, and for anything
 * the server injects into a shell.
 */
const REPLACEMENTS: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => REPLACEMENTS[character]!)
}
