/**
 * Reading and editing a user's application access.
 *
 * The store is one field on the Clerk user — `publicMetadata.access` — mapping
 * an application id to a single role:
 *
 *   { "access": { "player-scoreboard": "admin", "access-manager": "admin" } }
 *
 * Clerk projects that field into the session token as the `access` claim (see
 * docs/integrating.md), so both shapes an app can hold — the claims object from
 * `auth()` and the raw `publicMetadata` from the Backend API — have an `access`
 * property and are read by the same function here. That is why these take
 * `unknown` rather than a typed argument: the two callers get their value from
 * different SDKs, and neither SDK's type says anything useful about a field we
 * put there ourselves.
 *
 * ── Everything here FAILS CLOSED ──────────────────────────────────────────────
 *
 * A grant is only returned if its application is in the registry AND its role
 * is one that application enforces. Anything else — an app that was removed
 * from the registry, a role that was renamed, a hand-edited metadata blob, a
 * token from before a rename — is dropped, silently and individually.
 *
 * Silently, because the alternative is throwing inside an authorization check,
 * and a check that can throw is a check that can be turned into an outage by
 * one bad metadata edit. Individually, because a single junk entry must not
 * take a user's other grants down with it.
 *
 * Nothing here is a security boundary on its own. The claim is signed by Clerk
 * and verified by the SDK before it reaches this code; this decides what a
 * verified claim MEANS. The boundary is the caller checking the answer on the
 * server before it does the thing.
 */
import {
  applications,
  isAppId,
  isValidRole,
  type AppId,
  type RoleOf,
} from './applications';

/**
 * A user's grants: at most one role per application.
 *
 * One role rather than a set because roles here are a ladder, not a bag of
 * permissions — `admin` on an app implies everything `viewer` on that app can
 * do. An app that genuinely needs orthogonal capabilities wants its own model,
 * not a second role in this map.
 */
export type AccessMap = { [A in AppId]?: RoleOf<A> };

/** Anything that might carry an `access` field: session claims, or metadata. */
export interface AccessSource {
  access?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pull the raw `access` object out of a claims or metadata blob.
 *
 * Also accepts the inner map on its own, so a caller that has already narrowed
 * to `publicMetadata.access` does not have to re-wrap it. The two are told
 * apart by looking for a nested `access` key, which no application id can
 * collide with as long as nothing in the registry is named `access` — the
 * assertion below is what keeps that true.
 */
function rawAccess(source: unknown): Record<string, unknown> | null {
  if (!isPlainObject(source)) return null;
  if ('access' in source) {
    return isPlainObject(source.access) ? source.access : null;
  }
  return source;
}

// Guards `rawAccess`'s heuristic above. Adding an app called `access` would
// make a bare access map indistinguishable from a wrapper, and the failure
// would be a silent denial for that one app rather than anything that looks
// like a bug. Cheap to assert at module load; impossible to debug later.
if ('access' in applications) {
  throw new Error(
    "An application may not be called 'access' — it collides with the metadata " +
      'field and the session claim of the same name.',
  );
}

/**
 * Every valid grant in `source`. Invalid ones are dropped; see the header.
 *
 * `source` may be session claims (`await auth()` → `sessionClaims`), a Clerk
 * user's `publicMetadata`, or the access map itself.
 */
export function readAccess(source: unknown): AccessMap {
  const raw = rawAccess(source);
  if (!raw) return {};

  const access: Record<string, string> = {};
  for (const [app, role] of Object.entries(raw)) {
    if (!isAppId(app)) continue;
    if (!isValidRole(app, role)) continue;
    access[app] = role as string;
  }
  return access as AccessMap;
}

/**
 * Grants that name something the registry does not recognise.
 *
 * Not used for any decision — `readAccess` has already dropped these, and they
 * grant nothing. It exists so the Access Manager can SHOW the leftovers rather
 * than appearing to lose data: after an application is retired, its grants stay
 * in everyone's metadata, and an editor that silently omitted them would look
 * like it had eaten them.
 */
export function unknownGrants(source: unknown): { app: string; role: unknown }[] {
  const raw = rawAccess(source);
  if (!raw) return [];
  return Object.entries(raw)
    .filter(([app, role]) => !isAppId(app) || !isValidRole(app, role))
    .map(([app, role]) => ({ app, role }));
}

/** The user's role for one application, or `null` if they have no access. */
export function roleFor<A extends AppId>(source: unknown, app: A): RoleOf<A> | null {
  return (readAccess(source)[app] as RoleOf<A> | undefined) ?? null;
}

/** Whether the user may reach this application at all, at any role. */
export function hasAccess(source: unknown, app: AppId): boolean {
  return roleFor(source, app) !== null;
}

/**
 * Whether the user holds exactly this role.
 *
 * Exact, not "at least" — the registry orders roles by privilege but does not
 * claim they nest, and an app that wants `admin` to satisfy a `viewer` check
 * should say so at its own call site rather than have it assumed here.
 */
export function hasRole<A extends AppId>(
  source: unknown,
  app: A,
  role: RoleOf<A>,
): boolean {
  return roleFor(source, app) === role;
}

/**
 * `access` with `app` set to `role` — a new object; the input is untouched.
 *
 * Pure, and separate from anything that talks to Clerk, so the rules about what
 * a grant may be are unit-testable without a network and are enforced in one
 * place rather than at each call site in the UI.
 */
export function withRole<A extends AppId>(
  access: AccessMap,
  app: A,
  role: RoleOf<A>,
): AccessMap {
  if (!isValidRole(app, role)) {
    throw new Error(
      `${String(role)} is not a role of ${app}. Valid roles: ` +
        `${applications[app].roles.join(', ')}.`,
    );
  }
  return { ...access, [app]: role };
}

/** `access` without `app`. Removing an app that is absent is a no-op. */
export function withoutApp(access: AccessMap, app: AppId): AccessMap {
  const next = { ...access };
  delete next[app];
  return next;
}
