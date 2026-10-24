/**
 * Stands in for the `typescript` package when strip.js is bundled
 * (build.sh: `--alias:typescript=./src/typescript-global.ts`): the runner
 * loads typescript.js itself and puts it here before importing strip.js.
 */
import type * as TS from 'typescript';

const ts = (globalThis as { [key: symbol]: unknown })[Symbol.for('yukibana.typescript')] as typeof TS | undefined;
if (!ts) throw new Error('strip.js was imported before the runner loaded TypeScript');
export default ts;
