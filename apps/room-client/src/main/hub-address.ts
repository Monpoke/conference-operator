import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The hub's address, resolved at startup.
 *
 * An environment variable is not enough: on a room machine, the application is
 * launched from a desktop shortcut placed by the installer, and nobody is going
 * to edit a Windows shortcut the day before the event. The machine must therefore
 * be able to *ask* for the address, and above all to remember it — the question
 * only comes up once per machine.
 *
 * Two sources dictate it, and the first that answers wins:
 *
 * 1. `--hub=<url>` on the command line — what one puts in a shortcut or a
 *    deployment script when provisioning several machines;
 * 2. `HUB_ORIGIN` in the environment — the historical form, kept for development
 *    and for `pnpm dev`.
 *
 * With neither of the two, **we ask on every launch**, with the remembered
 * address prefilled in the field: validating means going back to the same hub,
 * and a room replugged onto another hub — a rehearsal, a backup, a machine moved
 * — needs nobody to go and edit a Windows shortcut. One extra launch costs an
 * Enter key; picking the wrong hub costs half a day of capture sent to the wrong
 * event.
 *
 * The two dictated sources are *also* remembered: what they impose becomes the
 * next launch's proposal.
 */
export const DEFAULT_HUB_ADDRESS = 'http://localhost:8787'

export interface ImposedAddress {
  value: string
  source: 'argument' | 'environment'
}

/** The French label naming the source in an operator-facing message. */
const SOURCE_LABELS: Record<ImposedAddress['source'], string> = {
  argument: 'argument',
  environment: 'environnement',
}

/**
 * An address dictated from outside, reading nothing from disk.
 *
 * Read by prefix rather than by position: `electron dist/main.cjs --hub=…` in
 * development and `Régie de salle.exe --hub=…` on the machine do not have the
 * same `argv[1]`, and counting the arguments would have broken on one of the two.
 */
export function imposedAddress(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): ImposedAddress | null {
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i]!
    if (argument.startsWith('--hub=')) return { value: argument.slice('--hub='.length), source: 'argument' }
    // The separated form, for a shortcut written by hand: `--hub http://…`.
    if (argument === '--hub' && i + 1 < argv.length) return { value: argv[i + 1]!, source: 'argument' }
  }
  const fromEnv = env.HUB_ORIGIN?.trim()
  return fromEnv != null && fromEnv !== '' ? { value: fromEnv, source: 'environment' } : null
}

/**
 * Brings an entry back to a usable origin, or explains why it is not one.
 *
 * The scheme is optional when typing: on a room machine one types an IP and a
 * port, not a URL. The path, for its part, is stripped — the whole client
 * resolves absolute paths (`/health`, `/rpc`, `/ws`) on this origin, so an
 * `/admin` pasted from the browser's address bar would have been of no use; the
 * field shows the normalized value again, so the cut is visible.
 */
export function normalizeHubAddress(entry: string): string {
  const raw = entry.trim()
  if (raw === '') throw new Error('Adresse vide — indiquer par exemple http://192.168.1.10:8787')

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`Adresse illisible : ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Adresse en ${url.protocol.replace(':', '')} : le hub se joint en http ou https`)
  }
  if (url.hostname === '') throw new Error(`Adresse sans machine : ${raw}`)
  return url.origin
}

/** The address remembered by the previous launch, or `null`. */
export function readHubAddress(path: string): string | null {
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8').trim()
  return raw === '' ? null : raw
}

export function writeHubAddress(path: string, origin: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, origin, 'utf8')
}

export interface HubAddressResolution {
  /** The address file, outside the SQLite database: it must survive a cache reset. */
  path: string
  argv?: readonly string[]
  env?: NodeJS.ProcessEnv
  /** Opens the entry screen. `null` if the operator closes without validating. */
  ask: (initialValue: string) => Promise<string | null>
  onLog?: (level: 'warn' | 'error', message: string) => void
}

/**
 * The address chosen for this launch, remembered along the way.
 *
 * Returns `null` when the operator closes the screen without validating: there is
 * then nothing to start, and the caller quits.
 */
export async function resolveHubAddress(options: HubAddressResolution): Promise<string | null> {
  const { path, argv = process.argv, env = process.env, ask, onLog } = options

  const remembered = soundValue(readHubAddress(path), (message) =>
    onLog?.('error', `Adresse du hub mémorisée illisible, elle sera redemandée : ${message}`),
  )

  const imposed = imposedAddress(argv, env)
  if (imposed != null) {
    const origin = soundValue(imposed.value, (message) =>
      onLog?.('error', `Adresse du hub passée en ${SOURCE_LABELS[imposed.source]} et refusée : ${message}`),
    )
    // Kept without asking anything: a dictated address is dictated by a shortcut
    // or a script, where there is nobody to answer a window.
    if (origin != null) {
      if (origin !== remembered) writeHubAddress(path, origin)
      return origin
    }
    // Refused: we do not start silently on yesterday's address, we ask.
    return await prompt(imposed.value)
  }

  return await prompt(remembered ?? DEFAULT_HUB_ADDRESS)

  async function prompt(initialValue: string): Promise<string | null> {
    const entered = await ask(initialValue)
    if (entered == null) return null
    // The window already normalizes so it can refuse in front of the operator;
    // going through here again costs nothing and beats an implicit trust.
    const origin = normalizeHubAddress(entered)
    writeHubAddress(path, origin)
    return origin
  }
}

function soundValue(value: string | null, onError: (message: string) => void): string | null {
  if (value == null) return null
  try {
    return normalizeHubAddress(value)
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error))
    return null
  }
}
