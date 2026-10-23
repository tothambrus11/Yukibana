// Builds Phpactor's index of the stubs ahead of time, in Node, with the same
// php.wasm, the same files at the same paths and the same configuration as
// the language server in the browser (src/phpactor.php), so the browser
// only indexes the project when the server starts: indexing the stubs there
// takes ~10 s of CPU, every time the server starts.
//
//   node build-index.mjs <pack output dir> <phpactor tar> <dest dir>
//
// Runs `phpactor index:build` over an empty /workspace and copies what it
// wrote under XDG_CACHE_HOME (/opt/cache, as in server.js) to <dest dir>.
// The tar's files carry its fixed modification time (untar sets it), older
// than the index, so the server does not index them again.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [out, tarPath, dest] = process.argv.slice(2).map((p) => resolve(p));
const { init } = await import(pathToFileURL(join(out, 'php.mjs')).href);
const { untar, runCli } = await import(pathToFileURL(join(out, 'php.js')).href);

let log = '';
const php = await new Promise((done, fail) => {
    const module = init('WEB', {
        wasmBinary: readFileSync(join(out, 'php.wasm')),
        noInitialRun: true,
        locateFile: (p) => p,
        ENV: { HOME: '/home', TMPDIR: '/tmp', XDG_CACHE_HOME: '/opt/cache', XDG_DATA_HOME: '/tmp/data', XDG_CONFIG_HOME: '/tmp/config' },
        onStdout: (c) => (log += Buffer.from(c).toString()),
        onStderr: (c) => process.stderr.write(Buffer.from(c)),
        stdin: () => null,
        onAbort: fail,
        onRuntimeInitialized: () => done(module),
    });
});
untar(php, readFileSync(tarPath), '/opt');
php.FS.mkdirTree('/workspace');
php.FS.chdir('/workspace');
const code = await runCli(php, ['php', '/opt/yukibana/phpactor.php', 'index:build']);
const summary = log.trim().split('\n').filter((l) => /Done in/.test(l)).join(' ');
if (code !== 0 || !summary) {
    process.stderr.write(log);
    console.error(`phpactor index:build exited with ${code}`);
    process.exit(1);
}

let files = 0;
const copy = (from, to) => {
    for (const name of php.FS.readdir(from)) {
        if (name === '.' || name === '..') continue;
        const path = `${from}/${name}`;
        if (php.FS.isDir(php.FS.stat(path).mode)) copy(path, join(to, name));
        else {
            mkdirSync(to, { recursive: true });
            writeFileSync(join(to, name), php.FS.readFile(path));
            files++;
        }
    }
};
copy('/opt/cache', dest);
console.log(`index: ${files} files (${summary.trim()})`);
