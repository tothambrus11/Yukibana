// Smoke test of libyuki.so under Node, run by build-rootfs.sh in CI right
// after the root file system is built: loads GHC with its wasm dynamic
// linker (dyld.mjs, Node's WASI on the real file system), starts an editor
// session and a runner session, and prints what they answer, with timings.
//
//   node smoke.mjs OUT HS_SEARCHDIR STORE_DB
import fs from 'node:fs';

const [out, hsSearchDir, storeDb, mode] = process.argv.slice(2);
const { DyLDHost, main } = await import(`${out}/dyld.mjs`);

const t0 = performance.now();
const ms = () => `${Math.round(performance.now() - t0)} ms`;
const dyld = await main({
    rpc: new DyLDHost({}),
    searchDirs: ['/tmp/clib', hsSearchDir],
    mainSoPath: '/tmp/libyuki.so',
    args: ['libyuki.so', '+RTS', '-c', '-RTS'],
    isIserv: false,
});
console.log(`linked at ${ms()}`);

const PACKAGES = ['base', 'containers', 'mtl', 'transformers', 'text', 'bytestring', 'array', 'deepseq', 'QuickCheck', 'hspec', 'random'];
const flags = ['-package-db', storeDb, '-hide-all-packages', ...PACKAGES.flatMap((p) => ['-package', p]), '-Wall'].join('\n');
await dyld.exportFuncs.yukiInit('/tmp/hslib/lib', mode, flags);
console.log(`${mode} session at ${ms()}`);

fs.mkdirSync('/tmp/workspace/tests', { recursive: true });
fs.writeFileSync('/tmp/workspace/Geometry.hs', `-- | Points.
module Geometry (Point (..), norm, unused) where

-- | A point in the plane.
data Point = Point {px :: Double, py :: Double} deriving (Show, Eq)

-- | Distance from the origin.
norm :: Point -> Double
norm (Point x y) = sqrt (x * x + y * y)

unused x = x
`);
fs.writeFileSync('/tmp/workspace/Main.hs', `module Main (main) where

import Geometry
import qualified Data.Map as M
import Control.Monad.State

bad :: Int
bad = "no"

alsoBad = True + 1

main :: IO ()
main = do
  let p = Point 3 4
  print (norm p)
  print (M.fromList [(1 :: Int, "a")])
  print (evalState (modify (+ 1) >> get) (41 :: Int))
  print missing
`);
fs.writeFileSync('/tmp/workspace/tests/Spec.hs', `module Main (main) where

import Geometry
import Test.Hspec
import Test.QuickCheck

main :: IO ()
main = hspec $ do
  it "norm" $ norm (Point 3 4) \`shouldBe\` 5
  it "non-negative" $ property $ \\x y -> norm (Point x y) >= 0
`);

const ask = async (lines) => {
    const t = performance.now();
    const r = await dyld.exportFuncs.yukiRequest(lines.join('\n'));
    console.log(`--- ${lines[0]} ${lines.slice(1, 4).join(' ')} (${Math.round(performance.now() - t)} ms)\n${r.slice(0, 4000)}`);
    return JSON.parse(r);
};
if (mode === 'runner') {
    fs.writeFileSync('/tmp/workspace/Main.hs', `module Main (main) where
import Geometry
import qualified Data.Map as M
main :: IO ()
main = do
  print (norm (Point 3 4))
  print (M.toList (M.fromList [(2 :: Int, "b"), (1, "a")]))
  print (sum [1 .. 1000000 :: Int])
  name <- getLine
  putStrLn ("hello " ++ name)
`);
    for (let i = 0; i < 2; i++) await ask(['run', '-i/tmp/workspace', '==', '/tmp/workspace/Main.hs']);
    await ask(['run', '-i/tmp/workspace', '-i/tmp/workspace/tests', '==', '/tmp/workspace/tests/Spec.hs', '--color']);
    console.log(`done at ${ms()}`);
    process.exit(0);
}
const check = ['check', '-i/tmp/workspace', '-i/tmp/workspace/tests', '==', '/tmp/workspace/Main.hs\t/tmp/workspace/Geometry.hs', '/tmp/workspace/tests/Spec.hs'];
const first = await ask(check);
await ask(check);
await ask(['info', '/tmp/workspace/Main.hs', '16', '10']); // norm
await ask(['info', '/tmp/workspace/Main.hs', '15', '11']); // Point
await ask(['info', '/tmp/workspace/Main.hs', '17', '5']); // print
await ask(['refs', '/tmp/workspace/Main.hs', '16', '10']);
const sc = await ask(['scope', '/tmp/workspace/Main.hs', '16', '3']);
console.log(`scope: ${sc.names?.length} names, ${sc.locals?.length} locals, ${sc.modules?.length} modules`);
// Signature help and semantic tokens: a failure here is a GHC API
// mistake in Yuki.hs, which only CI can compile.
const expect = (what, ok, got) => {
    if (!ok) {
        console.error(`unexpected ${what}: ${JSON.stringify(got).slice(0, 400)}`);
        process.exitCode = 1;
    }
};
const s1 = await ask(['sig', '/tmp/workspace/Main.hs', '16', '10', 'norm']);
expect('sig of norm', s1.found && s1.args?.[0] === 'Point' && s1.result === 'Double', s1);
const s2 = await ask(['sig', '/tmp/workspace/Main.hs', '17', '10', 'M.fromList']);
expect('sig of M.fromList', s2.found && s2.context?.[0] === 'Ord k' && s2.args?.length === 1, s2);
const s3 = await ask(['sig', '/tmp/workspace/Main.hs', '18', '10', 'modify']);
expect('sig of modify', s3.found && s3.args?.[0] === '(s -> s)', s3);
const s4 = await ask(['sig', '/tmp/workspace/Main.hs', '15', '11', 'Point']);
expect('sig of the constructor Point', s4.found && s4.args?.length === 2, s4);
const tk = await ask(['tokens', '/tmp/workspace/Main.hs']);
expect('tokens of Main.hs', Array.isArray(tk) && tk.length >= 5 * 10 && tk.includes('norm') && tk.includes('enumMember') && tk.includes('function'), tk);
// Call hierarchy, explicit imports, and the modules that export a name.
const c1 = await ask(['calls', '/tmp/workspace/Geometry.hs', '9', '1']); // norm's binding
expect('incoming calls of norm', c1.item?.name === 'norm' && c1.incoming?.length === 2 && c1.incoming.every((c) => c.from.name === 'main'), c1);
const c2 = await ask(['calls', '/tmp/workspace/Main.hs', '13', '1']); // main's binding
expect('outgoing calls of main', c2.item?.name === 'main' && c2.outgoing?.some((c) => c.to.name === 'norm') && !c2.incoming?.length, c2);
const im = await ask(['imports', '/tmp/workspace/Main.hs']);
expect('explicit imports of Main.hs', Array.isArray(im) && im.some((i) => i.module === 'Geometry' && i.items.includes('norm') && i.items.some((x) => x.startsWith('Point'))) && im.some((i) => i.module === 'Control.Monad.State' && i.items.includes('evalState')), im);
const ex1 = await ask(['exports', 'sortBy']);
expect('modules exporting sortBy', Array.isArray(ex1) && ex1.some((e) => e.module === 'Data.List'), ex1);
const ex2 = await ask(['exports', 'Just']);
expect('modules exporting Just, with its type', Array.isArray(ex2) && ex2.some((e) => e.module === 'Data.Maybe' && e.parent === 'Maybe'), ex2);
const ex3 = await ask(['exports', 'norm']);
expect('the project module exporting norm', Array.isArray(ex3) && ex3.some((e) => e.module === 'Geometry' && e.home), ex3);
if (!first.diagnostics || first.diagnostics.length < 3) {
    console.error('expected several diagnostics');
    process.exitCode = 1;
}
console.log(`done at ${ms()}`);
