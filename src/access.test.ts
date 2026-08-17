import { describe, expect, it } from 'vitest';
import {
  hasAccess,
  hasRole,
  readAccess,
  roleFor,
  unknownGrants,
  withRole,
  withoutApp,
  type AccessMap,
} from './access';
import { applications, isValidRole } from './applications';

/**
 * These are the tests that matter, because every one of them describes a way a
 * user could end up with more access than someone granted them. The happy path
 * is exercised by simply running the app; a metadata blob that has drifted out
 * of step with the registry is not.
 *
 * `as never` / `as any` appear where a case is deliberately not expressible in
 * the type system — the point of the case is that the value arrives at runtime
 * anyway, out of a database Clerk lets a human hand-edit.
 */
describe('readAccess', () => {
  it('reads grants from session claims', () => {
    expect(readAccess({ access: { 'player-scoreboard': 'admin' } })).toEqual({
      'player-scoreboard': 'admin',
    });
  });

  it('reads the same shape from publicMetadata', () => {
    // Same function on purpose: the claim and the metadata field are the same
    // object, so a divergence between the two readers is impossible by design.
    const metadata = { access: { 'access-manager': 'admin' }, theme: 'dark' };
    expect(readAccess(metadata)).toEqual({ 'access-manager': 'admin' });
  });

  it('reads a bare access map', () => {
    expect(readAccess({ 'access-manager': 'admin' })).toEqual({
      'access-manager': 'admin',
    });
  });

  it('drops an application that is not in the registry', () => {
    const access = readAccess({
      access: { 'player-scoreboard': 'admin', 'retired-app': 'admin' },
    });
    expect(access).toEqual({ 'player-scoreboard': 'admin' });
  });

  it('drops a role the application does not enforce', () => {
    // The exact shape of a renamed role, or of someone guessing in the Clerk
    // dashboard. It must grant nothing rather than grant *something*.
    expect(readAccess({ access: { 'player-scoreboard': 'viewer' } })).toEqual({});
  });

  it('drops a grant whose role is not a string', () => {
    for (const role of [true, 1, null, ['admin'], { role: 'admin' }]) {
      expect(readAccess({ access: { 'player-scoreboard': role } })).toEqual({});
    }
  });

  it('keeps valid grants alongside invalid ones', () => {
    // One junk entry must not cost a user the access they legitimately have.
    const access = readAccess({
      access: {
        'player-scoreboard': 'admin',
        'access-manager': 'superuser',
        nonsense: 'admin',
      },
    });
    expect(access).toEqual({ 'player-scoreboard': 'admin' });
  });

  it('returns nothing for anything that is not an access-shaped object', () => {
    for (const source of [
      null,
      undefined,
      'admin',
      42,
      [],
      { access: null },
      { access: 'admin' },
      { access: [] },
      { access: ['player-scoreboard'] },
    ]) {
      expect(readAccess(source)).toEqual({});
    }
  });

  it('treats a user with no access field as having no access', () => {
    expect(readAccess({ theme: 'dark' })).toEqual({});
    expect(hasAccess({}, 'player-scoreboard')).toBe(false);
  });
});

describe('unknownGrants', () => {
  it('surfaces leftovers so the editor can show them', () => {
    expect(
      unknownGrants({
        access: { 'player-scoreboard': 'admin', 'retired-app': 'viewer' },
      }),
    ).toEqual([{ app: 'retired-app', role: 'viewer' }]);
  });

  it('counts a known app with an unknown role as a leftover', () => {
    expect(unknownGrants({ access: { 'player-scoreboard': 'viewer' } })).toEqual([
      { app: 'player-scoreboard', role: 'viewer' },
    ]);
  });

  it('is empty when every grant is valid', () => {
    expect(unknownGrants({ access: { 'access-manager': 'admin' } })).toEqual([]);
  });
});

describe('roleFor / hasAccess / hasRole', () => {
  const claims = { access: { 'player-scoreboard': 'admin' } };

  it('answers for a granted application', () => {
    expect(roleFor(claims, 'player-scoreboard')).toBe('admin');
    expect(hasAccess(claims, 'player-scoreboard')).toBe(true);
    expect(hasRole(claims, 'player-scoreboard', 'admin')).toBe(true);
  });

  it('answers null for an application the user was not granted', () => {
    // The default for an app absent from the map — which is the whole point of
    // the model: not listed means no access, never "some access".
    expect(roleFor(claims, 'access-manager')).toBeNull();
    expect(hasAccess(claims, 'access-manager')).toBe(false);
    expect(hasRole(claims, 'access-manager', 'admin')).toBe(false);
  });

  it('does not let a grant on one application answer for another', () => {
    expect(hasRole(claims, 'access-manager', 'admin')).toBe(false);
  });
});

describe('isValidRole', () => {
  it('accepts the roles an application declares', () => {
    for (const [app, definition] of Object.entries(applications)) {
      for (const role of definition.roles) {
        expect(isValidRole(app as never, role)).toBe(true);
      }
    }
  });

  it('rejects a role no application declares', () => {
    expect(isValidRole('player-scoreboard', 'standard')).toBe(false);
    expect(isValidRole('player-scoreboard', '')).toBe(false);
    expect(isValidRole('player-scoreboard', undefined)).toBe(false);
  });
});

describe('withRole / withoutApp', () => {
  it('adds a grant without touching the input', () => {
    const before: AccessMap = { 'player-scoreboard': 'admin' };
    const after = withRole(before, 'access-manager', 'admin');

    expect(after).toEqual({ 'player-scoreboard': 'admin', 'access-manager': 'admin' });
    expect(before).toEqual({ 'player-scoreboard': 'admin' });
  });

  it('replaces an existing role rather than accumulating', () => {
    const after = withRole(
      { 'player-scoreboard': 'admin' },
      'player-scoreboard',
      'admin',
    );
    expect(after).toEqual({ 'player-scoreboard': 'admin' });
  });

  it('refuses a role the application does not enforce', () => {
    // Throws rather than dropping, because unlike the read path this is a
    // caller passing something impossible — a bug worth surfacing, not
    // untrusted data to be tolerated.
    expect(() => withRole({}, 'player-scoreboard', 'viewer' as never)).toThrow(
      /not a role of player-scoreboard/,
    );
  });

  it('removes a grant, and removing an absent one is a no-op', () => {
    expect(withoutApp({ 'player-scoreboard': 'admin' }, 'player-scoreboard')).toEqual(
      {},
    );
    expect(withoutApp({ 'player-scoreboard': 'admin' }, 'access-manager')).toEqual({
      'player-scoreboard': 'admin',
    });
  });

  it('round-trips through readAccess', () => {
    // The editor writes what this produces and every app reads it back with
    // readAccess; if those two disagreed, a grant would appear to save and then
    // do nothing.
    const written = withRole({}, 'player-scoreboard', 'admin');
    expect(readAccess({ access: written })).toEqual(written);
  });
});
