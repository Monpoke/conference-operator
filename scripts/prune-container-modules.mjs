/**
 * Pruning the pnpm store for the hub's image.
 *
 * Why: `pnpm install --prod` still lets a hundred megabytes of test and build
 * tooling in. That is not a pnpm bug. `better-auth` declares `vitest` and
 * `drizzle-kit` as **non-optional peer dependencies**; pnpm therefore has to
 * materialise them, and with them rolldown, lightningcss, happy-dom and two
 * copies of esbuild. None of that is reachable from the running hub: those
 * packages serve better-auth's test helpers and its schema-generation CLI, which
 * the hub never calls — it applies SQL migrations that are already written.
 *
 * How: rather than a hand-written list of names, which would go stale silently at
 * the first version bump, we **recompute what is reachable**. We start from the
 * hub, follow `dependencies` and `optionalDependencies` — never
 * `peerDependencies`, which is precisely the door the tooling comes in through —
 * and delete from the store everything that walk did not visit.
 *
 * What that guarantees and what it does not: a static `import` of a deleted
 * package makes the hub fail **at start-up**, so at deployment, not in a room. A
 * dynamic `import()` of a peer dependency would escape the computation, however;
 * that is why the image is started and exercised at the end of the build rather
 * than merely built.
 *
 * Runs from the repository root, after the install.
 */
import { readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

const root = process.cwd()
const store = join(root, 'node_modules', '.pnpm')
const dryRun = process.argv.includes('--simulation')

/** Resolves `name` from `from`, walking up the `node_modules`, as Node does. */
function resolve(name, from) {
  let folder = from
  for (;;) {
    const candidate = join(folder, 'node_modules', name)
    try {
      return realpathSync(candidate)
    } catch {
      /* not here: walk up */
    }
    const parent = dirname(folder)
    if (parent === folder) return null
    folder = parent
  }
}

/** The store's `<name>@<version>` folder this path belongs to, if any. */
function storeEntry(path) {
  const marker = `${sep}.pnpm${sep}`
  const position = path.indexOf(marker)
  if (position === -1) return null
  return path.slice(position + marker.length).split(sep)[0]
}

const visited = new Set()
const kept = new Set()
const queue = [realpathSync(join(root, 'apps', 'hub-server'))]

while (queue.length > 0) {
  const folder = queue.pop()
  if (visited.has(folder)) continue
  visited.add(folder)

  const entry = storeEntry(folder)
  if (entry != null) kept.add(entry)

  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
  } catch {
    continue
  }

  // `peerDependencies` deliberately absent: see the header.
  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  }
  for (const name of Object.keys(dependencies)) {
    const target = resolve(name, folder)
    // An optional dependency that is not installed is nothing out of the ordinary.
    if (target != null) queue.push(target)
  }
}

const all = readdirSync(store, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== 'node_modules')
  .map((e) => e.name)

const toDelete = all.filter((name) => !kept.has(name))

/** A folder's approximate size, in MB — to say what is being saved. */
function megabytes(path) {
  let total = 0
  const stack = [path]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) stack.push(child)
      else if (entry.isFile()) {
        try {
          total += statSync(child).size
        } catch {
          /* dead link */
        }
      }
    }
  }
  return total / 1024 / 1024
}

let saved = 0
for (const name of toDelete) {
  const path = join(store, name)
  saved += megabytes(path)
  if (!dryRun) rmSync(path, { recursive: true, force: true })
}

const verb = dryRun ? 'à supprimer' : 'supprimés'
console.log(
  `élagage : ${kept.size} paquets atteignables, ${toDelete.length} ${verb} ` +
    `(${saved.toFixed(0)} Mo)`,
)
