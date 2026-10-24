// The Haskell project's cabal file names the packages its imports come from
// (src/lib/export.ts, haskellDepends and haskellCabal), so `cabal build`
// of a downloaded project finds what the browser's GHC found.
//
//   node --test tests/haskell-export.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haskellCabal, haskellDepends } from '../src/lib/export.ts';

test('a project that imports only the Prelude depends on base alone', () => {
	assert.deepEqual(haskellDepends({ 'Main.hs': 'main :: IO ()\nmain = print 1\n' }), []);
});

test('each import names its package once, qualified, with a package import or safe', () => {
	const files = {
		'Main.hs': 'import qualified Data.Map.Strict as Map\nimport Data.Set (Set)\nimport Control.Monad.State\nimport safe Data.Text (Text)\n',
		'Lib.hs': 'module Lib where\nimport "bytestring" Data.ByteString.Char8 qualified as B\nimport System.Random (randomRIO)\n',
		'tests/Spec.hs': 'import Test.Hspec\nimport Test.QuickCheck\n',
		'README.md': 'import Data.Time\n',
	};
	assert.deepEqual(haskellDepends(files), ['containers >=0.6', 'mtl >=2.2', 'text >=2.0', 'bytestring >=0.11', 'random >=1.2', 'QuickCheck >=2.14', 'hspec >=2.10']);
});

test('a module whose name only starts like a package\'s does not count', () => {
	assert.deepEqual(haskellDepends({ 'Main.hs': 'import Data.Maybe\nimport Data.Mapping\nimport Data.Textual\n' }), []);
});

test('the cabal file depends on what the program imports, and its test suite on hspec', () => {
	const cabal = haskellCabal({ 'Main.hs': 'module Main (main) where\nimport Control.Monad.State\nmain :: IO ()\nmain = pure ()\n', 'tests/Spec.hs': 'import Test.Hspec\nimport Test.QuickCheck\nmain :: IO ()\nmain = hspec (pure ())\n' }, 'Main.hs');
	const common = cabal.slice(cabal.indexOf('common shared'), cabal.indexOf('executable'));
	assert.match(common, /build-depends:\n {8}base >=4\.16 && <5\n {6}, mtl >=2\.2\n {6}, QuickCheck >=2\.14\n/);
	assert.doesNotMatch(common, /hspec/);
	assert.match(cabal.slice(cabal.indexOf('test-suite spec')), /build-depends:\n {8}hspec >=2\.10\n/);
});
