# feat(project-schema): versioned yukibana.json schemas with compiler-checked migrations

**Labels:** `area:packages`, `feature`, `spike`, `size:M`

**Builds on** the monorepo PR (steps 1 to 5 of the plan, branch `claude/project-thread-0o3t0y`). First part of plan
step 7 (§7.1, §7.2, §17 spike S3).

## Goal

A package that knows every version of `yukibana.json` and `yukibana.release.json`, parses a file at its own version
and migrates it to the latest, with migrations the compiler checks. It fixes the root of problem 6 of §1 (one
`version: 1` has covered several shapes, and unknown fields are dropped silently) and prepares problem 7 (one schema
URL whose contents change).

Today `packages/client/src/lib/yukibana.ts` has one loose schema (`configSchema`, defaults everywhere, unknown keys
passed through with a warning, `submission.include` nullable, `$schema` optional, `projectId` and `releaseId` inside)
and a second view of it for the IDE (`settingsSchema`, `parseSettings`, `DEFAULT_SETTINGS`).

This issue adds the new package with its tests and changes no caller, so `main` keeps working. Issue 04 moves the ids
out, issue 05 switches every reader.

## Scope

1. **Spike S3** on a throwaway branch, first: `exact<T>()` and `Checked<B>` on TypeScript 7 (the catalog's compiler for
   `packages/*`) against the real v1 shape and a test-only v2. It must reject excess keys that come from a spread at
   the top level, in nested objects, in array elements, in record values, and in every branch of a union and of a
   discriminated union; it must stop at zod brands and primitives. Also check that the emitted `.d.ts` compiles under
   the `ts6` catalog (`cloud/web`'s `svelte-check` reads the package's declarations). Post the result here before the
   PR.
2. New package `packages/project-schema` (`@yukibana/project-schema`): private, `0.0.0-dev`, the license of issue 02's
   state, only `zod` as a dependency, browser-safe (no `node:` import), so the IDE's frontend and the Worker can import
   it. Built like `packages/client` (`tsconfig.build.json`, composite, `lib/`), with `lint`, `typecheck`, `test`
   scripts, and a `'@yukibana/project-schema': workspace:*` entry in the catalog (`catalogMode: strict`).
3. `src/exact.ts`: `exact<T>()`, the `Checked<B>` brand only it produces, and `Migration<A, B> = (a: A) => Checked<B>`.
4. `src/brands.ts`: zod brands for what TypeScript cannot see: a relative, non-empty glob list, a project id (uuidv7),
   a release id (uuid), each created only through its validating schema.
5. `src/v1.ts`: the strict, all-required v1, frozen once released:
   `$schema` (the literal `https://cloud.yukibana.dev/schema/yukibana/v1.json`), `version: 1`, `kind` (`KINDS`),
   `hidden`, `assignmentFile`, `features` (`codeSuggestions`, `squiggles`, `codeLenses`, `ai`), `layout` (`widgets`
   with its 7 flags, `containers`, `views`), `openFiles`, `readOnly`, `submission` (`include` as a list, `["**"]`
   meaning everything; `exclude`; `respectGitignore`; `target`; `filename`; `maxBytes`), `telemetry`
   (`liveTypingStats`). No `projectId`, no `releaseId`. Every field's `.describe()` text is today's `about(...)` text,
   reworded where a default no longer exists.
6. `src/release-file.ts`: `yukibana.release.json` v1, `{ "version": 1, "projectId": ..., "releaseId": ... }`, strict and
   all required.
7. `src/index.ts`: `ProjectFile` (the latest version's type), `LATEST`, `parseProjectFile(text)` and
   `parseReleaseFile(text)`. The result is either the parsed file (the latest type, and the version and value it was
   written at, which issue 05 needs to write a starter at the teacher's version) or a structured error: not JSON, not
   an object, `version` missing (naming the field), a version newer than `LATEST` (with the number, so each host
   phrases "This project needs yukibana.json v3; this IDE reads up to v2"), an unknown older version, or field errors
   (every issue, each naming its field, as today's `sentence` does). `NO_PROJECT_FILE`: one literal of the latest
   type, what a folder without a file opens with.
8. `src/migrations.ts`: the chain, typed so each step's input is the previous step's output. Empty while v1 is the
   only version.
9. The zod-issue-to-sentence helpers (`packages/client/src/lib/issues.ts`: `expectation`, `fieldOf`) move here, and
   `@yukibana/client` imports them, so `packages/api` (issue 07) can too.

## Out of scope

- Any caller (issues 04 and 05), the JSON Schema files and the route (05), the corpus, `config init`/`upgrade` and the
  IDE's schema registration (06).

## Design decisions already made

- zod 4, the full build (§0, and `yukibana.ts`'s own note on `zod/mini`).
- Strict and all-required from v1; `$schema` a literal per version; unknown keys rejected; no nullable field where a
  value says the same; no transforms; any change in meaning is a new version, a new `kind` included; a newer version
  fails naming both numbers; a missing `version` fails naming the field; `NO_PROJECT_FILE` is a literal of the latest
  type (§7.1).
- `Migration<A, B>`, `Checked<B>` only from `exact<B>()`, brands for refinements, no runtime re-validation of migration
  output (§7.2).
- The release file's shape (§7.3).
- `packages/*` are private, have no Theia dependency, build to `lib/` (§2).

## Open questions

- If S3 finds no `exact<T>()` that handles discriminated unions on TypeScript 7, the fallback is a unit test per
  migration that parses its output with the next version's strict schema. That contradicts §7.2's "no runtime test
  re-validates", so it needs the maintainer's yes.
- `submission.target` is any string today; v1 should make it `z.enum(['cloud', 'file'])`. Confirm.
- `openFiles` stays a list of plain paths (not globs), as today. Confirm.

## Acceptance criteria

- [ ] S3's result is posted here, with the implementation chosen and any limit found.
- [ ] Type tests (run by `tsc` in the package's `typecheck`, with `@ts-expect-error` for the negatives): an excess key
      from a spread is rejected at the top level, in a nested object, in an array element, in a record value, in each
      union branch and each discriminated-union branch; brands and primitives pass through; a migration that returns
      an object without `exact()` does not compile.
- [ ] A type test that `z.input<typeof v1>` equals `z.output<typeof v1>`, and the same for the release file.
- [ ] The declarations compile under the `ts6` catalog (a `tsc` run with TypeScript 6 over a file that imports them).
- [ ] Unit tests, as negatives: a misspelt `"hiden"` is rejected naming it; each missing field is named; `version: 2`
      reports "newer" with the number; a missing `version` names it; a `$schema` that does not match `version` is
      rejected; a relative-glob violation (`/abs`, `..`) is rejected; three mistakes give three sentences.
- [ ] A test-only v2 and `fromV1` (in `tests/`, not exported) exercise the chain end to end.
- [ ] A test fails if any file in `src/` imports a `node:` module.
- [ ] Every new exported function, type and field has a contract comment in the project's style.

## Depends on / Blocks

- Depends on: nothing beyond the monorepo PR.
- Blocks: 04, 05, 06.

## Manual steps for a maintainer

- None.

## Risks

- A recursive conditional type can make typechecking slow or hit "type instantiation is excessively deep"; S3 measures
  it on the real shape.
- TypeScript 6 and 7 can disagree on a complex conditional type; the `ts6` check catches it.
- `z.toJSONSchema` may drop a refinement's meaning (brands, custom checks); issue 05 checks the generated schema.
