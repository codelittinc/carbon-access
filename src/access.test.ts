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
import { applications, isAppId, isValidRole } from './applications';

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

/**
 * Prototype-chain keys.
 *
 * `isAppId` used the `in` operator, which walks the prototype chain, so every
 * member of `Object.prototype` was accepted as an application id; `isValidRole`
 * then read `.roles` off `Object.prototype` (or off the `Object` constructor,
 * or a function) and threw on `undefined.includes`.
 *
 * Not a hypothetical shape. Clerk stores metadata as JSON, and
 * `JSON.parse('{"__proto__":"admin"}')` yields an OWN enumerable `__proto__`
 * that `Object.entries` hands straight to the loop in `readAccess`.
 *
 * It broke both guarantees at once: the throw took the user's *valid* grants
 * with it, and an authorization check became a 500 rather than a denial — so one
 * bad edit in the Clerk dashboard was an outage on every gated page.
 */
describe('prototype-chain keys are not application ids', () => {
  // Everything reachable on Object.prototype, plus the two the JSON path makes
  // easiest to inject.
  const POLLUTED = [
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    'toLocaleString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    '__defineGetter__',
    '__lookupGetter__',
  ];

  it.each(POLLUTED)('rejects %s as an application id', (key) => {
    expect(isAppId(key)).toBe(false);
  });

  it.each(POLLUTED)('readAccess drops %s without throwing', (key) => {
    expect(() => readAccess({ access: { [key]: 'admin' } })).not.toThrow();
    expect(readAccess({ access: { [key]: 'admin' } })).toEqual({});
  });

  it.each(POLLUTED)('unknownGrants reports %s without throwing', (key) => {
    expect(() => unknownGrants({ access: { [key]: 'admin' } })).not.toThrow();
    expect(unknownGrants({ access: { [key]: 'admin' } })).toEqual([
      { app: key, role: 'admin' },
    ]);
  });

  it('does not let a polluted key cost the user their real grants', () => {
    // The regression that mattered: the throw discarded everything, so a user
    // with legitimate access lost it because of an unrelated junk key.
    const access = readAccess({
      access: { __proto__: 'admin', 'player-scoreboard': 'admin' },
    });
    expect(access).toEqual({ 'player-scoreboard': 'admin' });
  });

  it('survives the exact JSON shape Clerk would store', () => {
    const metadata = JSON.parse(
      '{"access":{"__proto__":"admin","access-manager":"admin"}}',
    );
    // Proof the key really is own+enumerable, so the loop does visit it.
    expect(Object.prototype.hasOwnProperty.call(metadata.access, '__proto__')).toBe(
      true,
    );
    expect(readAccess(metadata)).toEqual({ 'access-manager': 'admin' });
  });

  it.each(POLLUTED)('isValidRole answers false for %s rather than throwing', (key) => {
    // Exported, so reachable with a cast even once readAccess is correct.
    expect(() => isValidRole(key as never, 'admin')).not.toThrow();
    expect(isValidRole(key as never, 'admin')).toBe(false);
  });

  it('withRole refuses a polluted key with an explanatory error, not a TypeError', () => {
    let err: unknown;
    try {
      withRole({}, '__proto__' as never, 'admin' as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).constructor.name).toBe('Error');
    expect((err as Error).message).toMatch(/not a role of __proto__/);
  });

  it('never returns an object whose prototype was replaced', () => {
    const access = readAccess({ access: { __proto__: { polluted: true } } });
    expect(Object.getPrototypeOf(access)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
