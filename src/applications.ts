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

export function isAppId(value: unknown): value is AppId {
  return typeof value === 'string' && value in applications;
}

/**
 * Whether `role` is one this application actually enforces.
 *
 * Both the write path and the read path go through this, which is what keeps
 * them honest with each other: a role the Access Manager refuses to write is
 * also one a consuming app would refuse to read, so there is no way to end up
 * with a grant that is stored but inert.
 */
export function isValidRole(app: AppId, role: unknown): boolean {
  return (
    typeof role === 'string' &&
    (applications[app].roles as readonly string[]).includes(role)
  );
}
