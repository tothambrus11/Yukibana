// Collects the lib.*.d.ts files the pack ships and minifies them into one
// JSON object { "lib.es5.d.ts": "...", ... } that the worker fetches once.
//
// usage: node tools/libs.mjs <typescript/lib dir> <out.json> [root lib names...]
//
// The set is the transitive closure of `/// <reference lib="…" />` from the
// roots, so it is exactly what `"lib": [roots]` makes the compiler load.
//
// Minification keeps every token and every JSDoc comment (hover and
// completion documentation come from them, e.g. Array.prototype.map's), and
// drops the licence header, line comments, indentation and blank lines.
// Triple-slash directives are kept: they are how one lib pulls in the next.
// It re-tokenises with TypeScript's own scanner rather than with regexes, so
// a `/*` inside a string literal cannot fool it.

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const [libDir, outFile, ...roots] = process.argv.slice(2);
if (!libDir || !outFile || roots.length === 0) {
  console.error('usage: node tools/libs.mjs <typescript/lib dir> <out.json> <root lib>...');
  process.exit(2);
}

const files = new Map();
const pending = roots.map((r) => `lib.${r.toLowerCase()}.d.ts`);
while (pending.length) {
  const name = pending.pop();
  if (files.has(name)) continue;
  const text = fs.readFileSync(path.join(libDir, name), 'utf8');
  files.set(name, text);
  for (const ref of ts.preProcessFile(text, true, true).libReferenceDirectives) {
    pending.push(`lib.${ref.fileName.toLowerCase()}.d.ts`);
  }
}

const isWord = (c) => /[\w$]/.test(c);

/**
 * Yields the scanner's tokens, re-scanning `}` inside a template literal type
 * (lib.dom has `${string}-${string}`) so the scanner, which has no parser to
 * tell it, stays in step with the text.
 */
function* scan(text, skipTrivia) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, skipTrivia, ts.LanguageVariant.Standard, text);
  const stack = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.TemplateHead || kind === ts.SyntaxKind.OpenBraceToken) stack.push(kind);
    else if (kind === ts.SyntaxKind.CloseBraceToken && stack.pop() === ts.SyntaxKind.TemplateHead) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === ts.SyntaxKind.TemplateMiddle) stack.push(ts.SyntaxKind.TemplateHead);
    }
    yield [kind, scanner.getTokenText()];
  }
}

/** Rewrites a JSDoc block without its per-line indentation and `*` gutter. */
function compactJsDoc(comment) {
  const body = comment.slice(3, -2);
  const lines = body
    .split('\n')
    .map((l) => l.replace(/^\s*\*?\s?/, '').trimEnd())
    .filter((l, i, all) => l !== '' || (i > 0 && i < all.length - 1 && all[i - 1] !== ''));
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length <= 1 ? `/** ${lines[0] ?? ''} */` : `/**\n${lines.join('\n')}\n*/`;
}

function minify(text) {
  let out = '';
  let pendingSpace = ''; // '' | ' ' | '\n'
  const emit = (s) => {
    if (pendingSpace && out) {
      const a = out[out.length - 1];
      const b = s[0];
      // A newline is kept where there was one (no ASI surprises); a space only
      // where dropping it would glue two words or two operator characters.
      if (pendingSpace === '\n') out += '\n';
      else if (isWord(a) === isWord(b)) out += ' ';
    }
    pendingSpace = '';
    out += s;
  };
  for (const [kind, tok] of scan(text, false)) {
    switch (kind) {
      case ts.SyntaxKind.NewLineTrivia:
        pendingSpace = '\n';
        break;
      case ts.SyntaxKind.WhitespaceTrivia:
        if (pendingSpace !== '\n') pendingSpace = ' ';
        break;
      case ts.SyntaxKind.SingleLineCommentTrivia:
        if (tok.startsWith('/// <reference')) emit(tok);
        else if (pendingSpace !== '\n') pendingSpace = ' ';
        break;
      case ts.SyntaxKind.MultiLineCommentTrivia:
        if (tok.startsWith('/**') && tok !== '/**/') {
          if (out && pendingSpace !== '\n') pendingSpace = '\n';
          emit(compactJsDoc(tok));
          pendingSpace = '\n';
        } else if (pendingSpace !== '\n') pendingSpace = ' ';
        break;
      default:
        emit(tok);
    }
  }
  return out + '\n';
}

/** The non-trivia token stream, which minification must leave unchanged. */
function tokens(text) {
  return Array.from(scan(text, true), ([, tok]) => tok).join('\u0000');
}

const out = {};
let before = 0;
for (const [name, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
  before += text.length;
  const min = minify(text);
  if (tokens(min) !== tokens(text)) throw new Error(`minifying ${name} changed its tokens`);
  out[name] = min;
}
const json = JSON.stringify(out);
fs.writeFileSync(outFile, json);
console.log(`libs: ${files.size} files, ${before} -> ${json.length} chars`);
