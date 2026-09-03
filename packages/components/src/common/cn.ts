import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merges class lists, letting the caller's win.
 *
 * `tailwind-merge` groups by utility prefix, so it works unchanged on the
 * French palette: `bg-brand` and `bg-canvas` are both `bg-*` and collapse
 * correctly, and `text-dim` is classed as a colour rather than a size.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
