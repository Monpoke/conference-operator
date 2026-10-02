import { applyStreamPatch, type DisplayPayload, type StreamPatch } from '@conference-operator/contract/room-display'

/**
 * The room's state, followed as the control app follows it.
 *
 * The same stream — `/display/state?vue=regie&partiel=1` — and the same reading:
 * an unnamed message is the whole snapshot, a `patch` lays its fields over it
 * (`applyStreamPatch`). Read with `fetch` rather than `EventSource`: the plugin
 * runs in Node, where there is none, and a stream is twenty lines to parse.
 *
 * `null` means "the room machine does not answer": the buttons grey out rather
 * than go on showing a recording that may have stopped.
 */
export interface StateClientOptions {
  /** The room machine, `http://127.0.0.1:7788` by default. */
  base: () => string
  onState: (payload: DisplayPayload | null) => void
  fetch?: typeof fetch
  /** Delay before reconnecting, in ms. */
  retryMs?: number
}

export class StateClient {
  private payload: DisplayPayload | null = null
  private abort: AbortController | null = null
  private stopped = false
  private readonly fetch: typeof fetch
  private readonly retryMs: number

  constructor(private readonly options: StateClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.retryMs = options.retryMs ?? 2_000
  }

  /** The last state received, `null` while offline. */
  current(): DisplayPayload | null {
    return this.payload
  }

  start(): void {
    this.stopped = false
    void this.loop()
  }

  stop(): void {
    this.stopped = true
    this.abort?.abort()
  }

  /** Drops the connection and opens it again — after the address was changed. */
  restart(): void {
    this.abort?.abort()
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.follow()
      } catch {
        // Refused, cut, aborted: the room is unreachable until the next snapshot.
      }
      this.set(null)
      if (this.stopped) return
      await new Promise((resolve) => setTimeout(resolve, this.retryMs))
    }
  }

  private async follow(): Promise<void> {
    this.abort = new AbortController()
    const response = await this.fetch(`${this.options.base()}/display/state?vue=regie&partiel=1`, {
      headers: { accept: 'text/event-stream' },
      signal: this.abort.signal,
    })
    if (!response.ok || response.body == null) throw new Error(`HTTP ${response.status}`)

    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let end = buffer.indexOf('\n\n')
      while (end !== -1) {
        this.receive(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
        end = buffer.indexOf('\n\n')
      }
    }
  }

  /** One SSE message: `event:` and `data:` lines; comments (`: ping`) ignored. */
  private receive(block: string): void {
    let event: string | null = null
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (data.length === 0) return
    const body = JSON.parse(data.join('\n')) as unknown

    if (event == null) this.set(body as DisplayPayload)
    else if (event === 'patch' && this.payload != null) this.set(applyStreamPatch(this.payload, body as StreamPatch))
  }

  private set(payload: DisplayPayload | null): void {
    if (payload === null && this.payload === null) return
    this.payload = payload
    this.options.onState(payload)
  }
}
