/**
 * The merging of a `patch` from the state stream, for the served pages.
 *
 * Inline JavaScript and not an import: the screens have no build step. The mirror
 * of `applyStreamPatch` in the contract, which the control app uses — `set`
 * replaces whole fields, `merge` lays sub-fields over `state` and `diagnostics`.
 */
export const STREAM_PATCH_JS = `
  function applyStreamPatch(current, patch) {
    const next = Object.assign({}, current, patch.set)
    for (const key in patch.merge) next[key] = Object.assign({}, current[key], patch.merge[key])
    return next
  }
`
