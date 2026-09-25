/**
 * Who may do what on the hub.
 *
 * Plain data, shared by the hub and the pages: the hub builds Better Auth's
 * access control from it, the pages only ever receive the flattened result of
 * `access.me`. Keeping it free of `better-auth` is what lets the contract stay
 * importable by a browser bundle.
 *
 * Operators only. A paired room machine is not an operator: it keeps full
 * rights over its own room, and none of this applies to it.
 */

/** Every resource and the actions on it. */
export const ACCESS_STATEMENTS = {
  program: ['read', 'manage'],
  room: ['read', 'manage'],
  device: ['read', 'manage'],
  /** Talks' lifecycle. `session` is taken: Better Auth names its sign-in sessions that way. */
  talk: ['read', 'run', 'override'],
  overlay: ['read', 'show'],
  message: ['read', 'send'],
  wall: ['moderate'],
  regie: ['view', 'command'],
  vod: ['read', 'manage'],
  clock: ['read', 'set'],
  settings: ['read', 'update'],
  push: ['subscribe'],
  /** The audit log: who did what through the hub. */
  audit: ['read'],
  /** Better Auth's admin plugin statements, verbatim: its endpoints check them. */
  user: [
    'create',
    'list',
    'set-role',
    'ban',
    'impersonate',
    'impersonate-admins',
    'delete',
    'set-password',
    'set-email',
    'get',
    'update',
  ],
  session: ['list', 'revoke', 'delete'],
} as const

export type AccessStatements = typeof ACCESS_STATEMENTS
export type AccessResource = keyof AccessStatements
export type AccessAction<R extends AccessResource> = AccessStatements[R][number]
export type AccessGrant = { [R in AccessResource]?: readonly AccessAction<R>[] }
/** `"talk:run"` — the flattened form the pages receive. */
export type Permission = { [R in AccessResource]: `${R}:${AccessAction<R>}` }[AccessResource]

const READS = {
  program: ['read'],
  room: ['read'],
  talk: ['read'],
  overlay: ['read'],
  message: ['read'],
  regie: ['view'],
  vod: ['read'],
  clock: ['read'],
} as const satisfies AccessGrant

/**
 * The groups. A user may hold several; rights add up.
 *
 * Nobody gets `user:impersonate`: speaking as a colleague would blur the
 * accountability trace every decision carries.
 */
export const ACCESS_ROLES = {
  admin: {
    program: ['read', 'manage'],
    room: ['read', 'manage'],
    device: ['read', 'manage'],
    talk: ['read', 'run', 'override'],
    overlay: ['read', 'show'],
    message: ['read', 'send'],
    wall: ['moderate'],
    regie: ['view', 'command'],
    vod: ['read', 'manage'],
    clock: ['read', 'set'],
    settings: ['read', 'update'],
    push: ['subscribe'],
    audit: ['read'],
    user: ['create', 'list', 'set-role', 'ban', 'delete', 'set-password', 'set-email', 'get', 'update'],
    session: ['list', 'revoke', 'delete'],
  },
  programmeTech: {
    ...READS,
    program: ['read', 'manage'],
    room: ['read', 'manage'],
    device: ['read', 'manage'],
    talk: ['read', 'run', 'override'],
    overlay: ['read', 'show'],
    vod: ['read', 'manage'],
    clock: ['read', 'set'],
    settings: ['read', 'update'],
    push: ['subscribe'],
  },
  moderation: {
    program: ['read'],
    room: ['read'],
    wall: ['moderate'],
    message: ['read', 'send'],
    push: ['subscribe'],
  },
  regieMobile: {
    program: ['read'],
    room: ['read'],
    regie: ['view', 'command'],
    talk: ['read', 'run'],
    overlay: ['read', 'show'],
    message: ['read', 'send'],
    push: ['subscribe'],
  },
  synthese: {
    program: ['read'],
    room: ['read'],
    talk: ['read'],
    overlay: ['read'],
    vod: ['read'],
    message: ['read'],
    push: ['subscribe'],
  },
  readonly: READS,
} as const satisfies Record<string, AccessGrant>

export type AccessRole = keyof typeof ACCESS_ROLES

export const ACCESS_ROLE_NAMES = Object.keys(ACCESS_ROLES) as AccessRole[]

/** Given to every account the hub creates, Google's included. */
export const DEFAULT_ROLE: AccessRole = 'readonly'

export const ROLE_LABELS: Record<AccessRole, string> = {
  admin: 'Admin global',
  programmeTech: 'Programme & technique',
  moderation: 'Modération',
  regieMobile: 'Régie mobile',
  synthese: "Synthèse d'état",
  readonly: 'Lecture seule',
}

export function isAccessRole(value: string): value is AccessRole {
  return Object.hasOwn(ACCESS_ROLES, value)
}

/**
 * Better Auth stores several roles as `"moderation,regieMobile"`.
 *
 * An unknown name is dropped rather than refused: a role removed from the code
 * must not lock its holders out of the roles they still have.
 */
export function parseRoles(stored: string | null | undefined): AccessRole[] {
  if (stored == null) return []
  return stored
    .split(',')
    .map((role) => role.trim())
    .filter(isAccessRole)
}

/** Every permission the roles add up to, flattened and sorted. */
export function permissionsOf(roles: readonly string[]): Permission[] {
  const granted = new Set<string>()
  for (const role of roles) {
    if (!isAccessRole(role)) continue
    for (const [resource, actions] of Object.entries(ACCESS_ROLES[role])) {
      for (const action of actions as readonly string[]) granted.add(`${resource}:${action}`)
    }
  }
  return [...granted].sort() as Permission[]
}

export function rolesAllow(roles: readonly string[], permission: Permission): boolean {
  const [resource, action] = permission.split(':') as [AccessResource, string]
  return roles.some((role) => {
    if (!isAccessRole(role)) return false
    const actions = (ACCESS_ROLES[role] as AccessGrant)[resource] as readonly string[] | undefined
    return actions?.includes(action) === true
  })
}
