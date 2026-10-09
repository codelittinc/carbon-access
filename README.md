# @codelittinc/carbon-users-metadata

The contract every Carbon app follows for what it stores on the shared Clerk
user: **who may use it** (`access`) and, as they are added, the user's
per-app settings (`preferences`). Both live on the Clerk user instead of in each
app's own database.

> Renamed from `carbon-access` on 2026-10-09, when per-app preferences joined
> access. GitHub redirects the old URL.

All Carbon apps on one apex domain sign in through one Clerk instance, so one
person's access to every app can live in one place: their Clerk user's metadata.
Each app keeps its own entry, manages it from its own admin screen, and reads it
on every request.

> **Status: spec only.** This repo currently holds the contract, not code. The
> reference implementation is being built in Player Scoreboard
> ([player-scoreboard-v2#54](https://github.com/codelittinc/player-scoreboard-v2/issues/54)).
> Once that has run in production, its shareable module moves here as a
> TypeScript package. Until then, follow this document.
>
> Versions up to `0.1.1` held an earlier design: a plain role string per app,
> read from a session claim and written only by a central Access Manager. That
> design was abandoned and **must not be used**. It remains in the git history.

## Why this repo is public

Apps must be able to install the package with **no credentials**, in GitHub Actions
and inside `docker build`. A `github:` dependency on a private repo needs a key in
every builder; a public one resolves as a plain tarball, the same way
`@codelittinc/carbon-design-system` does.

**Keep it that way.** Nothing committed here may be sensitive: no keys, no
credentials, no hostnames, no user data. Enforcement happens inside Clerk:
`publicMetadata` can only be written through the Backend API with a secret key.

## The shape

```jsonc
// publicMetadata: readable by the signed-in user, writable only by a backend
{
  "access": {
    "player-scoreboard": { "roles": ["admin"], "status": "active" },
    "some-other-app":    { "roles": ["viewer", "editor"], "status": "invited" }
  }
}

// privateMetadata: backend-only
{
  "access": {
    "player-scoreboard": {
      "invitedBy": "someone@example.com",      // an email, "seed", or null for legacy data
      "firstSignInAt": "2026-10-09T12:00:00Z"  // ISO timestamp, or null if they haven't visited
    }
  }
}
```

| Field                     | Meaning                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| key (`player-scoreboard`) | The app's id: kebab-case, the same on every Clerk instance. Use the same slug the app already uses elsewhere, such as its analytics `app` tag. |
| `roles`                   | The app's own role words. The app owns this vocabulary; nothing here constrains it.                                                            |
| `status`                  | `invited` (granted, never visited), `active` (has visited) or `revoked`.                                                                       |
| no key                    | The person never had access to that app.                                                                                                       |

`revoked` keeps `roles`, so restoring someone gives back the role they had.
Telling `revoked` apart from "no key", and `invited` apart from `active`, is what
lets an admin screen offer Restore and show who has never signed in.

## Rules

Each rule exists because breaking it causes a specific failure. They apply to
every app, whatever its stack.

### Writing

1. **Write only your own key**, in both public and private metadata.
2. **Always use `updateUserMetadata`**, which deep-merges. Never use
   `replaceUserMetadata`, which wipes every other app's entry. Remove a key by
   setting it to `null`. Arrays are replaced whole, which is what `roles` needs.
3. **Never use `unsafeMetadata`.** The user can write to it from their own browser.
4. **Serialise your own access changes.** Clerk has no conditional write, so two
   admins acting at once can each read a stale state. Take a lock, such as a
   Postgres advisory lock or whatever your stack has. Then re-read the Clerk user
   inside the lock, decide, and write. This is what makes rules like "you can't
   revoke the last admin" hold.

### Reading

5. **Read through the Backend API on every request**, with `currentUser()` or
   `getUser()`, deduplicated per request. **Do not put `access` in the session
   token.** It is too big for it: about 2.5KB at 30 apps, against Clerk's guidance
   of about 1.2KB for custom claims, because the token lives in a cookie. A revoke
   would also wait for the token to refresh.
6. **Validate only your own entry, and fail closed.** If your entry isn't an
   object, `roles` isn't an array of roles you know, or `status` isn't one of the
   three values, refuse access and report an error. Never judge another app's
   entry, whatever its shape.
7. **A Clerk error is "can't check", never "allowed".** That includes a `429`.
   Show a "can't check your access right now" screen, and never retry in a loop
   while serving a request.
8. **Match people on verified email addresses only.** Otherwise someone could
   claim access by adding another person's address, unverified, to their own
   account.

### Lifecycle

9. **First visit.** When an `invited` user first reaches the app, the app itself
   sets `status: "active"` and `firstSignInAt`. Each app writes its own change:
   signing in to one Carbon app says nothing about having visited another.
10. **Inviting someone who already has a Clerk user:** write the entry directly.
11. **Inviting someone who doesn't:** call
    `createInvitation({ notify: false, ignoreExisting: true })` with your public
    entry. Clerk copies an invitation's metadata to the user only when they sign
    up **through the invitation link**. So:
    - show the admin the invitation link to send on;
    - on first sign-in, adopt any pending invitation for the user's verified email
      that carries your key: write the entry, then revoke the invitation.

    Invitations can't carry `privateMetadata` and can't be edited. Keep
    `invitedBy` in your audit log until the person activates. To restore a
    revoked invitee, create a new invitation.

12. **Audit is yours.** Clerk keeps no history of metadata changes. If you need
    "who changed what, when", record it in your own store, written inside the
    lock from rule 4.

## Preferences

Per-app user settings live in their **own map**, next to `access` and never
inside it. The first one is the theme.

```jsonc
// publicMetadata
{
  "access": { "player-scoreboard": { "roles": ["admin"], "status": "active" } },
  "preferences": { "player-scoreboard": { "theme": "light" } },
}
```

| Field   | Meaning                                                                              |
| ------- | ------------------------------------------------------------------------------------ |
| key     | The same app slug as in `access`. Settings are per app, so an app has its own theme. |
| `theme` | `light` or `dark`. A missing or unreadable value means "no choice yet".              |

**Why a separate map.** Access is validated strictly and fails closed (rule 6).
A preference must fail soft. If preferences lived inside the access entry, a bad
theme value could make the whole entry unreadable and lock the person out.

Rules, in addition to the access rules:

1. **Write only your own key**, with `updateUserMetadata` from a server action
   or route that has checked who is signed in. Write to that user's own id,
   taken from the session and never from input. Validate the value before
   writing. Never use `unsafeMetadata`: it can't be merged from the browser, so
   apps would overwrite each other's settings.
2. **Read it the same way as access**, from the user record you already fetch
   per request. Never put it in the session token.
3. **Validate only your own entry, and fail soft.** If it is missing or
   malformed, use the default. Never report it as an error, never refuse
   anything because of it, and never use it in an access decision.
4. **Theme default:** use the stored value; with none, follow the OS
   (`prefers-color-scheme`), and dark if the browser reports nothing. A local
   cache such as `localStorage` may mirror the stored value but must never
   override the OS when nothing is stored.
5. **Debounce writes.** Preference writes share the per-user write limit with
   access writes (about 5 per 10s). Combine rapid changes so a user sends at
   most about 2 writes per 3 seconds. On a `429`, keep the change locally and
   retry once after at least 10s.
6. **Write only when the user changes something.** Never write on page load,
   and skip a write that matches the stored value.

## Limits

These were measured on our instances, or taken from
[Clerk's rate-limit docs](https://clerk.com/docs/backend-requests/resources/rate-limits).
All Carbon instances are Clerk **production** instances.

| Limit                    | Scope                                      | What it means                                                              |
| ------------------------ | ------------------------------------------ | -------------------------------------------------------------------------- |
| 8KB                      | **each** metadata type separately (tested) | At 30 apps, public is about 2.5KB and private about 3.5KB. Plenty of room. |
| 1000 requests / 10s      | per instance, **shared by every app**      | One read per admin request is fine. Don't poll Clerk.                      |
| ~5 metadata writes / 10s | per user (measured; Clerk documents 10)    | One write per change. Never write the same user in a loop.                 |
| 100 invitations / hour   | per instance, **shared by every app**      | Never create invitations in bulk from a migration.                         |

A throttled request returns `429` with a `Retry-After` header. On the per-user
write limit we measured `Retry-After: 0`, so don't trust it. Request handlers
treat a `429` as a failure (rule 7). Scripts wait for `Retry-After`, or at least
10 seconds when it is `0` or missing, then retry.

Reads are consistent: `GET /users/{id}` and the user list return a metadata
write on the very next read (measured: 0 stale reads in 17 rounds). Re-reading
inside your lock (rule 4) therefore always sees the latest state.

## Moving an app onto this

1. **Choose the key and the role words.**
2. **Write a one-off migration script**, run per Clerk instance, that copies your
   existing allowlist into metadata. It must:
   - be idempotent, so a second run writes nothing;
   - be a dry run by default, writing only when you pass a flag;
   - do **one** paged user scan (`limit=500`) and match emails locally, not one
     lookup per row;
   - never overwrite an entry that already exists: report it as a conflict;
   - report an email that matches more than one Clerk user as ambiguous, and
     write nothing for it;
   - report rows with no Clerk user, without creating invitations or sending
     email;
   - check which instance it is talking to by decoding the host from the
     publishable key. **The `sk_live` / `sk_test` prefix doesn't tell you**:
     every Carbon instance, development included, uses live keys.
3. **Switch the gate** to the reading rules above.
4. **Keep writing the old table for one release** if you want a safe rollback.
   Then drop it.

## Prior art

- Versions `0.1.x` of this repo, and
  [player-scoreboard-v2#30](https://github.com/codelittinc/player-scoreboard-v2/pull/30),
  held the abandoned string-grant design.
- [player-scoreboard-v2#54](https://github.com/codelittinc/player-scoreboard-v2/issues/54)
  is the current design and its reference implementation.
