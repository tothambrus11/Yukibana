/**
 * TypeScript to JavaScript for the runner, as `node` runs a `.ts` file: the
 * types are erased by replacing them with whitespace (ts-blank-space, over
 * TypeScript's own parser), so every line and column of the output is the
 * line and column of the source. Stack traces, `node:test`'s `test at
 * file:line:col` and `assert.ok`'s quoted expression point into the `.ts`
 * file with no source map, which a worker's `Error.stack` would not apply
 * anyway.
 *
 * A separate module (`strip.js`), imported by the runner only for a project
 * with TypeScript in it, after it has loaded typescript.js: ts-blank-space
 * uses `typescript` as soon as it is evaluated, and here `typescript` is the
 * copy the runner loaded (see typescript-global.ts), the same file the
 * language server downloads, so the browser fetches and caches it once.
 */
export { blankSourceFile } from 'ts-blank-space';
