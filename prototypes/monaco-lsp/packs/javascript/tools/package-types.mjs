// Collects the type declarations of npm packages the runner ships, as the
// language server's virtual `/node_modules/` (src/server.ts, PACKAGES_FILE).
//
//   node tools/package-types.mjs <out.json> <package>...
//
// Which files: exactly those TypeScript itself reads to resolve
// `import ... from '<package>'` the way the server resolves it (ESNext
// modules, `Bundler` resolution, the `import` condition): a program with one
// file importing each package is created over this directory's
// `node_modules`, and every `package.json` and declaration file it read under
// `node_modules/` is kept, byte for byte, under `/node_modules/...`. So
// fast-check brings its `lib/fast-check.d.ts` and the declarations of the
// pure-rand modules that file imports, and nothing it does not need (its
// CommonJS copy, the declarations for TypeScript before 5.7).
//
// The output is a JSON object from path to text, keys sorted, so the same
// packages give the same bytes.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const [out, ...packages] = process.argv.slice(2);
if (!out || packages.length === 0) {
  console.error('usage: node tools/package-types.mjs <out.json> <package>...');
  process.exit(2);
}

const root = resolve('.');
const entry = resolve(root, '__package_types_entry__.ts');
const source = packages.map((p, i) => `import * as p${i} from ${JSON.stringify(p)};\nexport { p${i} };\n`).join('');
const options = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  types: [],
  // The server's default libs: p5.js's declarations name DOM types
  // (HTMLCanvasElement, MouseEvent) and are not complete without them.
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
  strict: true,
};
const read = new Set();
const host = ts.createCompilerHost(options);
const readFile = host.readFile.bind(host);
host.readFile = (p) => {
  read.add(p);
  return p === entry ? source : readFile(p);
};
const fileExists = host.fileExists.bind(host);
host.fileExists = (p) => p === entry || fileExists(p);
const getSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (p, lang, onError, create) =>
  p === entry ? ts.createSourceFile(p, source, lang) : getSourceFile(p, lang, onError, create);

const program = ts.createProgram([entry], options, host);
const errors = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error);
if (errors.length) {
  console.error(ts.formatDiagnostics(errors, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
  process.exit(1);
}

const prefix = `${root}/node_modules/`;
const files = {};
// TypeScript's own package (its default libs, its package.json) is the
// server's business (libs-*.json), not a package's.
const kept = [...program.getSourceFiles().map((f) => f.fileName), ...read].filter(
  (p) => p.startsWith(prefix) && !p.startsWith(`${prefix}typescript/`) && (p.endsWith('/package.json') || /\.d\.[cm]?ts$/.test(p)),
);
for (const p of [...new Set(kept)].sort()) {
  try {
    files[`/node_modules/${p.slice(prefix.length)}`] = readFileSync(p, 'utf8');
  } catch {
    // A package.json TypeScript only looked for (a scope directory) is not a file.
  }
}
writeFileSync(out, JSON.stringify(files));
console.log(`${out}: ${Object.keys(files).length} files (${Object.keys(files).join(', ')})`);
