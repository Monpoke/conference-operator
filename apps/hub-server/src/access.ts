import { ACCESS_ROLES, ACCESS_STATEMENTS } from '@conference-operator/contract'
import { createAccessControl } from 'better-auth/plugins/access'

/**
 * Better Auth's view of the role table in `@conference-operator/contract`.
 *
 * Only the admin plugin's own endpoints (`/api/auth/admin/*`) read it. The
 * oRPC procedures check the same table directly, without a database trip.
 */
export const accessControl = createAccessControl(ACCESS_STATEMENTS)

export const accessRoles = {
  admin: accessControl.newRole(ACCESS_ROLES.admin),
  programmeTech: accessControl.newRole(ACCESS_ROLES.programmeTech),
  moderation: accessControl.newRole(ACCESS_ROLES.moderation),
  regieMobile: accessControl.newRole(ACCESS_ROLES.regieMobile),
  synthese: accessControl.newRole(ACCESS_ROLES.synthese),
  readonly: accessControl.newRole(ACCESS_ROLES.readonly),
}
