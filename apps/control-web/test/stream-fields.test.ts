import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIELDS_BY_VIEW } from '@conference-operator/contract'
import { describe, expect, it } from 'vitest'

/**
 * The state stream only pushes the control app the fields it reads.
 *
 * The risk in that split is silent: a field added to the page but forgotten in
 * `FIELDS_BY_VIEW` raises nothing, it displays blanks. So this test reads the
 * sources back and compares what they consult with what they receive.
 *
 * Inherited from the guard of the page it replaces, along with the correction that
 * came with it: `payload?.field` counts as much as `payload.field`. The original
 * pattern ignored the optional form, and the only field a page read that way — the
 * wall, in the screens menu — was missing from the list with nothing to say so.
 * The old page did not suffer from it by accident: it built that menu only once,
 * from the embedded state, which is not filtered. This one recomputes it, and the
 * link would have disappeared within the first second.
 */
const ROOT = join(import.meta.dirname, '..', 'src')

function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(ts|vue)$/.test(entry.name) ? [path] : []
  })
}

/**
 * What the control app consults in the payload.
 *
 * Three ways of naming it, because it crosses three layers: `payload` in the
 * components that receive it as a prop, `payload.value` in the store that holds
 * it, and `room.payload` wherever the store is read.
 */
function fieldsRead(): string[] {
  const found = new Set<string>()
  for (const file of sources(ROOT)) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of [
      /\bpayload[!?]?\.(?:value[!?]?\.)?([a-zA-Z]+)/g,
      /\bpayload\.value[!?]?\.([a-zA-Z]+)/g,
    ]) {
      for (const match of source.matchAll(pattern)) found.add(match[1]!)
    }
  }
  // `value` is the ref's accessor, not a field; the rest is naming noise.
  found.delete('value')
  return [...found].sort()
}

describe('stream fields', () => {
  const received = new Set<string>(FIELDS_BY_VIEW.regie as readonly string[])

  it('the control app receives everything it consults', () => {
    const missing = fieldsRead().filter((field) => !received.has(field))
    expect(
      missing,
      missing.length === 0
        ? ''
        : `the control app reads ${missing.join(', ')} — add them to FIELDS_BY_VIEW.regie, ` +
          'otherwise the page renders blanks without raising an error.',
    ).toEqual([])
  })

  it('receives nothing useless', () => {
    // The reverse counts too: a field sent without being read is pure traffic, on
    // every state change, on a machine that encodes.
    const read = new Set(fieldsRead())
    expect([...received].filter((field) => !read.has(field))).toEqual([])
  })

  it('reading the sources does find something', () => {
    // A guard for the guard: an extraction gone silent would make the previous two
    // tests pass while checking nothing.
    expect(fieldsRead().length).toBeGreaterThan(3)
  })
})
