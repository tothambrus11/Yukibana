-- | The part of hspec (https://hspec.github.io) that the browser's Test runs:
-- the same names and types as hspec's Test.Hspec for what is here, so a test
-- written against it builds unchanged with the real hspec, which is what the
-- downloaded project's cabal file depends on. hspec itself does not compile
-- with MicroHs (it needs QuickCheck, a terminal library and more), so this
-- is ours (packs/haskell/README.md, "Test").
--
-- Not here: QuickCheck properties (`prop`, `property`), hooks (`before`,
-- `around`), `focus` and the command line. The report has hspec's layout
-- and colours.
module Test.Hspec (
  Spec, SpecWith, SpecM, Expectation, Selector,
  hspec,
  describe, context, it, specify, xit, xdescribe, pending, pendingWith,
  shouldBe, shouldNotBe, shouldSatisfy, shouldNotSatisfy,
  shouldContain, shouldNotContain, shouldStartWith, shouldEndWith, shouldMatchList,
  shouldReturn, shouldThrow, expectationFailure,
  anyException, anyErrorCall, errorCall, anyArithException,
  ) where
import Control.Exception
import Control.Monad
import Data.IORef
import Data.List
import System.CPUTime
import System.Exit
import System.IO

-- | A spec item, as written: a group of items or one example. An example's
-- action throws to fail; `Pending` is how 'pending' says so.
data Tree = Group String [Tree] | Example String (IO ())

-- | Specs are written in a monad that collects the tree, as hspec's are.
newtype SpecM a r = SpecM ([Tree] -> (r, [Tree]))

type SpecWith a = SpecM a ()
type Spec = SpecWith ()
type Expectation = IO ()
type Selector a = a -> Bool

instance Functor (SpecM a) where
  fmap f (SpecM g) = SpecM (\ ts -> let (r, ts') = g ts in (f r, ts'))

instance Applicative (SpecM a) where
  pure r = SpecM (\ ts -> (r, ts))
  SpecM f <*> SpecM g = SpecM (\ ts -> let (h, ts1) = f ts; (r, ts2) = g ts1 in (h r, ts2))

instance Monad (SpecM a) where
  SpecM g >>= k = SpecM (\ ts -> let (r, ts1) = g ts; SpecM h = k r in h ts1)

add :: Tree -> SpecM a ()
add t = SpecM (\ ts -> ((), ts ++ [t]))

collect :: SpecM a () -> [Tree]
collect (SpecM g) = snd (g [])

describe :: String -> SpecWith a -> SpecWith a
describe name s = add (Group name (collect s))

context :: String -> SpecWith a -> SpecWith a
context = describe

xdescribe :: String -> SpecWith a -> SpecWith a
xdescribe name s = add (Group name (map skip (collect s)))
  where skip (Group n ts) = Group n (map skip ts)
        skip (Example n _) = Example n (throwIO (Pending Nothing))

it :: String -> Expectation -> SpecWith a
it name e = add (Example name e)

specify :: String -> Expectation -> SpecWith a
specify = it

xit :: String -> Expectation -> SpecWith a
xit name _ = add (Example name (throwIO (Pending Nothing)))

-- | Why an example did not pass.
data Failure = ExpectationFailed String | Pending (Maybe String)
  deriving (Show)

instance Exception Failure

pending :: Expectation
pending = throwIO (Pending Nothing)

pendingWith :: String -> Expectation
pendingWith why = throwIO (Pending (Just why))

expectationFailure :: String -> Expectation
expectationFailure = throwIO . ExpectationFailed

infix 1 `shouldBe`, `shouldNotBe`, `shouldSatisfy`, `shouldNotSatisfy`, `shouldContain`, `shouldNotContain`
infix 1 `shouldStartWith`, `shouldEndWith`, `shouldMatchList`, `shouldReturn`, `shouldThrow`

shouldBe :: (Show a, Eq a) => a -> a -> Expectation
actual `shouldBe` expected =
  unless (actual == expected) $ expectationFailure ("expected: " ++ show expected ++ "\n but got: " ++ show actual)

shouldNotBe :: (Show a, Eq a) => a -> a -> Expectation
actual `shouldNotBe` notExpected =
  when (actual == notExpected) $ expectationFailure ("not expected: " ++ show actual)

shouldSatisfy :: Show a => a -> (a -> Bool) -> Expectation
v `shouldSatisfy` p = unless (p v) $ expectationFailure ("predicate failed on: " ++ show v)

shouldNotSatisfy :: Show a => a -> (a -> Bool) -> Expectation
v `shouldNotSatisfy` p = when (p v) $ expectationFailure ("predicate succeeded on: " ++ show v)

shouldContain :: (Show a, Eq a) => [a] -> [a] -> Expectation
list `shouldContain` sub =
  unless (sub `isInfixOf` list) $ expectationFailure (show list ++ " does not contain " ++ show sub)

shouldNotContain :: (Show a, Eq a) => [a] -> [a] -> Expectation
list `shouldNotContain` sub =
  when (sub `isInfixOf` list) $ expectationFailure (show list ++ " does contain " ++ show sub)

shouldStartWith :: (Show a, Eq a) => [a] -> [a] -> Expectation
list `shouldStartWith` prefix =
  unless (prefix `isPrefixOf` list) $ expectationFailure (show list ++ " does not start with " ++ show prefix)

shouldEndWith :: (Show a, Eq a) => [a] -> [a] -> Expectation
list `shouldEndWith` suffix =
  unless (suffix `isSuffixOf` list) $ expectationFailure (show list ++ " does not end with " ++ show suffix)

shouldMatchList :: (Show a, Eq a) => [a] -> [a] -> Expectation
xs `shouldMatchList` ys =
  unless (null (xs \\ ys) && null (ys \\ xs)) $
    expectationFailure (show xs ++ " is not a permutation of " ++ show ys)

shouldReturn :: (Show a, Eq a) => IO a -> a -> Expectation
action `shouldReturn` expected = action >>= (`shouldBe` expected)

-- | The action must throw an exception of the selector's type that the
-- selector accepts. Only what the action throws counts: a pure value it
-- returns is not evaluated, as in hspec (use 'evaluate').
shouldThrow :: Exception e => IO a -> Selector e -> Expectation
action `shouldThrow` p = do
  r <- try action
  case r of
    Right _ -> expectationFailure "did not get expected exception"
    Left e -> unless (p e) $ expectationFailure ("predicate failed on expected exception: " ++ show e)

anyException :: Selector SomeException
anyException = const True

anyErrorCall :: Selector ErrorCall
anyErrorCall = const True

errorCall :: String -> Selector ErrorCall
errorCall msg (ErrorCall m) = m == msg

anyArithException :: Selector ArithException
anyArithException = const True

------------------------------------------------------------------------
-- Running

green, red, yellow, reset :: String
green = "\ESC[32m"
red = "\ESC[31m"
yellow = "\ESC[33m"
reset = "\ESC[0m"

-- | Runs the spec and prints hspec's report; exits with 1 when an example
-- failed, as hspec does.
hspec :: Spec -> IO ()
hspec spec = do
  t0 <- getCPUTime
  failures <- newIORef []
  counts <- newIORef (0 :: Int, 0 :: Int)
  let run path depth tree = case tree of
        Group name ts -> do
          putStrLn (indent depth ++ name)
          mapM_ (run (path ++ [name]) (depth + 1)) ts
        Example name action -> do
          r <- try (action >>= evaluate)
          modifyIORef counts (\ (n, p) -> (n + 1, p))
          case r of
            Right () -> putStrLn (indent depth ++ name ++ " [" ++ green ++ "\x2714" ++ reset ++ "]")
            Left e -> case fromException e of
              Just (Pending why) -> do
                modifyIORef counts (\ (n, p) -> (n, p + 1))
                putStrLn (indent depth ++ yellow ++ name ++ reset)
                putStrLn (indent (depth + 1) ++ yellow ++ "# PENDING: " ++ maybe "No reason given" id why ++ reset)
              _ -> do
                fs <- readIORef failures
                let k = length fs + 1
                    what = case fromException e of
                      Just (ExpectationFailed m) -> m
                      _ -> "uncaught exception: " ++ displayException e
                writeIORef failures (fs ++ [(k, unwords (path ++ [name]), what)])
                putStrLn (indent depth ++ red ++ name ++ " FAILED [" ++ show k ++ "]" ++ reset)
  mapM_ (run [] 0) (collect spec)
  fs <- readIORef failures
  unless (null fs) $ do
    putStrLn ""
    putStrLn "Failures:"
    forM_ fs $ \ (k, name, what) -> do
      putStrLn ""
      putStrLn ("  " ++ show k ++ ") " ++ name)
      mapM_ (\ l -> putStrLn ("       " ++ red ++ l ++ reset)) (lines what)
  t1 <- getCPUTime
  (n, p) <- readIORef counts
  let secs = fromIntegral (t1 - t0) / 1e12 :: Double
      summary = plural n "example" ++ ", " ++ plural (length fs) "failure" ++ (if p > 0 then ", " ++ show p ++ " pending" else "")
  putStrLn ""
  putStrLn ("Finished in " ++ showFixed4 secs ++ " seconds")
  putStrLn ((if null fs then if p > 0 then yellow else green else red) ++ summary ++ reset)
  hFlush stdout
  unless (null fs) $ exitWith (ExitFailure 1)
  where
    indent d = replicate (2 * d) ' '
    plural k w = show k ++ " " ++ w ++ (if k == 1 then "" else "s")
    showFixed4 x = let m = round (x * 10000) :: Integer
                       (a, b) = m `divMod` 10000
                       s = show b
                   in show a ++ "." ++ replicate (4 - length s) '0' ++ s
