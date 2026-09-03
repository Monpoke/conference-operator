/**
 * Extracts and parses the JavaScript embedded in a served page.
 *
 * These pages have **no build step**: their JavaScript lives in a TypeScript
 * template literal, where the compiler only sees a string. A badly escaped
 * apostrophe or a forgotten backtick therefore goes unnoticed until the page is
 * opened — and breaks *all* the script, not only the offending line.
 *
 * The precise trap met: in a template literal, `\'` collapses into `'`. Writing
 * `d\'OBS-A` produces `d'OBS-A` in the middle of a single-quoted string, and the
 * whole page stops working.
 */
export function extractScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1] ?? '')
    .filter((code) => code.trim().length > 0)
}

export interface ScriptError {
  index: number
  message: string
}

/** Returns the syntax errors, page by page. */
export function parseScripts(html: string): ScriptError[] {
  const errors: ScriptError[] = []
  for (const [index, code] of extractScripts(html).entries()) {
    try {
      // `new Function` parses without executing: exactly what we want.
      new Function(code)
    } catch (cause) {
      errors.push({ index, message: (cause as Error).message })
    }
  }
  return errors
}
