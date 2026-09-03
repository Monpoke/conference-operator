/**
 * Flattens the `@layer`s of a stylesheet, for the tests.
 *
 * happy-dom ignores `@layer` outright: the rules it contains do not exist for
 * `getComputedStyle`. Yet Tailwind v4 wraps **all** of its output in layers.
 * Without this flattening, the tests that check an element's *effective*
 * visibility — the ones that caught the defect where the tabs did change
 * attribute without the screen moving — would silently stop checking anything.
 *
 * The order in which layers are written is already their priority order for
 * ordinary rules: removing them therefore preserves the result for what these
 * tests observe. Browsers get the sheet intact.
 */
export function flattenLayers(css: string): string {
  let output = ''
  let i = 0

  while (i < css.length) {
    const start = css.indexOf('@layer', i)
    if (start === -1) {
      output += css.slice(i)
      break
    }
    output += css.slice(i, start)

    // Two forms coexist: `@layer a, b;` which only declares an order, and
    // `@layer a { … }` which carries rules.
    const brace = css.indexOf('{', start)
    const semicolon = css.indexOf(';', start)
    if (semicolon !== -1 && (brace === -1 || semicolon < brace)) {
      i = semicolon + 1
      continue
    }
    if (brace === -1) {
      output += css.slice(start)
      break
    }

    let depth = 0
    let end = brace
    for (; end < css.length; end += 1) {
      if (css[end] === '{') depth += 1
      else if (css[end] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    // Recursive: Tailwind nests layers inside layers.
    output += flattenLayers(css.slice(brace + 1, end))
    i = end + 1
  }

  return output
}

/** The same operation, but on the `<style>` blocks of a whole page. */
export function flattenLayersInHtml(html: string): string {
  return html.replace(
    /<style>([\s\S]*?)<\/style>/g,
    (_all, css: string) => `<style>${flattenLayers(css)}</style>`,
  )
}
