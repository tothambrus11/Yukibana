{-# LANGUAGE LambdaCase #-}
{-# LANGUAGE PatternSynonyms #-}
{-# LANGUAGE ScopedTypeVariables #-}

-- | The Haskell pack's engine: GHC itself, through the GHC API, compiled to
-- a WebAssembly shared library (libyuki.so) that GHC's wasm dynamic linker
-- (dyld.mjs) loads in a browser worker next to libHSghc.so.
--
-- Two JavaScript functions are exported. @yukiInit@ starts a GHC session
-- once per worker, @yukiRequest@ answers one request at a time. A request is
-- lines of text (the first names it); an answer is JSON. The language server
-- (server.js) checks the project with 'check' and asks 'info', 'refs' and
-- 'scope' about what that check saw; the runner (runner.js) uses 'run'.
--
-- A session is either an editor's (GHC's type checker only, no code: what
-- @ghc -fno-code@ does, writing .hie files that the queries read) or a
-- runner's (GHC's bytecode interpreter, as GHCi). Which one is fixed by
-- 'yukiInit'.
--
-- Everything here is GHC's own: diagnostics are GHC's JSON
-- (-fdiagnostics-as-json, the same objects @ghc@ prints on a desktop),
-- types are printed by GHC, positions are GHC's (1-based lines and
-- columns, a tab moving to the next multiple of 8, as GHC's lexer counts).
module Yuki () where

import Control.Exception (SomeException, displayException, evaluate, fromException, try)
import Control.Monad (forM, when)
import Control.Monad.IO.Class (liftIO)
import Data.Coerce (coerce)
import Data.IORef
import Data.Either (partitionEithers)
import Data.List (intercalate, nub, sortOn, stripPrefix)
import qualified Data.Map.Strict as M
import Data.Maybe (catMaybes, isJust, listToMaybe, mapMaybe)
import qualified Data.Set as S
import System.Environment (setEnv)
import System.Exit (ExitCode (..))
import System.IO
import System.IO.Unsafe (unsafePerformIO)
import Text.Read (readMaybe)

import GHC
import GHC.Data.Bag (bagToList)
import GHC.Data.FastString (unpackFS)
import GHC.Driver.Env (hscInterp, hsc_NC, hsc_units)
import GHC.Driver.Monad (Session (..), modifyLogger, reflectGhc)
import GHC.Driver.Ppr (showSDoc)
import GHC.Driver.Session (gopt_set)
import GHC.Hs.Doc (WithHsDocIdentifiers (..))
import GHC.Hs.DocString (renderHsDocString)
import GHC.Platform.Ways (Way (WayDyn), addWay)
import GHC.Iface.Ext.Binary (hie_file_result, readHieFile)
import GHC.Iface.Ext.Types
import GHC.Iface.Ext.Utils (recoverFullType, renderHieType, smallestContainingSatisfying)
import GHC.Runtime.Interpreter (evalIO)
import GHC.Tc.Types (TcGblEnv (..))
import GHC.Types.Error (MessageClass (..))
import GHC.Types.Name (isInternalName, nameModule_maybe, nameOccName)
import GHC.Types.Name.Occurrence (isDataOcc, isTcOcc, isTvOcc, occNameString)
import GHC.Types.Name.Reader (ImpDeclSpec (..), ImportSpec (..), globalRdrEnvElts, gre_imp, gre_lcl, gre_name)
import GHC.Types.SrcLoc (mkRealSrcLoc, mkRealSrcSpan)
import GHC.Iface.Syntax (showToIface)
import GHC.Types.Id (isDataConId_maybe)
import GHC.Types.TyThing.Ppr (pprTyThing, pprTyThingHdr)
import GHC.Unit.Module (ml_hie_file, ml_hs_file, moduleNameString, moduleUnit, unitString)
import GHC.Unit.Module.ModSummary (msHsFilePath)
import GHC.Unit.State (listVisibleModuleNames)
import GHC.Utils.Json (JsonDoc)
import qualified GHC.Utils.Json as J
import GHC.Utils.Logger (pushJsonLogHook)
import GHC.Wasm.Prim (JSString (..), JSVal, freeJSVal, fromJSString, toJSString)

-- * State

-- | What a worker keeps between requests: its GHC session, the flags it
-- started with (every check starts again from them), and what the last
-- check produced.
data State = State
  { stSession :: !Session,
    stFlags :: !DynFlags,
    stEditor :: !Bool,
    -- | GHC's diagnostics since the request began, as JSON texts.
    stDiags :: !(IORef [String]),
    -- | The .hie file of each module of the last check, by source path.
    stHie :: !(IORef (M.Map FilePath HieFile)),
    -- | The module summaries of the last check, by source path.
    stSummaries :: !(IORef (M.Map FilePath ModSummary))
  }

{-# NOINLINE stateRef #-}
stateRef :: IORef (Maybe State)
stateRef = unsafePerformIO (newIORef Nothing)

getState :: IO State
getState = readIORef stateRef >>= maybe (fail "yukiInit was not called") pure

inGhc :: State -> Ghc a -> IO a
inGhc st act = reflectGhc act (stSession st)

-- * Exports

-- | @yukiInit libdir mode flags@: starts the session. @mode@ is "editor"
-- (type check only, .hie files written to /tmp/yuki/hie) or "runner"
-- (bytecode). @flags@ are GHC's command-line flags, one per line, that
-- every request starts from (package databases, -package, warnings).
yukiInit :: JSString -> JSString -> JSString -> IO ()
yukiInit jsLibdir jsMode jsFlags = do
  libdir <- evaluate (fromJSString jsLibdir)
  mode <- evaluate (fromJSString jsMode)
  flags <- evaluate (lines (fromJSString jsFlags))
  mapM_ (freeJSVal . (coerce :: JSString -> JSVal)) [jsLibdir, jsMode, jsFlags]
  ref <- newIORef (error "yukiInit: no session yet")
  let session = Session ref
      editor = mode == "editor"
  diags <- newIORef []
  df <- flip reflectGhc session $ do
    initGhcMonad (Just libdir)
    df0 <- getSessionDynFlags
    logger <- getLogger
    (df1, _, _) <- parseDynamicFlags logger df0 (map noLoc (["-fdiagnostics-as-json" | editor] ++ flags))
    let df2 =
          df1
            { ghcMode = CompManager,
              -- The libraries' interfaces are their dynamic way's (.dyn_hi):
              -- the root file system has no others, as GHC here is itself
              -- dynamically linked. Without the way an editor's session
              -- looks for Prelude.hi and finds base "missing files".
              targetWays_ = addWay WayDyn (targetWays_ df1),
              backend = if editor then noBackend else interpreterBackend,
              ghcLink = if editor then NoLink else LinkInMemory,
              verbosity = 0
            }
        df3 =
          if editor
            then
              (foldl gopt_set df2 [Opt_WriteHie, Opt_Haddock, Opt_ForceRecomp, Opt_DeferTypeErrors, Opt_DeferTypedHoles, Opt_DeferOutOfScopeVariables])
                { hieDir = Just "/tmp/yuki/hie",
                  hiDir = Just "/tmp/yuki/hi"
                }
            else df2
    _ <- setSessionDynFlags df3
    -- An editor's diagnostics are GHC's JSON (-fdiagnostics-as-json makes
    -- the logger call the JSON hook, not the text one), collected for the
    -- answer; a runner's are GHC's text on stderr, as ghc prints them.
    when editor $
      modifyLogger (pushJsonLogHook (\_ -> \_ cls doc -> collect diags cls doc))
    getSessionDynFlags
  -- A runner's program writes unbuffered, as under GHCi and runghc: a
  -- prompt shows before the program reads.
  hSetBuffering stdout (if editor then LineBuffering else NoBuffering)
  writeIORef stateRef . Just
    =<< State session df editor diags <$> newIORef M.empty <*> newIORef M.empty
  where
    collect diags cls doc = case cls of
      MCDiagnostic {} -> modifyIORef' diags (renderJson doc :)
      _ -> pure ()

-- | One request: its lines in, JSON out. A failure is answered as
-- {"failure": "..."}; nothing is thrown to JavaScript.
yukiRequest :: JSString -> IO JSString
yukiRequest jsReq = do
  req <- evaluate (lines (fromJSString jsReq))
  freeJSVal (coerce jsReq :: JSVal)
  r <- try $ do
    st <- getState
    case req of
      ("check" : rest) -> check st rest
      ["info", f, l, c] -> withPos l c (info st f)
      ["refs", f, l, c] -> withPos l c (refs st f)
      ["scope", f, l, c] -> withPos l c (scope st f)
      ("run" : rest) -> run st rest
      _ -> pure (obj [("failure", str ("unknown request: " ++ unwords (take 1 req)))])
  answer <- case r of
    Right a -> pure a
    Left (e :: SomeException) -> pure (obj [("failure", str (displayException e))])
  evaluate (toJSString (renderJson answer))
  where
    withPos l c k = case (readMaybe l, readMaybe c) of
      (Just line, Just col) -> k line col
      _ -> pure (obj [("failure", str "bad position")])

foreign export javascript "yukiInit"
  yukiInit :: JSString -> JSString -> JSString -> IO ()

foreign export javascript "yukiRequest"
  yukiRequest :: JSString -> IO JSString

-- * Check

-- | @check flags... == group...@: type checks the project. Each group is a
-- line of tab-separated source files loaded together (a program's Main and
-- the modules it imports; a test suite's Spec, another Main). Answers every
-- diagnostic, as GHC's JSON, and per module its file, name and top-level
-- declarations.
--
-- Every check type checks every module again (-fforce-recomp): GHC would
-- otherwise skip an unchanged module and say nothing of its warnings,
-- and the editor shows a file's warnings until they are fixed.
check :: State -> [String] -> IO JsonDoc
check st args = do
  let (flags, rest) = break (== "==") args
      groups = [words (map (\c -> if c == '\t' then ' ' else c) g) | g <- drop 1 rest, not (null g)]
  writeIORef (stDiags st) []
  -- Each group is read as soon as it is loaded: a program's Main and a test
  -- suite's are both Main, and the next group's load writes over Main.hie
  -- and replaces Main in GHC's module graph.
  checked <- inGhc st $ do
    logger <- getLogger
    (df, _, _) <- parseDynamicFlags logger (stFlags st) (map noLoc flags)
    _ <- setSessionDynFlags df
    fmap concat . forM groups $ \files -> do
      targets <- mapM (\f -> guessTarget f Nothing Nothing) files
      setTargets targets
      _ <- handleSourceError (\e -> do liftIO (printException' e); pure Failed) (load LoadAllTargets)
      graph <- getModuleGraph
      env <- getSession
      forM [ms | ms <- mgModSummaries graph, isJust (ml_hs_file (ms_location ms))] $ \ms -> do
        -- A module that did not parse has no .hie file; the queries then
        -- answer from its last one.
        r <- liftIO (try (readHieFile (hsc_NC env) (ml_hie_file (ms_location ms))))
        let hie = case r of
              Right h -> Just (hie_file_result h)
              Left (_ :: SomeException) -> Nothing
        ds <- topDecls ms
        pure (msHsFilePath ms, ms, hie, ds)
  -- A module loaded by two groups (one both import) counts once, as the
  -- first group saw it.
  let modules = nubOn (\(f, _, _, _) -> f) checked
  modifyIORef' (stHie st) (M.union (M.fromList [(f, h) | (f, _, Just h, _) <- modules]))
  modifyIORef' (stSummaries st) (M.union (M.fromList [(f, ms) | (f, ms, _, _) <- modules]))
  diags <- reverse <$> readIORef (stDiags st)
  let tops =
        [ obj
            [ ("file", str f),
              ("module", str (moduleNameString (ms_mod_name ms))),
              ("hie", J.JSBool (isJust hie)),
              ("tops", J.JSArray ds)
            ]
          | (f, ms, hie, ds) <- modules
        ]
  pure (obj [("diagnostics", J.JSArray (map Raw diags)), ("modules", J.JSArray tops)])
  where
    printException' e = modifyIORef' (stDiags st) (renderJson (obj [("severity", str "Error"), ("message", J.JSArray [str (show e)])]) :)

nubOn :: Ord b => (a -> b) -> [a] -> [a]
nubOn f = go S.empty
  where
    go _ [] = []
    go seen (x : xs)
      | f x `S.member` seen = go seen xs
      | otherwise = x : go (S.insert (f x) seen) xs

-- | A module's top-level declarations, for document symbols: name, what it
-- is, its type or declaration header as GHC prints it, and where.
topDecls :: ModSummary -> Ghc [JsonDoc]
topDecls ms = do
  mi <- getModuleInfo (ms_mod ms)
  df <- getSessionDynFlags
  pure $ case mi of
    Nothing -> []
    Just info ->
      [ obj
          [ ("name", str (occNameString (nameOccName n))),
            ("kind", str (thingKind t)),
            ("type", str (thingText df t)),
            ("span", spanJson s)
          ]
        | t <- nubOn (\t -> (getName t, thingKind t)) (modInfoTyThings info),
          not (isConstructorId t),
          let n = getName t,
          not (generated n),
          RealSrcSpan s _ <- [nameSrcSpan n],
          unpackFS (srcSpanFile s) == msHsFilePath ms
      ]
  where
    -- A data constructor is also a function (its worker and wrapper Ids):
    -- the AConLike says it once.
    isConstructorId = \case
      AnId i -> isJust (isDataConId_maybe i)
      _ -> False

thingKind :: TyThing -> String
thingKind = \case
  AnId _ -> "value"
  AConLike _ -> "constructor"
  ATyCon tc
    | isClassTyCon tc -> "class"
    | isTypeSynonymTyCon tc -> "synonym"
    | isNewTyCon tc -> "newtype"
    | isTypeFamilyTyCon tc -> "family"
    | otherwise -> "data"
  ACoAxiom _ -> "axiom"

-- | A TyThing as GHCi's :type or :info says it: @name :: type@ for a value
-- or constructor; for a type its whole declaration, constructors, fields
-- and methods included, as it would be written (@data Point = Point {px ::
-- Double, py :: Double}@).
thingText :: DynFlags -> TyThing -> String
thingText df t = case t of
  ATyCon _ -> showSDoc df (pprTyThing showToIface t)
  _ -> showSDoc df (pprTyThingHdr t)

-- | A name GHC made up (an instance's dictionary @$fShowPoint@, a
-- module's @$trModule@, a derived method), which no one wrote and no
-- query should answer with.
generated :: Name -> Bool
generated n = case occNameString (nameOccName n) of
  '$' : _ -> True
  _ -> False

-- * Queries on the last check

-- | The identifier at a position in a file's .hie AST: the innermost node
-- that names something and contains the position, and the name. A name
-- GHC generated (a derived instance's) does not count.
identAt :: HieFile -> Int -> Int -> Maybe (Span, Identifier, IdentifierDetails TypeIndex, NodeInfo TypeIndex)
identAt hf line col = listToMaybe (mapMaybe inAst (M.elems (getAsts (hie_asts hf))))
  where
    inAst ast = do
      let fs = srcSpanFile (nodeSpan ast)
          p = mkRealSrcSpan (mkRealSrcLoc fs line col) (mkRealSrcLoc fs line col)
      node <- smallestContainingSatisfying p (not . null . sourceIdents) ast
      ni <- M.lookup SourceInfo (getSourcedNodeInfo (sourcedNodeInfo node))
      -- A name before a module (a qualified name's module) is less
      -- interesting than the name.
      (i, d) <- listToMaybe (sortOn (either (const 1) (const (0 :: Int)) . fst) (written ni))
      pure (nodeSpan node, i, d, ni)
    sourceIdents n = maybe [] written (M.lookup SourceInfo (getSourcedNodeInfo (sourcedNodeInfo n)))
    -- The names written at a node: not the evidence (instance
    -- dictionaries) GHC records at the same span, nor names it made up.
    written ni =
      [ (i, d)
        | (i, d) <- M.toList (nodeIdentifiers ni),
          either (const True) (not . generated) i,
          not (any isEvidence (S.toList (identInfo d)))
      ]
    isEvidence = \case
      EvidenceVarBind {} -> True
      EvidenceVarUse -> True
      _ -> False

lookupHie :: State -> FilePath -> IO (Maybe HieFile)
lookupHie st f = M.lookup f <$> readIORef (stHie st)

-- | @info file line col@: what is at a position. Answers {"found": false}
-- or the name, where it is written ("span"), what it is ("kind"), its type
-- at this use ("type", from the .hie file), its declaration as GHC prints
-- it ("decl": the general type, or a type's header), its module and
-- package, its definition ("def", a span in a project file, or null for a
-- library's), and its Haddock comment ("doc").
info :: State -> FilePath -> Int -> Int -> IO JsonDoc
info st f line col =
  lookupHie st f >>= \case
    Nothing -> pure notFound
    Just hf -> case identAt hf line col of
      Nothing -> pure notFound
      Just (sp, Left m, _, _) ->
        pure (obj [("found", J.JSBool True), ("span", spanJson sp), ("kind", str "module"), ("name", str (moduleNameString m))])
      Just (sp, Right n, d, ni) -> do
        df <- inGhc st getSessionDynFlags
        let typeOf ix = renderHieType df (recoverFullType ix (hie_types hf))
            here = case (nodeType ni, identType d) of
              (t : _, _) -> Just (typeOf t)
              ([], Just t) -> Just (typeOf t)
              _ -> Nothing
        thing <- if isJust (nameModule_maybe n) then inGhc st (lookupName n) else pure Nothing
        docs <- if isJust (nameModule_maybe n) then inGhc st (docOf n) else pure ""
        pure $
          obj
            [ ("found", J.JSBool True),
              ("span", spanJson sp),
              ("name", str (occNameString (nameOccName n))),
              ("kind", str (nameKind n thing)),
              ("type", maybe J.JSNull str here),
              ("decl", maybe J.JSNull (str . thingText df) thing),
              ("module", maybe J.JSNull (str . moduleNameString . moduleName) (nameModule_maybe n)),
              ("package", maybe J.JSNull (str . unitString . moduleUnit) (nameModule_maybe n)),
              ("def", case nameSrcSpan n of RealSrcSpan s _ -> spanJson s; _ -> J.JSNull),
              ("doc", str docs)
            ]
  where
    notFound = obj [("found", J.JSBool False)]

nameKind :: Name -> Maybe TyThing -> String
nameKind n = \case
  Just t -> thingKind t
  Nothing
    | isTvOcc o -> "tyvar"
    | isTcOcc o -> "type"
    | isDataOcc o -> "constructor"
    | otherwise -> "value"
  where
    o = nameOccName n

-- | The Haddock comment of a name, from its module's interface (the
-- project's modules are checked with -haddock; the libraries' interfaces
-- carry theirs). Empty when there is none.
docOf :: Name -> Ghc String
docOf n = do
  r <- getDocs n
  pure $ case r of
    Right (Just ds, _) -> intercalate "\n\n" [renderHsDocString (hsDocString d) | d <- ds]
    _ -> ""

-- | @refs file line col@: every place the name at a position is written,
-- in every module of the last check: uses, its binding, its type
-- signature, export and import lists. Each is {"file", "span", "def"}
-- ("def" true at its binding). A local name is only looked for in its own
-- file.
refs :: State -> FilePath -> Int -> Int -> IO JsonDoc
refs st f line col =
  lookupHie st f >>= \case
    Nothing -> pure (J.JSArray [])
    Just hf -> case identAt hf line col of
      Just (_, Right n, _, _) -> do
        hies <- readIORef (stHie st)
        let files = if isJust (nameModule_maybe n) then M.toList hies else [(f, hf)]
        pure . J.JSArray $
          [ obj [("file", str file), ("span", spanJson sp), ("def", J.JSBool (any isBinding (S.toList (identInfo d))))]
            | (file, h) <- files,
              ast <- M.elems (getAsts (hie_asts h)),
              node <- flatten ast,
              Just ni <- [M.lookup SourceInfo (getSourcedNodeInfo (sourcedNodeInfo node))],
              Just d <- [M.lookup (Right n) (nodeIdentifiers ni)],
              let sp = nodeSpan node
          ]
      _ -> pure (J.JSArray [])
  where
    flatten n = n : concatMap flatten (nodeChildren n)
    isBinding = \case
      ValBind {} -> True
      PatternBind {} -> True
      Decl {} -> True
      ClassTyDecl {} -> True
      TyVarBind {} -> True
      RecField RecFieldDecl _ -> True
      MatchBind -> False
      _ -> False

-- | @scope file line col@: what can be written at a position, for
-- completion. "names" are the module's top-level scope as GHC's renamer
-- has it (its own declarations and every import, each with the
-- qualifiers it can be written with and whether it can be written
-- unqualified), "locals" the variables bound around the position (from
-- the .hie file), "modules" every module an import may name.
scope :: State -> FilePath -> Int -> Int -> IO JsonDoc
scope st f line col = do
  sums <- readIORef (stSummaries st)
  hie <- lookupHie st f
  names <- case M.lookup f sums of
    Nothing -> pure []
    Just ms -> do
      r <- try (inGhc st (parseModule ms >>= typecheckModule))
      case r of
        Left (_ :: SomeException) -> pure []
        Right tm -> inGhc st $ do
          df <- getSessionDynFlags
          let gres = globalRdrEnvElts (tcg_rdr_env (fst (tm_internals_ tm)))
          forM gres $ \gre -> do
            let n = gre_name gre
                specs = map is_decl (bagToList (gre_imp gre))
                quals = nub ([moduleNameString (is_as s) | s <- specs] ++ [moduleNameString (ms_mod_name ms) | gre_lcl gre])
                unqual = gre_lcl gre || any (not . is_qual) specs
            thing <- lookupName n
            pure $
              obj
                [ ("name", str (occNameString (nameOccName n))),
                  ("kind", str (nameKind n thing)),
                  ("type", maybe J.JSNull (str . thingText df) thing),
                  ("module", str (if gre_lcl gre then "" else maybe "" (moduleNameString . moduleName) (nameModule_maybe n))),
                  ("quals", J.JSArray (map str quals)),
                  ("unqual", J.JSBool unqual)
                ]
  df <- inGhc st getSessionDynFlags
  env <- inGhc st getSession
  let mods = map moduleNameString (listVisibleModuleNames (hsc_units env))
      locals = case hie of
        Nothing -> []
        Just hf ->
          nubOn fst
            [ (occNameString (nameOccName n), maybe "" (\t -> renderHieType df (recoverFullType t (hie_types hf))) (identType d))
              | ast <- M.elems (getAsts (hie_asts hf)),
                node <- flatten ast,
                Just ni <- [M.lookup SourceInfo (getSourcedNodeInfo (sourcedNodeInfo node))],
                (Right n, d) <- M.toList (nodeIdentifiers ni),
                isInternalName n,
                any (inScope (srcSpanFile (nodeSpan ast))) (S.toList (identInfo d))
            ]
  pure $
    obj
      [ ("names", J.JSArray names),
        ("locals", J.JSArray [obj [("name", str n), ("type", str t)] | (n, t) <- locals]),
        ("modules", J.JSArray (map str mods))
      ]
  where
    flatten n = n : concatMap flatten (nodeChildren n)
    inScope fs ctx =
      let p = mkRealSrcSpan (mkRealSrcLoc fs line col) (mkRealSrcLoc fs line col)
          covers = \case
            LocalScope sp -> sp `containsSpan'` p
            _ -> False
       in case ctx of
            ValBind _ sc _ -> covers sc
            PatternBind a b _ -> covers a || covers b
            _ -> False
    containsSpan' a b = srcSpanStartLine a < srcSpanStartLine b || (srcSpanStartLine a == srcSpanStartLine b && srcSpanStartCol a <= srcSpanStartCol b)
      && (srcSpanEndLine a > srcSpanEndLine b || (srcSpanEndLine a == srcSpanEndLine b && srcSpanEndCol a >= srcSpanEndCol b))

-- * Run

-- | @run flags... == entry args...@: loads the entry file and what it
-- imports into GHC's bytecode interpreter and runs its @main@, as
-- @runghc@ does, with the program's arguments. A flag @env:NAME=VALUE@ is
-- not GHC's: it sets an environment variable for the program. GHC's errors go to stderr
-- as ghc prints them. Answers {"exit": code}: 1 when it did not compile,
-- the code @main@ exited with (0 when it returned), or 1 after printing an
-- uncaught exception as a compiled program does.
run :: State -> [String] -> IO JsonDoc
run st args = do
  let (allFlags, rest) = break (== "==") args
      (envs, flags) = partitionEithers [maybe (Right a) Left (stripPrefix "env:" a) | a <- allFlags]
      (entry, progArgs) = case drop 1 rest of
        (e : as) -> (e, as)
        [] -> ("Main.hs", [])
  mapM_ (\e -> let (k, v) = break (== '=') e in setEnv k (drop 1 v)) envs
  ok <- inGhc st $ do
    logger <- getLogger
    (df, _, _) <- parseDynamicFlags logger (stFlags st) (map noLoc flags)
    _ <- setSessionDynFlags df
    t <- guessTarget entry Nothing Nothing
    setTargets [t]
    r <- handleSourceError (\e -> do printException e; pure Failed) (load LoadAllTargets)
    pure (succeeded r)
  if not ok
    then pure (obj [("exit", J.JSInt 1)])
    else do
      r <- try $ inGhc st $ do
        setContext [IIDecl (simpleImportDecl (mkModuleName "Main")), IIDecl (simpleImportDecl (mkModuleName "System.Environment"))]
        fhv <- compileExprRemote ("System.Environment.withProgName \"haskell-project\" (System.Environment.withArgs " ++ show progArgs ++ " Main.main)")
        env <- getSession
        liftIO (evalIO (hscInterp env) fhv)
      hFlush stdout
      code <- case r of
        Right () -> pure 0
        Left (e :: SomeException) -> case fromException e of
          Just ExitSuccess -> pure 0
          Just (ExitFailure c) -> pure c
          Nothing -> do
            hPutStrLn stderr ("haskell-project: " ++ displayException e)
            pure 1
      hFlush stderr
      pure (obj [("exit", J.JSInt code)])

-- * JSON

-- | Raw is JSON already rendered (GHC's diagnostics).
pattern Raw :: String -> JsonDoc
pattern Raw s = J.JSArray [J.JSString "\0raw", J.JSString s]

obj :: [(String, JsonDoc)] -> JsonDoc
obj = J.JSObject

str :: String -> JsonDoc
str = J.JSString

spanJson :: RealSrcSpan -> JsonDoc
spanJson s =
  obj
    [ ("file", str (unpackFS (srcSpanFile s))),
      ("sl", J.JSInt (srcSpanStartLine s)),
      ("sc", J.JSInt (srcSpanStartCol s)),
      ("el", J.JSInt (srcSpanEndLine s)),
      ("ec", J.JSInt (srcSpanEndCol s))
    ]

renderJson :: JsonDoc -> String
renderJson d = go d ""
  where
    go = \case
      Raw s -> showString s
      J.JSNull -> showString "null"
      J.JSBool b -> showString (if b then "true" else "false")
      J.JSInt n -> shows n
      J.JSString s -> quote s
      J.JSArray xs -> showChar '[' . commas (map go xs) . showChar ']'
      J.JSObject fs -> showChar '{' . commas [quote k . showChar ':' . go v | (k, v) <- fs] . showChar '}'
    commas [] = id
    commas (x : xs) = x . foldr (\y acc -> showChar ',' . y . acc) id xs
    quote s = showChar '"' . foldr (\c acc -> esc c . acc) id s . showChar '"'
    esc c = case c of
      '"' -> showString "\\\""
      '\\' -> showString "\\\\"
      '\n' -> showString "\\n"
      '\r' -> showString "\\r"
      '\t' -> showString "\\t"
      _
        | c < ' ' -> showString "\\u" . showString (pad (showHex' (fromEnum c)))
        | otherwise -> showChar c
    pad s = replicate (4 - length s) '0' ++ s
    showHex' n = let (q, r) = n `divMod` 16 in (if q > 0 then showHex' q else "") ++ ["0123456789abcdef" !! r]
