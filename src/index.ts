/**
 * @codelittinc/carbon-access — the Carbon application registry and the access checks every
 * internal app shares.
 *
 * Consumed as a pinned git dependency; see docs/integrating.md for the install
 * line, the Clerk dashboard step that produces the `access` claim, and a
 * copy-paste `lib/auth.ts`.
 *
 * Deliberately free of runtime dependencies and of any framework import, so the
 * same module serves a Next.js server component (`auth()`), an Express route
 * (`getAuth(req)`), and this repo's own admin writes.
 */
export {
  applications,
  applicationList,
  isAppId,
  isValidRole,
  type AppId,
  type AnyRole,
  type ApplicationDefinition,
  type RoleOf,
} from './applications';

export {
  readAccess,
  unknownGrants,
  roleFor,
  hasAccess,
  hasRole,
  withRole,
  withoutApp,
  type AccessMap,
  type AccessSource,
} from './access';
