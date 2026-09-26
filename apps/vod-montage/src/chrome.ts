/**
 * Headless Chromium, driven over CDP by hand.
 *
 * Direct driving rather than Playwright or Puppeteer: what the renderer does —
 * open a page, evaluate an expression, take a picture — fits in a few dozen
 * lines of the protocol, and the worker's image then only needs a `chromium`
 * package, not a browser downloaded at install time. Promoted from the
 * `anim-slides` spike, which measured the loop's animations the same way.
 */
import { spawn } from 'node:child_process'

const FLAGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--mute-audio',
  '--allow-file-access-from-files',
  // Without these three, a tab never in the foreground gets its
  // `requestAnimationFrame` slowed down — the counterpart of the
  // `backgroundThrottling: false` OBS sets on its Browser Source.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

/** A minimal CDP client: one socket, ids, pending promises. */
export class Cdp {
  #socket: WebSocket
  #id = 0
  #pending = new Map<number, { ok: (v: unknown) => void; ko: (e: Error) => void }>()

  private constructor(socket: WebSocket) {
    this.#socket = socket
    this.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
      if (message.id == null) return
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      if (message.error) pending.ko(new Error(message.error.message))
      else pending.ok(message.result)
    })
  }

  static async open(url: string): Promise<Cdp> {
    const socket = new WebSocket(url)
    await new Promise<void>((ok, ko) => {
      socket.addEventListener('open', () => ok(), { once: true })
      socket.addEventListener('error', () => ko(new Error(`CDP injoignable : ${url}`)), { once: true })
    })
    return new Cdp(socket)
  }

  send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.#id
    return new Promise<T>((ok, ko) => {
      this.#pending.set(id, { ok: ok as (v: unknown) => void, ko })
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }

  /** Opens a tab and returns the session to address it. */
  async tab(url: string): Promise<{ targetId: string; sessionId: string }> {
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', { url })
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    return { targetId, sessionId }
  }

  /** Evaluates an expression in a tab, awaiting it when it is a promise. */
  async evaluate<T>(sessionId: string, expression: string): Promise<T> {
    const { result, exceptionDetails } = await this.send<{
      result: { value?: T }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result.value as T
  }

  close(): void {
    this.#socket.close()
  }
}

export interface Chrome {
  cdp: Cdp
  stop: () => Promise<void>
}

export async function launchChrome(binary: string, profile: string): Promise<Chrome> {
  const child = spawn(binary, [...FLAGS, `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  const ws = await new Promise<string>((ok, ko) => {
    let buffer = ''
    const timer = setTimeout(() => ko(new Error('Chrome n’a pas annoncé son port CDP')), 20_000)
    child.stderr.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(buffer)
      if (!found?.[1]) return
      clearTimeout(timer)
      ok(found[1])
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      ko(new Error(`Chrome introuvable (${binary}) — définir CHROME=<binaire> : ${error.message}`))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      ko(new Error(`Chrome s’est arrêté (code ${code}) — définir CHROME=<binaire> si besoin`))
    })
  })

  const cdp = await Cdp.open(ws)

  // Waits for the actual exit, not just the signal: Chrome rewrites its profile
  // while closing, and deleting the folder meanwhile fails with ENOTEMPTY.
  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      cdp.close()
      if (child.exitCode != null) return resolve()
      child.once('exit', () => resolve())
      child.kill()
    })

  return { cdp, stop }
}
