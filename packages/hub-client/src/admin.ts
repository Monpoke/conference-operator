import type { TokenStore } from './token.js'

/**
 * Account management, through Better Auth's admin plugin.
 *
 * Like sign-in, these calls live under `/api/auth`, outside the oRPC contract.
 * The hub checks every one of them against the caller's groups (`user:*`): a
 * page that shows the buttons to the wrong person only gets refusals.
 */

export interface HubUser {
  id: string
  email: string
  name: string
  /** Better Auth's storage: `"moderation,regieMobile"`. */
  role: string | null
  banned: boolean | null
  createdAt: string
}

export type AdminResult<T = void> = { ok: true; value: T } | { ok: false; message: string }

export interface HubAdmin {
  listUsers(): Promise<AdminResult<HubUser[]>>
  /**
   * Without a password, the account has no credential: it opens through Google
   * only, and finds its groups already set at the first sign-in.
   */
  createUser(input: { email: string; name: string; password?: string; roles: string[] }): Promise<AdminResult>
  setRoles(userId: string, roles: string[]): Promise<AdminResult>
  setPassword(userId: string, password: string): Promise<AdminResult>
  ban(userId: string): Promise<AdminResult>
  unban(userId: string): Promise<AdminResult>
}

export function createHubAdmin(options: { token: TokenStore; fetch?: typeof globalThis.fetch }): HubAdmin {
  const send = options.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args))

  function headers(): Record<string, string> {
    const bearer = options.token.read()
    return {
      'content-type': 'application/json',
      ...(bearer == null ? {} : { authorization: `Bearer ${bearer}` }),
    }
  }

  async function call<T>(path: string, init: RequestInit = {}): Promise<AdminResult<T>> {
    try {
      const response = await send(`/api/auth/admin/${path}`, { ...init, headers: headers() })
      const payload = (await response.json().catch(() => null)) as (T & { message?: string }) | null
      if (!response.ok) {
        return {
          ok: false,
          message:
            response.status === 403
              ? "Ce compte n'a pas le droit de gérer les accès."
              : (payload?.message ?? `Refus du hub (${response.status}).`),
        }
      }
      return { ok: true, value: payload as T }
    } catch {
      return { ok: false, message: 'Le hub est injoignable.' }
    }
  }

  const post = async (path: string, body: unknown): Promise<AdminResult> => {
    const result = await call<unknown>(path, { method: 'POST', body: JSON.stringify(body) })
    return result.ok ? { ok: true, value: undefined } : result
  }

  return {
    async listUsers() {
      const result = await call<{ users: HubUser[] }>('list-users?limit=500&sortBy=email')
      return result.ok ? { ok: true, value: result.value.users } : result
    },
    createUser: ({ email, name, password, roles }) =>
      post('create-user', {
        email,
        name,
        role: roles,
        ...(password == null || password === '' ? {} : { password }),
      }),
    setRoles: (userId, roles) => post('set-role', { userId, role: roles }),
    setPassword: (userId, password) => post('set-user-password', { userId, newPassword: password }),
    ban: (userId) => post('ban-user', { userId }),
    unban: (userId) => post('unban-user', { userId }),
  }
}
