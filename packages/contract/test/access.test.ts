import { describe, expect, it } from 'vitest'
import {
  ACCESS_ROLES,
  ACCESS_ROLE_NAMES,
  ACCESS_STATEMENTS,
  DEFAULT_ROLE,
  parseRoles,
  permissionsOf,
  rolesAllow,
} from '../src/access.js'

const WRITES = new Set([
  'manage', 'run', 'override', 'show', 'send', 'moderate', 'command', 'set', 'update', 'subscribe',
])

describe('access catalogue', () => {
  it('only grants declared actions', () => {
    for (const role of ACCESS_ROLE_NAMES) {
      for (const permission of permissionsOf([role])) {
        const [resource, action] = permission.split(':') as [keyof typeof ACCESS_STATEMENTS, string]
        expect(ACCESS_STATEMENTS[resource] as readonly string[], `${role} → ${permission}`).toContain(action)
      }
    }
  })

  it('gives admin everything the other roles have', () => {
    const admin = new Set(permissionsOf(['admin']))
    for (const role of ACCESS_ROLE_NAMES) {
      for (const permission of permissionsOf([role])) {
        expect(admin.has(permission), `${role} → ${permission}`).toBe(true)
      }
    }
  })

  it('lets nobody impersonate', () => {
    for (const role of ACCESS_ROLE_NAMES) {
      expect(rolesAllow([role], 'user:impersonate')).toBe(false)
    }
  })

  it('keeps read-only free of any gesture', () => {
    expect(DEFAULT_ROLE).toBe('readonly')
    const writes = permissionsOf(['readonly']).filter((permission) => WRITES.has(permission.split(':')[1]!))
    expect(writes).toEqual([])
    expect(rolesAllow(['readonly'], 'settings:read')).toBe(false)
    expect(rolesAllow(['readonly'], 'device:read')).toBe(false)
  })

  it('adds roles up', () => {
    expect(rolesAllow(['moderation'], 'regie:command')).toBe(false)
    expect(rolesAllow(['moderation', 'regieMobile'], 'regie:command')).toBe(true)
    expect(rolesAllow(['moderation', 'regieMobile'], 'wall:moderate')).toBe(true)
  })

  it('matches the decisions taken for each group', () => {
    expect(rolesAllow(['regieMobile'], 'talk:run')).toBe(true)
    expect(rolesAllow(['regieMobile'], 'talk:override')).toBe(false)
    expect(rolesAllow(['programmeTech'], 'talk:override')).toBe(true)
    expect(rolesAllow(['moderation'], 'message:send')).toBe(true)
    expect(rolesAllow(['synthese'], 'push:subscribe')).toBe(true)
    expect(rolesAllow(['programmeTech'], 'user:list')).toBe(false)
  })

  it('parses what Better Auth stores, dropping unknown names', () => {
    expect(parseRoles('moderation, regieMobile,ghost')).toEqual(['moderation', 'regieMobile'])
    expect(parseRoles(null)).toEqual([])
    expect(Object.keys(ACCESS_ROLES)).toEqual(ACCESS_ROLE_NAMES)
  })
})
