/**
 * Points git at `.githooks/`, run by `prepare` on every install.
 *
 * Without it, the commit message check only exists for whoever remembers to run
 * the command. The setting is local to the clone: it cannot travel in the
 * repository, so it has to be laid down again.
 *
 * Outside a git repository we do nothing and exit zero — an extracted tarball or
 * an image built with no `.git` must not fail at install time.
 */
import { execFileSync } from 'node:child_process'

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' })
} catch {
  process.exit(0)
}

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' })
