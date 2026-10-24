// Bundles src/stryker/index.ts (StrykerJS's instrumenter, its clear-text
// reporter and the metrics it reads) into one minified ES module for the
// runner's Mutate (README, "Mutation testing").
//
//   node tools/stryker.mjs <outfile>
//
// Nothing in the packages is changed. Stryker is a Node program, so the
// modules it imports from Node are given browser stand-ins here, at bundle
// time, each for a reason that is checked by test-run.mjs (the bundle's
// instrumented output must equal the npm package's under Node, byte for
// byte, for JavaScript and TypeScript):
//
// * `path`, `node:path`: path-browserify, the usual browser port of Node's
//   posix `path`. The instrumenter takes file extensions with it (which
//   parser), Babel joins and resolves its file names with it.
// * `module`: `createRequire(url).resolve(name)` is how the TypeScript parser
//   (parsers/ts-parser.js) names the Babel presets and plugins it passes to
//   `babel.parseAsync`, which then loads them from disk. Babel takes the
//   preset or plugin itself in place of its path, so here `resolve` returns
//   the module, imported into the bundle. The four it asks for are the only
//   names it knows; any other is an error.
// * `node:assert`: Babel 8 asserts internal invariants with it; the runner's
//   own `node:assert` (src/node/assert.ts), as a program would get.
// * `os`: the reporter ends its lines with `os.EOL`, "\n" here.
// * `fs`, `url`, `util`, `child_process`: imported by modules of
//   @stryker-mutator/util and @stryker-mutator/api that this bundle does not
//   call (running processes, reading Stryker's option schema from disk);
//   each name throws "not available in a worker" if anything calls it. The
//   option schema module reads its JSON file when it is evaluated, so it is
//   replaced by an empty schema: options are validated by Stryker's CLI,
//   which is not here.
// * `process`: Babel reads `process.env.BABEL_ENV` and `NODE_ENV` when it
//   runs; the runner's own `process` (src/node/process.ts) has an empty
//   `env`, so Babel sees none, as under Stryker with neither set.
// * `svelte/compiler` (the instrumenter's Svelte parser imports it when it
//   meets a .svelte file, which Mutate never passes it) stays external.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const out = process.argv[2];
if (!out) {
  console.error('usage: node tools/stryker.mjs <outfile>');
  process.exit(2);
}
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const UNAVAILABLE = `const unavailable = (name) => () => { throw new Error(name + ' is not available in a worker'); };
export const readFileSync = unavailable('fs.readFileSync');
export const promisify = () => unavailable('util.promisify');
export const exec = unavailable('child_process.exec');
export const execFile = unavailable('child_process.execFile');
export const URL = globalThis.URL;
export default {};`;

const MODULE = `import presetTypescript from '@babel/preset-typescript';
import presetReact from '@babel/preset-react';
import pluginDecorators from '@babel/plugin-proposal-decorators';
import pluginResourceManagement from '@babel/plugin-transform-explicit-resource-management';
const modules = {
  '@babel/preset-typescript': presetTypescript,
  '@babel/preset-react': presetReact,
  '@babel/plugin-proposal-decorators': pluginDecorators,
  '@babel/plugin-transform-explicit-resource-management': pluginResourceManagement,
};
export function createRequire() {
  return {
    resolve(name) {
      if (!Object.hasOwn(modules, name)) throw new Error('Cannot find module ' + name + ' (the Mutate bundle has only the Babel presets and plugins the instrumenter names)');
      return modules[name];
    },
  };
}`;

const standIns = {
  name: 'node-stand-ins',
  setup(b) {
    b.onResolve({ filter: /^(node:)?path$/ }, () => ({ path: here('../node_modules/path-browserify/index.js') }));
    b.onResolve({ filter: /^(node:)?assert$/ }, () => ({ path: 'assert', namespace: 'stand-in' }));
    b.onResolve({ filter: /^(node:)?(module|os|fs|url|util|child_process)$/ }, (a) => ({ path: a.path.replace(/^node:/, ''), namespace: 'stand-in' }));
    b.onResolve({ filter: /stryker-options-schema\.js$/ }, () => ({ path: 'schema', namespace: 'stand-in' }));
    b.onResolve({ filter: /^svelte\/compiler$/ }, (a) => ({ path: a.path, external: true }));
    b.onLoad({ filter: /.*/, namespace: 'stand-in' }, (a) => {
      const resolveDir = here('../src/stryker');
      switch (a.path) {
        case 'module':
          return { contents: MODULE, resolveDir };
        case 'assert':
          return { contents: "import { legacy } from '../node/assert';\nexport default legacy;\n", resolveDir, loader: 'ts' };
        case 'os':
          return { contents: "export const EOL = '\\n';\nexport default { EOL };\n" };
        case 'schema':
          return { contents: 'export const strykerCoreSchema = {};\n' };
        default:
          return { contents: UNAVAILABLE };
      }
    });
  },
};

await build({
  entryPoints: [here('../src/stryker/index.ts')],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  logLevel: 'warning',
  outfile: out,
  plugins: [standIns],
});
