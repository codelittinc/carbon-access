/**
 * The registry of Carbon applications, and the only place an application id or
 * a role name is ever defined.
 *
 * Everything downstream is derived from this object: the Access Manager builds
 * its whole editor from it (an admin picks from these controls rather than
 * typing an id), `readAccess` drops any grant naming something not listed here,
 * and the `AppId` / `RoleOf` types make a typo in a consuming app a compile
 * error rather than a silent denial.
 *
 * Roles are deliberately PER APPLICATION rather than a shared enum. Player
 * Scoreboard has exactly one meaningful role — you administer move-in goals or
 * you have no business on the screen — while an app like Carbon OS will want a
 * viewer/user/admin ladder. A shared enum would let `reporting: 'admin'` and
 * `player-scoreboard: 'viewer'` both typecheck, and neither means anything.
 *
 * ── Adding an application ────────────────────────────────────────────────────
 *
 *   1. Add an entry here, with the roles that application actually enforces.
 *   2. Merge, then pin that commit in the consuming app's package.json — see
 *      docs/integrating.md.
 *
 * Removing an entry does NOT clear it from anyone's Clerk metadata; it stops
 * being *readable*, which is the fail-closed direction, and the Access Manager
 * will show it as an unrecognised leftover.
 */

export interface ApplicationDefinition {
  /** Human name, as it appears in the Access Manager and nowhere else. */
  readonly name: string;
  /** One line on what the app is, shown under the name in the editor. */
  readonly description: string;
  /**
   * Every role this application enforces, least privileged first. The first
   * entry is what the editor selects when access is first granted, so the
   * order is a safety property, not a cosmetic one.
   */
  readonly roles: readonly string[];
}

export const applications = {
  'access-manager': {
    name: 'Access Manager',
    description: 'This app — grants and revokes access to everything else.',
    roles: ['admin'],
  },
  'player-scoreboard': {
    name: 'Player Scoreboard',
    description: 'Leasing move-in goals and the data explorer at /admin.',
    roles: ['admin'],
  },
} as const satisfies Record<string, ApplicationDefinition>;

/** A known application id. Anything else is not an application. */
export type AppId = keyof typeof applications;

/** The roles a given application enforces — `'admin'` for both apps today. */
export type RoleOf<A extends AppId> = (typeof applications)[A]['roles'][number];

/** Any role of any application, for code that is generic across apps. */
export type AnyRole = { [A in AppId]: RoleOf<A> }[AppId];

/** The registry as a list, in declaration order — what the editor renders. */
export const applicationList = Object.entries(applications).map(([id, definition]) => ({
  id: id as AppId,
  ...definition,
}));

/**
 * Whether `value` names an application in the registry.
 *
 * `Object.hasOwn`, NOT the `in` operator. `in` walks the prototype chain, so it
 * answers true for every member of `Object.prototype` — `__proto__`,
 * `constructor`, `toString`, `valueOf`, `hasOwnProperty` and the rest. Those are
 * reachable keys, not a hypothetical: Clerk stores metadata as JSON, and
 * `JSON.parse('{"__proto__":"admin"}')` produces an OWN enumerable `__proto__`
 * that `Object.entries` duly hands to this function.
 *
 * With `in`, such a key was accepted as an application id, `isValidRole` then
 * looked up `applications['__proto__'].roles` — `undefined` on
 * `Object.prototype` — and threw. That broke the two guarantees this package is
 * built on at once: a junk entry took the user's *valid* grants down with it,
 * and an authorization check became a 500 instead of a denial. One bad
 * administrative edit in the Clerk dashboard was an outage on every gated page.
 *
 * Do not "simplify" this back to `in`.
 */
export function isAppId(value: unknown): value is AppId {
  return typeof value === 'string' && Object.hasOwn(applications, value);
}

/**
 * Whether `role` is one this application actually enforces.
 *
 * Both the write path and the read path go through this, which is what keeps
 * them honest with each other: a role the Access Manager refuses to write is
 * also one a consuming app would refuse to read, so there is no way to end up
 * with a grant that is stored but inert.
 *
 * Re-checks the application itself rather than trusting the `AppId` type. This
 * is exported, so a caller with a cast — or a `readAccess` regression — can
 * reach it with a prototype key, and this must answer `false` rather than throw
 * on the missing `.roles`. Belt and braces on purpose: the cost is one property
 * lookup, and the failure it prevents is an outage.
 */
export function isValidRole(app: AppId, role: unknown): boolean {
  if (typeof role !== 'string') return false;
  if (!Object.hasOwn(applications, app)) return false;
  return (applications[app].roles as readonly string[]).includes(role);
}
