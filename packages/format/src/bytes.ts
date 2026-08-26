/**
 * File sizes, as an operator reads them on a recording list.
 *
 * Decimal units, not binary: the figure is compared against what the operating
 * system's file browser shows on the same machine, and that one counts in
 * powers of ten. Being consistent with the neighbouring window matters more
 * here than being right about kibibytes.
 *
 * The floor at one kilobyte is deliberate. A sidecar file of a few hundred
 * bytes displayed as "0 ko" reads as an empty file, which is exactly the thing
 * an operator is checking for.
 */
export function fileSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1).replace('.', ',')} Go`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} Mo`
  return `${Math.max(1, Math.round(bytes / 1e3))} ko`
}
