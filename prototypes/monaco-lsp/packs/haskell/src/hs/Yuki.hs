-- The Haskell pack's one program: MicroHs's compiler with an editor's entry
-- points, compiled by MicroHs itself to combinators and with its runtime to
-- WebAssembly (build.sh). The language server and the runner load the same
-- yuki.wasm.
--
-- * The runner calls main: `run FILE ROOT...` compiles the module in FILE
--   (and what it imports from the source roots and the packages) and runs
--   its `main` in this process, as `mhs -r` does; `test` is the same for the
--   test suite's file. Compile errors go to stderr as GHC prints them
--   (`file:line:col: error:`), and the exit code is 1.
-- * The server never calls main. It calls `yuki_request`, a foreign export,
--   once per request, and the heap lives on between calls: the packages
--   are read once and every check starts from that cache, so a check costs
--   the project's own modules only.
--
-- Requests are lines: a command, then its arguments. Answers are JSON in
-- ASCII (MicroHs's CString is bytes, so anything else is \u-escaped):
--
--   check ROOT... -- FILE...   type check each FILE, every one on its own,
--                              with the project's source roots ROOT; answers
--                              { files: [{ file, module, error, uses, tops }] }
--   scope FILE                 the names in scope in FILE as of its last
--                              check that succeeded: { values, qualified, types, modules }
--
-- A use is [line, col, written, resolved, defFile, defLine, defCol, type,
-- typeHere, mode]: where a name is written (1-based, MicroHs's columns, a
-- tab moving to the next multiple of 8), as written, what it resolved to
-- (qualified for a top-level name, the binder for a local), where that is
-- defined, its declared type, its type at this use (empty when the same or
-- not known), and "v" for a value or "t" for a type.
module Yuki(main) where
import Control.DeepSeq(rnf)
import Control.Exception
import Control.Monad(foldM)
import Data.Char
import Data.IORef
import Data.List
import Data.Maybe
import Foreign.C.String
import System.Environment
import System.Exit
import System.IO
import System.IO.Unsafe
import MicroHs.Compile
import MicroHs.CompileCache
import MicroHs.Exp(Exp(Var))
import MicroHs.Expr
import MicroHs.Flags
import MicroHs.Ident
import qualified MicroHs.IntMap as IM
import MicroHs.Parse
import MicroHs.StateIO
import MicroHs.SymTab
import MicroHs.TCMonad
import MicroHs.Translate
import MicroHs.TypeCheck

foreign export ccall "yuki_request" request :: CString -> IO CString

-- MicroHs's runtime ends a program on ExitSuccess and reports any other
-- exception, ExitFailure included, as uncaught; a program that exits with
-- a code ends here instead, quietly.
foreign import ccall "stdlib.h exit" cExit :: Int -> IO ()

-- The packages the pack ships, compiled by build.sh (hspec.pkg is our
-- Test.Hspec), as the runner and the server lay them out in Emscripten's
-- file system.
-- They are under /yuki, or $YUKI_ROOT for a test of a native build.
yukiRoot :: FilePath
yukiRoot = unsafePerformIO (fromMaybe "/yuki" <$> lookupEnv "YUKI_ROOT")
{-# NOINLINE yukiRoot #-}

packages :: [FilePath]
packages = [yukiRoot ++ "/base.pkg", yukiRoot ++ "/containers.pkg", yukiRoot ++ "/hspec.pkg"]

flagsFor :: [FilePath] -> Flags
flagsFor roots = defaultFlags { srcPaths = roots, preload = packages, verbose = -1, mhsdir = yukiRoot }

main :: IO ()
main = do
  args <- getArgs
  case args of
    mode : file : roots | mode == "run" || mode == "test" -> runFile file roots
    _ -> do
      hPutStrLn stderr "usage: yuki (run|test) FILE ROOT..."
      exitWith (ExitFailure 2)

-- Compiles FILE and runs its main. The compiler's own output is quiet
-- (verbose -1); the program's exceptions end it with the message, as GHC's
-- runtime does, and an exit (exitWith) passes through.
runFile :: FilePath -> [FilePath] -> IO ()
runFile file roots = do
  let flags = flagsFor roots
  compiled <- try (do
    (rds, _, _) <- compileCacheTop flags (mkIdent file) emptyCache
    _ <- evaluate (length (snd rds))
    return rds)
  case compiled of
    Left e -> do
      hPutStr stderr (ghcStyle (message e))
      hFlush stderr
      cExit 1
    Right (rmn, defs) -> do
      result <- try (translateAndRun (defs, Var (qualIdent rmn (mkIdent "main"))))
      hFlush stdout
      case result of
        Right () -> return ()
        Left e -> case fromException e of
          Just ExitSuccess -> return ()
          Just (ExitFailure n) -> do
            hFlush stderr
            cExit n
          Nothing -> do
            hPutStrLn stderr ("<interactive>: " ++ message e)
            hFlush stderr
            cExit 1

-- An exception's message, in GHC's words where MicroHs's are terse:
-- students look GHC's messages up. MicroHs's `error` shows as "error: ...";
-- a type mismatch is an unsolvable equality constraint, a missing instance
-- an unsolvable class constraint, and both come with the constraint again,
-- fully qualified, which only says the same thing longer.
message :: SomeException -> String
message e = unlines' (map friendly (filter (not . qualifiedAgain) (lines m)))
  where
    m = let d = displayException e in fromMaybe d (stripPrefix "error: " d)
    qualifiedAgain l = "fully qualified: " `isPrefixOf` dropWhile isSpace l
    unlines' = intercalate "\n"

friendly :: String -> String
friendly l =
  case breakOn "Cannot satisfy constraint: " l of
    Just (pre, c) -> pre ++ constraint c
    Nothing -> case breakOn "undefined value: " l of
      Just (pre, v) -> pre ++ "Variable not in scope: " ++ v
      Nothing -> l
  where
    constraint c = case splitTilde (words c) of
      Just (a, b) -> "Couldn't match type \x2018" ++ a ++ "\x2019 with \x2018" ++ b ++ "\x2019"
      Nothing -> "No instance for (" ++ c ++ ")" ++ hint (words c)
    hint ("IsString" : t) = "\n  arising from a string literal used where a value of type " ++ unwords t ++ " is expected"
    hint ("Num" : t) = "\n  arising from a number literal or arithmetic on a value of type " ++ unwords t
    hint _ = ""
    -- `a ~ b` at the top level: the `~` that is not inside brackets.
    splitTilde ws = go 0 [] ws
      where
        go :: Int -> [String] -> [String] -> Maybe (String, String)
        go _ _ [] = Nothing
        go d acc (w : rest)
          | w == "~" && d == 0 = Just (unwords (reverse acc), unwords rest)
          | otherwise = go (d + depth w) (w : acc) rest
        depth w = length (filter (`elem` "([") w) - length (filter (`elem` ")]") w)

-- The text before and after the first occurrence of a separator.
breakOn :: String -> String -> Maybe (String, String)
breakOn sep = go []
  where
    go acc s | Just rest <- stripPrefix sep s = Just (reverse acc, rest)
    go _ [] = Nothing
    go acc (c : cs) = go (c : acc) cs

-- MicroHs says `"Main.hs": line 3, col 5: message`; students' tools (and
-- the app's problem matcher) know GHC's `Main.hs:3:5: error:` with the
-- message indented below.
ghcStyle :: String -> String
ghcStyle msg =
  case parseLoc msg of
    Just (f, l, c, rest) -> f ++ ":" ++ show l ++ ":" ++ show c ++ ": error:\n" ++ unlines (map ("    " ++) (lines (dropWhile isSpace rest)))
    Nothing -> "error:\n" ++ unlines (map ("    " ++) (lines msg))

-- The file, line, column and message of a MicroHs error, when it has them.
parseLoc :: String -> Maybe (FilePath, Int, Int, String)
parseLoc msg =
  case msg of
    '"' : s -> case break (== '"') s of
      (f, '"' : ':' : ' ' : r1) | Just r2 <- stripPrefix "line " r1 ->
        case span isDigit r2 of
          (ls@(_:_), ',' : ' ' : r3) | Just r4 <- stripPrefix "col " r3 ->
            case span isDigit r4 of
              (cs@(_:_), ':' : r5) -> Just (f, read ls, read cs, r5)
              _ -> Nothing
          _ -> Nothing
      _ -> Nothing
    _ -> Nothing

------------------------------------------------------------------------
-- The server's requests.

-- The packages, read on the first request and kept.
baseRef :: IORef (Maybe Cache)
baseRef = unsafePerformIO (newIORef Nothing)
{-# NOINLINE baseRef #-}

-- Each file's type checker state as of its last check that succeeded, for
-- scope requests: a file being edited mostly fails to check, and its
-- completions are then those of the last version that did.
scopesRef :: IORef [(FilePath, TCState)]
scopesRef = unsafePerformIO (newIORef [])
{-# NOINLINE scopesRef #-}

baseCache :: IO Cache
baseCache = do
  mc <- readIORef baseRef
  case mc of
    Just c -> return c
    Nothing -> do
      c <- compileMany (flagsFor []) [] emptyCache
      writeIORef baseRef (Just c)
      return c

request :: CString -> IO CString
request p = do
  req <- peekCString p
  answer <- (handleRequest (lines req) >>= \ s -> evaluate (forceString s))
              `catch` \ e -> return (jObject [("failure", jString (message e))])
  newCString answer
  where forceString s = length s `seq` s

handleRequest :: [String] -> IO String
handleRequest ls =
  case ls of
    "check" : rest -> let (roots, files) = break (== "--") rest in checkFiles roots (drop 1 files)
    ["scope", file] -> scopeOf file
    _ -> return (jObject [("failure", jString ("unknown request " ++ show (take 1 ls)))])

checkFiles :: [FilePath] -> [FilePath] -> IO String
checkFiles roots files = do
  base <- baseCache
  (results, _) <- foldM (\ (rs, c) f -> do { (r, c') <- checkFile c (flagsFor roots) f; return (rs ++ [r], c') }) ([], base) files
  return (jObject [("files", jArray results)])

-- Type checks one file: parses it, compiles what it imports (from the source
-- roots, into the cache, which the next file of the check starts from: a
-- module the project's files import is compiled once per check), type
-- checks it and desugars it, which is where MicroHs reports its errors (one
-- per file: the first). On success the answer has its uses and its
-- top-level names; on failure the error, raw, and the cache as it was.
-- Every check starts from the packages alone: an instance a module no
-- longer declares would otherwise stay in the cache's tables.
checkFile :: Cache -> Flags -> FilePath -> IO (String, Cache)
checkFile cache flags file = do
  r <- try (do
    src <- readFile file
    let pmdl@(EModule mn _ _) = parseDie pTop file src
    _ <- evaluate (length (unIdent mn))
    (((dmdl, _, _, _, _), tcs), cache') <- runStateIO (compileModuleP flags ImpNormal (addPreludeImport pmdl)) cache
    _ <- evaluate (rnf (tBindingsOf dmdl))
    let out = describe mn tcs
    _ <- evaluate (length out)
    return (mn, tcs, out, cache'))
  case r of
    Left e -> return (jObject [("file", jString file), ("error", jString (message e))], cache)
    Right (mn, tcs, out, cache') -> do
      modifyIORef scopesRef (\ ss -> (file, tcs) : filter ((/= file) . fst) ss)
      return (jObject (("file", jString file) : ("module", jString (unIdent mn)) : out), cache')

-- A checked module's uses (its own file only: the type checker also checks
-- code it generates, at other places) and its top-level values.
describe :: Ident -> TCState -> [(String, String)]
describe mn tcs =
  [("uses", jArray (mapMaybe use (ideUses (ideFlush tcs)))), ("tops", jArray tops)]
  where
    sub = uvarSubst tcs
    use (occ, res, sigma, here, mode) =
      case (slocIdent occ, resolved res) of
        (SLoc _ l c, Just ri) | l > 0 && not (isDummyIdent occ) ->
          let SLoc df dl dc = slocIdent ri
              t = showType sigma
              th = if hasUVar here then "" else showType here
          in Just (jArray [show l, show c, jString (unIdent occ), jString (unIdent ri), jString df, show dl, show dc,
                           jString t, jString (if th == t then "" else th), jString (if mode == TCExpr then "v" else "t")])
        _ -> Nothing
    vt = valueTable tcs
    prefix = unIdent mn ++ "."
    tops = [ jArray [jString (unIdent i), jString (showType (deref sub t)), show l, show c]
           | i <- stKeysGlbU vt
           , Right (Entry e t) <- [stLookup "" i vt]
           , Just ri <- [resolved e]
           , prefix `isPrefixOf` unIdent ri
           , not (madeUp (unIdent i))
           , SLoc _ l c <- [slocIdent ri], l > 0 ]

-- The names in scope in a file at its last good check: unqualified values
-- with their types and the module they come from, qualified ones (`M.x`) by
-- name only, types and classes, and every module there is to import.
scopeOf :: FilePath -> IO String
scopeOf file = do
  ss <- readIORef scopesRef
  base <- baseCache
  let modules = jArray (map (jString . unIdent) (cachedModuleNames base))
  case lookup file ss of
    Nothing -> return (jObject [("values", "[]"), ("qualified", "[]"), ("types", "[]"), ("modules", modules)])
    Just tcs -> do
      let sub = uvarSubst tcs
          vt = valueTable tcs
          tt = typeTable tcs
          values = [ jArray [jString (unIdent i), jString (showType (deref sub t)), jString (maybe "" (qualOfString . unIdent) (resolved e))]
                   | i <- stKeysGlbU vt, not (internal (unIdent i))
                   , Right (Entry e t) <- [stLookup "" i vt] ]
          qualified = [ jString (unIdent i) | i <- stKeysGlbQ vt, not (internal (unIdent i)) ]
          types = [ jString (unIdent i) | i <- stKeysGlbU tt, not (internal (unIdent i)) ]
      return (jObject [("values", jArray values), ("qualified", jArray qualified), ("types", jArray types), ("modules", modules)])
  where
    -- Dictionaries, instances, default methods and the like: names the
    -- compiler makes up, which start with something no Haskell name does.
    internal s = case s of
      c : _ -> not (isAlpha c || c == '_' || isOperStart c) || "B@" `isPrefixOf` s
      [] -> True
    isOperStart c = c `elem` "!#$%&*+./<=>?@\\^|-~:"
    qualOfString s = case break (== '.') (reverse s) of
      (_, '.' : q) -> reverse q
      _ -> ""

-- A name the compiler makes up for an instance, a record field's getter and
-- the like: letters and a `$` (an operator a program defines has no letters).
madeUp :: String -> Bool
madeUp s = '$' `elem` s && any isAlpha s || '@' `elem` s && any isAlpha s

-- What a use resolved to: the identifier at its head, if any.
resolved :: Expr -> Maybe Ident
resolved e = case e of
  EVar i -> Just i
  ECon c -> Just (conIdent c)
  EApp f _ -> resolved f
  EQVar f _ -> resolved f
  _ -> Nothing

-- Substitutes what the type checker learnt for its unification variables.
deref :: IM.IntMap EType -> EType -> EType
deref = ideDeref

-- Whether a type still has a variable the type checker did not solve: such
-- a type at a use says less than the declared one.
hasUVar :: EType -> Bool
hasUVar t = case t of
  EApp f a -> hasUVar f || hasUVar a
  EUVar _ -> True
  ESign a _ -> hasUVar a
  EForall _ _ a -> hasUVar a
  _ -> False

-- A type as Haskell programmers write it: MicroHs's printing (unqualified)
-- without its explicit foralls and kinds (`forall (a::Type) . [a] -> a`),
-- on one line.
showType :: EType -> String
showType = unwords . words . showExpr . implicit
  where
    implicit t = case t of
      EForall _ _ a -> implicit a
      EApp f a -> EApp (implicit f) (implicit a)
      _ -> t

------------------------------------------------------------------------
-- JSON, in ASCII.

jString :: String -> String
jString s = '"' : concatMap esc s ++ "\""
  where
    esc c | c == '"' = "\\\""
          | c == '\\' = "\\\\"
          | c == '\n' = "\\n"
          | c == '\t' = "\\t"
          | ord c < 32 || ord c > 126 = concatMap u16 (utf16 (ord c))
          | otherwise = [c]
    u16 n = "\\u" ++ hex4 n
    hex4 n = [ intToDigit ((n `div` (16 ^ k)) `mod` 16) | k <- [3, 2, 1, 0 :: Int] ]
    utf16 n | n < 0x10000 = [n]
            | otherwise = let m = n - 0x10000 in [0xD800 + m `div` 0x400, 0xDC00 + m `mod` 0x400]

jArray :: [String] -> String
jArray xs = "[" ++ intercalate "," xs ++ "]"

jObject :: [(String, String)] -> String
jObject kvs = "{" ++ intercalate "," [ jString k ++ ":" ++ v | (k, v) <- kvs ] ++ "}"
