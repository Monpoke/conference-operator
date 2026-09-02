/**
 * Pointe git sur `.githooks/`, lancé par `prepare` à chaque installation.
 *
 * Sans cela, le contrôle des messages n'existe que pour qui pense à lancer la
 * commande. Le réglage est local au clone : il ne peut pas voyager dans le
 * dépôt, il faut donc le reposer.
 *
 * Hors d'un dépôt git, on ne fait rien et on sort à zéro — un tarball extrait
 * ou une image construite sans `.git` ne doit pas échouer à l'installation.
 */
import { execFileSync } from 'node:child_process'

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' })
} catch {
  process.exit(0)
}

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' })
