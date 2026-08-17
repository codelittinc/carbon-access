# @codelittinc/carbon-access

The registry of Carbon applications, and the access checks every internal app
shares. Authorization for the Carbon fleet lives on the Clerk user, as one field:

```json
{ "access": { "player-scoreboard": "admin", "access-manager": "admin" } }
```

Clerk projects that field into the session token as the `access` claim, so an app
reads a user's grants with no API call. An application not present in `access`
cannot be reached.

Grants are made in the **Access Manager** ([codelittinc/carbon-gatekeeper](https://github.com/codelittinc/carbon-gatekeeper)),
which is the only thing that writes them. This package only _reads_ — plus the
pure transforms the Access Manager uses to compute what to write.

```
publicMetadata.access   ← written only by the Access Manager (Clerk Backend API)
      ↓  {{user.public_metadata.access}}
session claim `access`  ← read by every app, zero API calls
      ↓
roleFor(sessionClaims, 'player-scoreboard')
```

## Why this is a separate, public repo

It has to be installable by every Carbon app with **no credentials**, in GitHub
Actions and inside `docker build` alike. A `github:` dependency on a _private_
repo falls back to `git clone` and needs an SSH key or a cross-repo token in
every builder — which also breaks the property those repos rely on, that a build
needs no secrets at all. A public repo resolves as a plain tarball from
`codeload.github.com`, which is how `@codelittinc/carbon-design-system` already
works.

Nothing here is sensitive: no keys, no credentials, no hostnames, no user data.
The registry is a list of internal application ids, display names and role names,
and knowing one grants nothing — enforcement is Clerk-side, and
`publicMetadata` is writable only through the Backend API with
`CLERK_SECRET_KEY`.

**Keep it that way.** This repo is public, so anything committed here is public.
Application descriptions should stay bland; the `id` is the only load-bearing
part. If an application should not be publicly known to exist, do not add it —
raise it with the Access Manager's owners instead.

## Install

```jsonc
"@codelittinc/carbon-access": "github:codelittinc/carbon-access#<sha>"
```

Pin a **SHA**, not a branch — same discipline as the design system. Unpinned, the
set of valid roles could change under a deployed app without a deploy, and the
symptom of that is people losing access.

The package ships TypeScript source rather than a build, so bundlers need to be
told to compile it:

```ts
// next.config.ts
transpilePackages: ['@codelittinc/carbon-access'],
```

Express/`tsx` apps need nothing.

## Use

```ts
import { roleFor } from '@codelittinc/carbon-access';

const { userId, sessionClaims } = await auth(); // @clerk/nextjs/server
if (!userId) return denied('signed-out');

const role = roleFor(sessionClaims, 'player-scoreboard');
if (!role) return denied('no-access');
```

`roleFor` also accepts a Clerk user's raw `publicMetadata`, so the same function
serves the free claim-based check and an authoritative Backend API read.

|                                   |                                         |
| --------------------------------- | --------------------------------------- |
| `readAccess(source)`              | every valid grant, as `{ appId: role }` |
| `roleFor(source, app)`            | that app's role, or `null`              |
| `hasAccess(source, app)`          | any role at all                         |
| `hasRole(source, app, role)`      | exactly this role                       |
| `unknownGrants(source)`           | grants naming something unrecognised    |
| `withRole(access, app, role)`     | pure — `access` plus that grant         |
| `withoutApp(access, app)`         | pure — `access` minus that app          |
| `applications`, `applicationList` | the registry                            |
| `isAppId`, `isValidRole`          | registry membership                     |

**Every read fails closed.** A grant whose application is not in the registry,
whose role that application does not declare, or that is not a string is dropped
— individually, so one junk entry cannot cost a user their other grants, and
silently, because a check that throws is a check one bad metadata edit can turn
into an outage. That behaviour is the reason this package has tests; the happy
path is exercised by running the apps.

## Adding an application

1. Add an entry to `src/applications.ts` with the roles it actually enforces,
   **least privileged first** — the Access Manager selects the first entry when
   access is granted, so the order decides what a slipped toggle grants.
2. Merge, then pin the new SHA in the consuming app.

Removing an entry does not clear anyone's Clerk metadata. Those grants stop being
_readable_, which is the fail-closed direction; the Access Manager shows them as
unrecognised leftovers rather than hiding them.

## One manual step, once per Clerk instance

The claim has no API. Clerk Dashboard → **Sessions → Customize session token →
Claims**:

```json
{ "access": "{{user.public_metadata.access}}" }
```

Carbon runs one Clerk application per apex, so this is per instance, and **grants
do not follow across apexes** — `carbonresidential.dev` and
`carbonresidential.com` hold separate user records for the same person. An
instance without the claim mints tokens carrying no `access`, every app reads "no
grants", and everyone is locked out — while the Access Manager still appears to
save correctly, because it is.

Full walkthrough, including a copy-paste `lib/auth.ts` for Next.js and Express:
[`docs/integrating.md`](https://github.com/codelittinc/carbon-gatekeeper/blob/main/docs/integrating.md).
