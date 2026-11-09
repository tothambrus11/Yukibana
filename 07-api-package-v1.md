# refactor(api)!: one zod definition per endpoint, served under /api/v1

**Labels:** `area:packages`, `area:cloud`, `breaking`, `size:L`

**Builds on** the monorepo PR (steps 1 to 5 of the plan, branch `claude/project-thread-0o3t0y`). First part of plan
step 8 (§8.1, §8.2).

## Goal

The Worker and its clients share one definition of the API, so they cannot disagree, and the API has a version, so a
later breaking change can be a new one. This fixes problem 2 of §1 (the wire types exist twice) and the first half of
problem 5 (`/api/*` has no version).

Today the two sides are `cloud/web/src/lib/api.ts` (145 lines of interfaces, imported by `lib/server/catalogue.ts`,
`lib/server/errors.ts`, `routes/+layout.server.ts`, `routes/api/auth/config/+server.ts` and
`routes/api/editions/[edition]/members/+server.ts`) and `packages/client/src/lib/wire.ts` (264 lines: the same types
again, plus zod decoders), "kept in sync by convention". Request bodies are checked by hand in each route (the members
`POST` reads `email` and `role` from an untyped object and ignores anything else).

## Scope

- **`packages/api`** (`@yukibana/api`, private, `0.0.0-dev`, zod only, browser-safe, catalog entry `workspace:*`). One
  module per endpoint, each with method, path template, path parameters, query schema, request body schema and
  response schema, plus the error body (`ErrorJson`). The endpoints, as they are today:
  - `GET /me`, `GET /editions`, `GET`/`POST`/`DELETE /editions/:edition/members` (`DELETE` takes `?email=`),
  - `GET /projects` (`?edition=`), `GET /projects/:project`,
  - `GET /projects/:project/submissions` (`?latest=`, `?author=`), `POST /projects/:project/submissions` (gzip body,
    `?release=`),
  - `GET /projects/:project/releases`, `POST /projects/:project/releases` (multipart: `starter`, `teacher`, `label`,
    `commit`, `release`),
  - `GET /projects/:project/starter`, `GET /releases/:release/:archive`, `GET /submissions/:submission`,
  - `GET /auth/config`.
  Request schemas are strict (`z.strictObject`), and the strictness covers query parameters and multipart field names
  too. Response schemas accept unknown fields on the client side. Types come from `z.infer`.
- **Worker**: the routes move from `cloud/web/src/routes/api/*` to `cloud/web/src/routes/api/v1/*`, without aliases.
  Each handler parses its request with the definition (a 400 whose message names the field, or the unknown field) and
  is typed against the response. `cloud/web/src/lib/api.ts` is deleted; its importers use `@yukibana/api`.
  `isApiPath` in `lib/server/errors.ts` keeps `/api/` (so `/api/me` is now a JSON 404, not a page).
- **Client**: `packages/client/src/lib/wire.ts` and `tests/wire.test.ts` are deleted. `packages/client/src/client.ts`
  decodes every response with the endpoint's schema and calls `/api/v1/...`; `session.ts` reads
  `/api/v1/auth/config`. `@yukibana/client` re-exports the types the IDE imports today (`Me`, `Project`, `Accepted`,
  `Submission`, `Release`, `Member`, `Edition`, `AuthConfig`), so `ide/extensions/*` does not change beyond that.
- **Tests and docs** that name `/api/`: `packages/client/tests/{client,session,publish,loopback}.test.ts`,
  `cloud/web/tests/{errors,forgery}.test.ts`, `cloud/web/tests/integration/{sibling.test.ts,mail.ts}`,
  `docs/cloud/{deploy,theia,cli,architecture,yukibana-json}.md`, and the pages that link to an API path
  (`lib/StudentProjects.svelte`, `routes/editions/[edition]/projects/[project]/+page.svelte`).

## Out of scope

- `Yukibana-Client`, `GET /api/v1/meta`, `minClient` and `blockBelow` (issue 08).
- How `/api/v1` is kept once `/api/v2` exists (§8.2: decided then).
- `/auth/*` routes (the login pages, the IDE login's consent and return routes): they are pages, not the API.

## Design decisions already made

- One zod schema per endpoint, request and response, in `packages/api`; the Worker's handlers typed against it; the
  client decodes with it; full zod (`zod/mini` only if the Worker's bundle size ever matters) (§8.1).
- `/api/v1/...` now, no aliases; the server rejects unknown request fields; clients ignore unknown response fields;
  adding a response field is allowed within a version, any other change needs `/api/v2` (§8.2).
- Submitting keeps working in every API version that exists (§8.2).

## Open questions

- Path parameters: plain uuid strings in the definition, or the Worker's branded ids (`ids.ts`, `uuidOf`)? Proposal:
  the definition checks the shape, the Worker brands at its boundary as today, so `@yukibana/api` does not import
  Worker code.
- Should a response field the client does not know be logged in development? Proposal: no.

## Acceptance criteria

- [ ] `cloud/web/src/lib/api.ts` and `packages/client/src/lib/wire.ts` are gone; `git grep "'/api/[a-z]"` finds only
      `/api/v1` paths.
- [ ] `@yukibana/api` unit tests, as a table over every endpoint: an unknown JSON field, an unknown query parameter
      and an unknown multipart field are each refused with a sentence naming it; a response with an extra field
      decodes.
- [ ] A type test that the client's decoded type for each endpoint is the definition's `z.output`.
- [ ] Integration (`cloud/web/tests/integration`): every endpoint answers under `/api/v1`; `/api/me` is a JSON 404;
      a request with an unknown field is a 400 and `tests.fingerprint()` is unchanged; publishing by token and by
      owner, and submitting, work end to end.
- [ ] `sibling.test.ts` passes, with every moved route read from `src/routes`.
- [ ] The Worker's bundle size before and after is in the PR description.
- [ ] Every new exported function, type and field has a contract comment in the project's style.

## Depends on / Blocks

- Depends on: nothing beyond the monorepo PR. It can go in parallel with 03 to 06 (expect small conflicts in
  `packages/client/src/client.ts`).
- Blocks: 08, and 10 (the published CLI speaks `/api/v1`).

## Manual steps for a maintainer

- None in code. Once deployed, the old CLI and the old Action (`action/action.yml` at any commit before this) stop
  working against production, and an IDE built from an older `main` with `YUKIBANA_REGISTRY` pointed at production
  does too. Accepted (no users); issue 13 updates the course repositories.

## Risks

- Rejecting unknown fields breaks a client that sends something extra; the integration suite runs the real client
  against the real Worker, which is the test of that.
- Multipart parsing differences in Workers (field order, file vs string fields) can turn a valid upload into a 400;
  the publish integration tests cover both token and owner paths.
