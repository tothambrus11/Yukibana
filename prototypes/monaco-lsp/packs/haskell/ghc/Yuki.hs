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
-- (server.js) checks the project with 'check' and asks 'info', 'refs',
-- 'scope', 'sig', 'tokens', 'calls', 'imports' and 'exports' about what
-- that check saw; the runner
-- (runner.js) uses 'run'.
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
import Control.Concurrent.MVar (modifyMVar_, takeMVar)
import Control.Monad.IO.Class (liftIO)
import Data.Coerce (coerce)
import Data.IORef
import Data.Either (partitionEithers)
import Data.List (intercalate, nub, sortOn, stripPrefix)
import qualified Data.Map.Strict as M
import Data.Maybe (catMaybes, isJust, isNothing, listToMaybe, mapMaybe)
import qualified Data.Set as S
import GHC.IO.Encoding (getLocaleEncoding)
import qualified GHC.IO.FD as FD
import GHC.IO.Handle.Internals (mkHandle)
import GHC.IO.Handle.Types (Handle (..), HandleType (ReadHandle), nativeNewlineMode)
import System.Environment (setEnv)
import System.Exit (ExitCode (..))
import System.IO
import System.IO.Unsafe (unsafePerformIO)
import Text.Read (readMaybe)

import GHC
import GHC.Core.ConLike (ConLike (..))
import GHC.Core.DataCon (dataConTyCon)
import GHC.Core.TyCon (tyConName)
import GHC.Data.Bag (bagToList)
import GHC.Data.FastString (FastString, unpackFS)
import GHC.Driver.Env (hscInterp, hsc_NC, hsc_units)
import GHC.Driver.Monad (Session (..), modifyLogger, reflectGhc)
import GHC.Driver.Ppr (showSDoc)
import GHC.Driver.Session (gopt_set)
import GHC.Hs (HsModule (..), ImportDecl (..), ImportDeclQualifiedStyle (..), ImportListInterpretation (..), getLocA)
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
import GHC.Types.Name.Reader (GlobalRdrElt, ImpDeclSpec (..), ImportSpec (..), Parent (..), globalRdrEnvElts, gre_imp, gre_lcl, gre_name, gre_par)
import GHC.Types.SrcLoc (containsSpan, mkRealSrcLoc, mkRealSrcSpan)
import GHC.Iface.Syntax (showToIface)
import GHC.Core.TyCo.Rep (scaledThing)
import GHC.Tc.Utils.TcType (tcSplitFunTys, tcSplitNestedSigmaTys)
import GHC.Types.Id (isClassOpId, isDataConId_maybe)
import GHC.Utils.Outputable (ppr)
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
    stSummaries :: !(IORef (M.Map FilePath ModSummary)),
    -- | What every visible library module exports, by name: made by the
    -- first 'exports' request (it reads every module's interface) and kept,
    -- as the libraries do not change.
    stExports :: !(IORef (Maybe (M.Map String [(String, Name)])))
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
    =<< State session df editor diags <$> newIORef M.empty <*> newIORef M.empty <*> newIORef Nothing
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
      ["sig", f, l, c, name] -> withPos l c (\line col -> sig st f line col name)
      ["tokens", f] -> tokens st f
      ["calls", f, l, c] -> withPos l c (calls st f)
      ["imports", f] -> explicitImports st f
      ["exports", name] -> exportsOf st name
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
  -- Only a module that parsed (it has a .hie file) replaces its summary:
  -- completion type checks the summary's text again for what is in scope,
  -- and the text being typed (`Map.`) seldom parses. Keeping the broken
  -- one made completion after `Map.` empty whenever the check of the
  -- half-typed line ran before the completion request.
  modifyIORef' (stSummaries st) (M.union (M.fromList [(f, ms) | (f, ms, Just _, _) <- modules]))
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

-- | Whether a name's use is evidence (an instance dictionary) GHC records
-- at the span of what needed it, rather than a name written there.
isEvidence :: ContextInfo -> Bool
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
                any (inScopeAt (srcSpanFile (nodeSpan ast)) line col) (S.toList (identInfo d))
            ]
  pure $
    obj
      [ ("names", J.JSArray names),
        ("locals", J.JSArray [obj [("name", str n), ("type", str t)] | (n, t) <- locals]),
        ("modules", J.JSArray (map str mods))
      ]
  where
    flatten n = n : concatMap flatten (nodeChildren n)

-- | Whether a local binding (a let, where or pattern variable, from its
-- .hie context) is in scope at a position of file @fs@.
inScopeAt :: FastString -> Int -> Int -> ContextInfo -> Bool
inScopeAt fs line col ctx =
  let p = mkRealSrcSpan (mkRealSrcLoc fs line col) (mkRealSrcLoc fs line col)
      covers = \case
        LocalScope sp -> sp `containsSpan'` p
        _ -> False
   in case ctx of
        ValBind _ sc _ -> covers sc
        PatternBind a b _ -> covers a || covers b
        _ -> False
  where
    containsSpan' a b = srcSpanStartLine a < srcSpanStartLine b || (srcSpanStartLine a == srcSpanStartLine b && srcSpanStartCol a <= srcSpanStartCol b)
      && (srcSpanEndLine a > srcSpanEndLine b || (srcSpanEndLine a == srcSpanEndLine b && srcSpanEndCol a >= srcSpanEndCol b))

-- * Signature help

-- | @sig file line col name@: the signature of the function a call at a
-- position applies, for signature help. @name@ is the call's head as
-- written (@distance@, @Map.insert@, @Point@); the server finds it in the
-- text as it is now, so a check that is a keystroke behind does not move
-- it. A local (a let, where or lambda binding in scope at the position)
-- is looked up in the file's .hie file and has the type GHC inferred for
-- it; anything else in the module's scope as GHC's renamer has it, with
-- the qualifier it is written with, and has its declared type. Answers
-- {"found": false} or the name, its context (the constraints, each as
-- GHC prints it), its arguments' types, its result's type and its
-- Haddock comment. Foralls and constraints are taken from under the
-- arrows too (GHC's tcSplitNestedSigmaTys), so a class method's arguments
-- are counted as written (@fmap :: Functor f => (a -> b) -> f a -> f b@).
sig :: State -> FilePath -> Int -> Int -> String -> IO JsonDoc
sig st f line col written = do
  let (qual, occ) = splitQualified written
  df <- inGhc st getSessionDynFlags
  hie <- lookupHie st f
  let local = case (qual, hie) of
        (Nothing, Just hf) ->
          listToMaybe
            [ recoverFullType t (hie_types hf)
              | ast <- M.elems (getAsts (hie_asts hf)),
                node <- flatten ast,
                Just ni <- [M.lookup SourceInfo (getSourcedNodeInfo (sourcedNodeInfo node))],
                (Right n, d) <- M.toList (nodeIdentifiers ni),
                isInternalName n,
                occNameString (nameOccName n) == occ,
                any (inScopeAt (srcSpanFile (nodeSpan ast)) line col) (S.toList (identInfo d)),
                Just t <- [identType d]
            ]
        _ -> Nothing
  case local of
    Just t ->
      let (ctx, args, res) = splitHie t
       in pure (answer occ (map (renderHieType df) ctx) (map (renderHieType df) args) (renderHieType df res) "")
    Nothing -> do
      sums <- readIORef (stSummaries st)
      case M.lookup f sums of
        Nothing -> pure notFound
        Just ms -> do
          r <- try (inGhc st (parseModule ms >>= typecheckModule))
          case r of
            Left (_ :: SomeException) -> pure notFound
            Right tm -> do
              let candidates =
                    [ gre_name gre
                      | gre <- globalRdrEnvElts (tcg_rdr_env (fst (tm_internals_ tm))),
                        let n = gre_name gre
                            o = nameOccName n
                            specs = map is_decl (bagToList (gre_imp gre))
                            quals = [moduleNameString (is_as s) | s <- specs] ++ [moduleNameString (ms_mod_name ms) | gre_lcl gre]
                            unqual = gre_lcl gre || any (not . is_qual) specs,
                        occNameString o == occ,
                        not (isTcOcc o || isTvOcc o),
                        maybe unqual (`elem` quals) qual
                    ]
              case candidates of
                [] -> pure notFound
                (n : _) -> do
                  thing <- inGhc st (lookupName n)
                  case thing >>= thingType of
                    Nothing -> pure notFound
                    Just ty -> do
                      doc <- inGhc st (docOf n)
                      let (_, theta, rho) = tcSplitNestedSigmaTys ty
                          (args, res) = tcSplitFunTys rho
                          sh :: Type -> String
                          sh = showSDoc df . ppr
                      pure (answer occ (map sh theta) (map (sh . scaledThing) args) (sh res) doc)
  where
    notFound = obj [("found", J.JSBool False)]
    flatten n = n : concatMap flatten (nodeChildren n)
    answer name ctx args res doc =
      obj
        [ ("found", J.JSBool True),
          ("name", str name),
          ("context", J.JSArray (map str ctx)),
          ("args", J.JSArray (map (str . parenArrow) args)),
          ("result", str res),
          ("doc", str doc)
        ]
    -- An argument that is itself a function is written in parentheses.
    parenArrow s = if topLevelArrow (0 :: Int) s then "(" ++ s ++ ")" else s
    topLevelArrow depth = \case
      '-' : '>' : rest -> depth == 0 || topLevelArrow depth rest
      c : rest
        | c `elem` "([{" -> topLevelArrow (depth + 1) rest
        | c `elem` ")]}" -> topLevelArrow (depth - 1) rest
        | otherwise -> topLevelArrow depth rest
      [] -> False

-- | The type of a value: an identifier's, or a data constructor's as a
-- function of its fields.
thingType :: TyThing -> Maybe Type
thingType = \case
  AnId i -> Just (idType i)
  AConLike (RealDataCon dc) -> Just (dataConWrapperType dc)
  _ -> Nothing

-- | A .hie type's constraints, arguments and result, foralls dropped, as
-- 'sig' splits a declared type.
splitHie :: HieTypeFix -> ([HieTypeFix], [HieTypeFix], HieTypeFix)
splitHie t@(Roll ty) = case ty of
  HForAllTy _ b -> splitHie b
  HQualTy c b -> let (cs, xs, r) = splitHie b in (c : cs, xs, r)
  HFunTy _ a b -> let (cs, xs, r) = splitHie b in (cs, a : xs, r)
  _ -> ([], [], t)

-- | @M.N.name@ as its qualifier and its name.
splitQualified :: String -> (Maybe String, String)
splitQualified s = case break (== '.') s of
  (m@(c : _), '.' : rest) | c >= 'A' && c <= 'Z', not (null rest) ->
    let (q, n) = splitQualified rest in (Just (maybe m ((m ++ ".") ++) q), n)
  _ -> (Nothing, s)

-- * Semantic tokens

-- | @tokens file@: every name written in a file at its last check, for
-- semantic highlighting, as HLS's semantic tokens plugin classifies them
-- from the same .hie file: a flat array of [line, startCol, endCol, kind,
-- name] (GHC's 1-based lines and columns, one line each). The kinds are
-- "variable", "function" (a value whose type is a function's), "method"
-- (a class method), "property" (a record field), "enumMember" (a data
-- constructor), "macro" (a pattern synonym), "type", "class",
-- "interface" (a type family), "typeParameter", "operator" (a value
-- written in symbols) and "namespace" (a module). The name is the one
-- written there without its qualifier: the server keeps a token only
-- where the text still says it, so a check a keystroke behind colours
-- nothing wrongly, and a name a splice generated (its span the splice's)
-- is dropped.
tokens :: State -> FilePath -> IO JsonDoc
tokens st f =
  lookupHie st f >>= \case
    Nothing -> pure (J.JSArray [])
    Just hf -> do
      let found =
            M.fromList
              [ ((srcSpanStartLine sp, srcSpanStartCol sp), (sp, i, d))
                | ast <- M.elems (getAsts (hie_asts hf)),
                  node <- flatten ast,
                  Just ni <- [M.lookup SourceInfo (getSourcedNodeInfo (sourcedNodeInfo node))],
                  (i, d) <- M.toList (nodeIdentifiers ni),
                  either (const True) (not . generated) i,
                  not (any isEvidence (S.toList (identInfo d))),
                  let sp = nodeSpan node,
                  srcSpanStartLine sp == srcSpanEndLine sp,
                  srcSpanEndCol sp > srcSpanStartCol sp
              ]
          globals = nub [n | (_, Right n, _) <- M.elems found, not (isInternalName n)]
      things <- M.fromList . catMaybes <$> forM globals (\n -> fmap (\t -> (n, t)) <$> inGhc st (lookupName n))
      pure . J.JSArray . concat $
        [ [J.JSInt (srcSpanStartLine sp), J.JSInt (srcSpanStartCol sp), J.JSInt (srcSpanEndCol sp), str kind, str name]
          | (sp, i, d) <- M.elems found,
            let (kind, name) = case i of
                  Left m -> ("namespace", lastComponent (moduleNameString m))
                  Right n -> (tokenKind hf (M.lookup n things) n d, occNameString (nameOccName n))
        ]
  where
    flatten n = n : concatMap flatten (nodeChildren n)
    lastComponent m = reverse (takeWhile (/= '.') (reverse m))

tokenKind :: HieFile -> Maybe TyThing -> Name -> IdentifierDetails TypeIndex -> String
tokenKind hf thing n d
  | any isField (S.toList (identInfo d)) = "property"
  | otherwise = case thing of
      Just (AnId i)
        | isClassOpId i -> "method"
        | isRecordSelector i -> "property"
        | symbolic -> "operator"
        | isFunction (idType i) -> "function"
        | otherwise -> "variable"
      Just (AConLike (RealDataCon _)) -> "enumMember"
      Just (AConLike PatSynCon {}) -> "macro"
      Just (ATyCon tc)
        | isClassTyCon tc -> "class"
        | isTypeFamilyTyCon tc -> "interface"
        | otherwise -> "type"
      _
        | isTvOcc o -> "typeParameter"
        | isTcOcc o -> "type"
        | isDataOcc o -> "enumMember"
        | symbolic -> "operator"
        | Just t <- identType d, hieFunction (recoverFullType t (hie_types hf)) -> "function"
        | otherwise -> "variable"
  where
    o = nameOccName n
    symbolic = case occNameString o of
      c : _ -> not (c == '_' || isAlphaChar c)
      [] -> False
    isAlphaChar c = c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c > '\x7f'
    isField = \case
      RecField {} -> True
      _ -> False
    isFunction ty = let (_, _, rho) = tcSplitNestedSigmaTys ty in not (null (fst (tcSplitFunTys rho)))
    hieFunction t = let (_, args, _) = splitHie t in not (null args)

-- * Call hierarchy

-- | A value binding of the last check, as a .hie file records it: the name,
-- the file, where the name is written at its binding ("sel") and the
-- whole binding ("span": every equation of a function, its where clause),
-- and its type as GHC inferred or was told it.
data Bound = Bound
  { bName :: !Name,
    bFile :: !FilePath,
    bSel :: !RealSrcSpan,
    bSpan :: !RealSrcSpan,
    bType :: !String
  }

-- | Every value binding of the last check's modules, top-level and local
-- (a where or let function is a caller and a callee of its own, as in
-- HLS's call hierarchy); not instance methods, whose name is the class's.
boundValues :: DynFlags -> M.Map FilePath HieFile -> [Bound]
boundValues df hies =
  nubOn
    (\b -> (bFile b, srcSpanStartLine (bSel b), srcSpanStartCol (bSel b)))
    [ Bound n file (nodeSpan node) whole (maybe "" (\t -> renderHieType df (recoverFullType t (hie_types hf))) (identType d))
      | (file, hf) <- M.toList hies,
        ast <- M.elems (getAsts (hie_asts hf)),
        node <- flattenAst ast,
        Just ni <- [M.lookup SourceInfo (getSourcedNodeInfo (sourcedNodeInfo node))],
        (Right n, d) <- M.toList (nodeIdentifiers ni),
        not (generated n),
        ValBind RegularBind _ (Just whole) <- S.toList (identInfo d)
    ]

-- | Where a name is used (written as a value: not its binding, its type
-- signature or an import or export list), in one file's .hie file.
usesIn :: HieFile -> (Name -> Bool) -> [(Name, RealSrcSpan)]
usesIn hf wanted =
  [ (n, nodeSpan node)
    | ast <- M.elems (getAsts (hie_asts hf)),
      node <- flattenAst ast,
      Just ni <- [M.lookup SourceInfo (getSourcedNodeInfo (sourcedNodeInfo node))],
      (Right n, d) <- M.toList (nodeIdentifiers ni),
      wanted n,
      Use `S.member` identInfo d
  ]

-- | @calls file line col@: the call hierarchy of the function named at a
-- position, as HLS's call-hierarchy plugin answers it from .hie files:
-- {"item": null} when the name is not bound by a value binding of the
-- project (a library's, a lambda's argument), else "item" (its binding),
-- "incoming" (each binding whose body uses it, with where: "from",
-- "ranges") and "outgoing" (each project binding its body uses: "to",
-- "ranges"). An item is {name, type, span (the whole binding), sel (the
-- name at its binding)}. A use outside any binding (an instance method's
-- body) has no caller and is left out.
calls :: State -> FilePath -> Int -> Int -> IO JsonDoc
calls st f line col = do
  hies <- readIORef (stHie st)
  df <- inGhc st getSessionDynFlags
  let bs = boundValues df hies
      named = M.fromListWith (flip (++)) [(bName b, [b]) | b <- bs]
      inFile = M.fromListWith (++) [(bFile b, [b]) | b <- bs]
      -- The innermost binding around a use.
      enclosing file sp =
        listToMaybe
          ( sortOn
              (\b -> (srcSpanEndLine (bSpan b) - srcSpanStartLine (bSpan b), srcSpanEndCol (bSpan b) - srcSpanStartCol (bSpan b)))
              [b | b <- M.findWithDefault [] file inFile, bSpan b `containsSpan` sp]
          )
      target = case M.lookup f hies >>= \hf -> identAt hf line col of
        Just (_, Right n, _, _) -> M.lookup n named >>= listToMaybe
        _ -> Nothing
  pure $ case target of
    Nothing -> obj [("item", J.JSNull)]
    Just b ->
      let byKey = M.fromList [(key c, c) | c <- bs]
          -- Uses grouped by the binding they are in (its caller or
          -- callee), in the order they are written.
          grouped xs =
            [ (c, sps)
              | (k, sps) <- M.toList (M.fromListWith (flip (++)) [(key c, [sp]) | (c, sp) <- xs]),
                Just c <- [M.lookup k byKey]
            ]
          incoming =
            grouped
              [ (c, sp)
                | (file, hf) <- M.toList hies,
                  (_, sp) <- usesIn hf (== bName b),
                  Just c <- [enclosing file sp]
              ]
          outgoing =
            grouped
              [ (c, sp)
                | Just hf <- [M.lookup (bFile b) hies],
                  (n, sp) <- usesIn hf (`M.member` named),
                  bSpan b `containsSpan` sp,
                  Just c <- [M.lookup n named >>= listToMaybe]
              ]
       in obj
            [ ("item", item b),
              ("incoming", J.JSArray [obj [("from", item c), ("ranges", J.JSArray (map spanJson sps))] | (c, sps) <- incoming]),
              ("outgoing", J.JSArray [obj [("to", item c), ("ranges", J.JSArray (map spanJson sps))] | (c, sps) <- outgoing])
            ]
  where
    key c = (bFile c, srcSpanStartLine (bSel c), srcSpanStartCol (bSel c))
    item b =
      obj
        [ ("name", str (occNameString (nameOccName (bName b)))),
          ("type", str (bType b)),
          ("span", spanJson (bSpan b)),
          ("sel", spanJson (bSel b))
        ]

flattenAst :: HieAST a -> [HieAST a]
flattenAst n = n : concatMap flattenAst (nodeChildren n)

-- * Imports

-- | @imports file@: for each import of the module without an import list
-- (and not qualified, and not Prelude), the list that would import just
-- what the module uses from it, as HLS's "make import explicit" code lens
-- writes it: [{module, span (the import declaration), items}], each item
-- as it is written in an import list (@sort@, @(<|>)@, @Map@, @Maybe
-- (Just, Nothing)@). What a module uses is every name its .hie file has
-- written outside import and export lists; which import brought a name
-- into scope is GHC's renamer's (each name's import specs). A name that
-- another import already lists by name is not listed again.
explicitImports :: State -> FilePath -> IO JsonDoc
explicitImports st f = do
  sums <- readIORef (stSummaries st)
  hie <- lookupHie st f
  case (M.lookup f sums, hie) of
    (Just ms, Just hf) -> do
      r <- try (inGhc st (parseModule ms >>= typecheckModule))
      case r of
        Left (_ :: SomeException) -> pure (J.JSArray [])
        Right tm -> do
          let decls = hsmodImports (unLoc (pm_parsed_source (tm_parsed_module tm)))
              used =
                S.fromList
                  [ n
                    | ast <- M.elems (getAsts (hie_asts hf)),
                      node <- flattenAst ast,
                      Just ni <- [M.lookup SourceInfo (getSourcedNodeInfo (sourcedNodeInfo node))],
                      (Right n, d) <- M.toList (nodeIdentifiers ni),
                      not (any isImportExport (S.toList (identInfo d)))
                  ]
              gres = [g | g <- globalRdrEnvElts (tcg_rdr_env (fst (tm_internals_ tm))), gre_name g `S.member` used]
              listing = [realOf (getLocA d) | d <- decls, Just (Exactly, _) <- [ideclImportList (unLoc d)]]
              from g = [realOf (is_dloc (is_decl s)) | s <- bagToList (gre_imp g)]
          pure . J.JSArray $
            [ obj [("module", str m), ("span", spanJson sp), ("items", J.JSArray (map str (importItems mine)))]
              | d <- decls,
                let i = unLoc d
                    m = moduleNameString (unLoc (ideclName i)),
                isNothing (ideclImportList i),
                ideclQualified i == NotQualified,
                m /= "Prelude",
                Just sp <- [realOf (getLocA d)],
                let mine = [g | g <- gres, Just sp `elem` from g, not (any (`elem` listing) (from g))]
            ]
    _ -> pure (J.JSArray [])
  where
    isImportExport = \case
      IEThing _ -> True
      _ -> False
    realOf = \case
      RealSrcSpan s _ -> Just s
      _ -> Nothing

-- | Names as an import list writes them: a constructor, field or method
-- under its type or class (@Maybe (Just)@, @Foldable (foldl')@), an
-- operator in parentheses, sorted.
importItems :: [GlobalRdrElt] -> [String]
importItems gs =
  let parentOf g = case gre_par g of
        ParentIs p -> Just p
        NoParent -> Nothing
      tops = nub [gre_name g | g <- gs, Nothing <- [parentOf g]]
      kids = M.fromListWith (flip (++)) [(p, [gre_name g]) | g <- gs, Just p <- [parentOf g]]
      item n = case nub (M.findWithDefault [] n kids) of
        [] -> nameItem n
        cs -> nameItem n ++ " (" ++ intercalate ", " (sortOn id (map nameItem cs)) ++ ")"
   in sortOn id (map item (tops ++ [p | p <- M.keys kids, p `notElem` tops]))

-- | A name as an import or export list writes it.
nameItem :: Name -> String
nameItem n = case occNameString (nameOccName n) of
  s@(c : _) | not (c == '_' || c == '\'' || isIdentChar c) -> "(" ++ s ++ ")"
  s -> s
  where
    isIdentChar c = c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c > '\x7f'

-- | @exports name@: every module that exports a name, for "add import":
-- the project's own modules (at the last check) and every module of the
-- packages the session exposes. Each is {module, kind, parent, home}:
-- "parent" is the type a data constructor belongs to (it is imported as
-- @T (C)@), null otherwise; "home" whether the module is the project's.
-- The first request reads every library module's interface (some 460, a
-- few seconds); the answer's index is kept.
exportsOf :: State -> String -> IO JsonDoc
exportsOf st occ = do
  idx <-
    readIORef (stExports st) >>= \case
      Just m -> pure m
      Nothing -> do
        env <- inGhc st getSession
        pairs <- fmap concat . forM (listVisibleModuleNames (hsc_units env)) $ \mn -> do
          r <- try (inGhc st (lookupModule mn Nothing >>= getModuleInfo))
          pure $ case r of
            Right (Just mi) -> [(occNameString (nameOccName n), [(moduleNameString mn, n)]) | n <- modInfoExports mi]
            Right Nothing -> []
            Left (_ :: SomeException) -> []
        let m = M.fromListWith (flip (++)) pairs
        writeIORef (stExports st) (Just m)
        pure m
  sums <- readIORef (stSummaries st)
  home <- fmap concat . forM (M.elems sums) $ \ms -> do
    r <- try (inGhc st (getModuleInfo (ms_mod ms)))
    pure $ case r of
      Right (Just mi) -> [(moduleNameString (ms_mod_name ms), n) | n <- modInfoExports mi, occNameString (nameOccName n) == occ]
      Right Nothing -> []
      Left (_ :: SomeException) -> []
  found <- forM ([(m, n, True) | (m, n) <- home] ++ [(m, n, False) | (m, n) <- M.findWithDefault [] occ idx]) $ \(m, n, isHome) -> do
    thing <- inGhc st (lookupName n)
    let parent = case thing of
          Just (AConLike (RealDataCon dc)) -> Just (nameItem (tyConName (dataConTyCon dc)))
          _ -> Nothing
    pure (obj [("module", str m), ("kind", str (nameKind n thing)), ("parent", maybe J.JSNull str parent), ("home", J.JSBool isHome)])
  pure (J.JSArray found)

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
  freshStdio
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

-- | Gives the next program the standard handles a new process would have:
-- a session runs one program after another (the runner keeps it, as GHCi
-- does), and the last may have read stdin to its end (getContents leaves
-- it closed) or changed the buffering. stdin's handle gets a new state,
-- made as base makes stdin's (fd 0, the locale's encoding, no finalizer),
-- without what the last program left unread; stdout and stderr are
-- unbuffered again. Not fdToHandle 0: it asks fcntl for fd 0's mode, which
-- WASI answers as read-write, and makes a duplex handle that stdin's state
-- cannot be taken from. The programs' stdin is this module's: the
-- interpreter runs them in this process, against the same base.
freshStdio :: IO ()
freshStdio = do
  enc <- getLocaleEncoding
  h <- mkHandle FD.stdin "<stdin>" ReadHandle True (Just enc) nativeNewlineMode Nothing Nothing
  case (stdin, h) of
    (FileHandle _ old, FileHandle _ new) -> do
      fresh <- takeMVar new
      modifyMVar_ old (const (pure fresh))
    _ -> pure ()
  hSetBuffering stdout NoBuffering
  hSetBuffering stderr NoBuffering

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
