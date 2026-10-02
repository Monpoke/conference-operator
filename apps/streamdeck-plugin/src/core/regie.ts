/**
 * A gesture sent to the room machine — the very ones the control app sends.
 *
 * `POST /control/action`, validated there against the control contract: the
 * plugin decides nothing, it asks. A machine that does not answer comes back as a
 * refusal like any other, so the button can say so.
 */
export interface ActionOutcome {
  ok: boolean
  message: string
}

export async function sendAction(
  base: string,
  gesture: Record<string, unknown>,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ActionOutcome> {
  try {
    const response = await fetcher(`${base}/control/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(gesture),
    })
    const body = (await response.json()) as { ok?: boolean; message?: string }
    return { ok: body.ok === true, message: body.message ?? (body.ok === true ? 'Fait' : 'Refusé') }
  } catch (cause) {
    return { ok: false, message: `Poste de salle injoignable (${(cause as Error).message})` }
  }
}

/** The room machine's address when nothing was set: the one it listens on. */
export const DEFAULT_BASE = 'http://127.0.0.1:7788'

/** An address typed in the settings, tidied: no trailing slash, `http://` when missing. */
export function normalizeBase(value: string | undefined | null): string {
  const trimmed = (value ?? '').trim().replace(/\/+$/, '')
  if (trimmed === '') return DEFAULT_BASE
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
}
