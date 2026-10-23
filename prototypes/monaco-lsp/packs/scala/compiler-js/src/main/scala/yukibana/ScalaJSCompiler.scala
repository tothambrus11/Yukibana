package dotty.tools.dotc.yukibana

import scala.language.unsafeNulls

import scala.collection.mutable
import scala.scalajs.js
import scala.scalajs.js.annotation.*
import scala.scalajs.js.typedarray.*

import dotty.tools.dotc.{Compiler, CompilationUnit}
import dotty.tools.dotc.ast.tpd
import dotty.tools.dotc.ast.tpd.TreeOps
import dotty.tools.dotc.classpath.VirtualDirectoryClassPath
import dotty.tools.dotc.config.SJSPlatform
import dotty.tools.dotc.core.Contexts.*
import dotty.tools.dotc.core.Flags
import dotty.tools.dotc.core.NameOps.*
import dotty.tools.dotc.core.Phases.Phase
import dotty.tools.dotc.core.Symbols.*
import dotty.tools.dotc.parsing.Parser
import dotty.tools.dotc.reporting.*
import dotty.tools.dotc.transform.*
import dotty.tools.dotc.transform.localopt.{DropForMap, StringInterpolatorOpt}
import dotty.tools.dotc.typer.{RefChecks, TyperPhase}
import dotty.tools.dotc.util.SourceFile
import dotty.tools.io.{AbstractFile, ClassPath, VirtualDirectory}

/** Reads a class-path bundle that build.sh writes (classpath.bin and
 *  classpath-sjs.bin): [u32 BE header length][JSON [[path, offset, length]]][bytes]. */
object ClassPathBundle {
  def addTo(root: VirtualDirectory, bundle: Int8Array): Unit = {
    val view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength)
    val headerLength = view.getInt32(0)
    val headerBytes = new Uint8Array(bundle.buffer, bundle.byteOffset + 4, headerLength)
    val headerText = js.Dynamic.newInstance(js.Dynamic.global.TextDecoder)().decode(headerBytes).asInstanceOf[String]
    val header = js.JSON.parse(headerText).asInstanceOf[js.Array[js.Array[js.Any]]]
    val dataStart = 4 + headerLength
    header.foreach { e =>
      val path = e(0).asInstanceOf[String]
      val off = e(1).asInstanceOf[Double].toInt
      val len = e(2).asInstanceOf[Double].toInt
      val parts = path.split('/')
      var dir: AbstractFile = root
      var i = 0
      while (i < parts.length - 1) { dir = dir.subdirectoryNamed(parts(i)); i += 1 }
      val file = dir.fileNamed(parts.last)
      val bytes = new Int8Array(bundle.buffer, bundle.byteOffset + dataStart + off, len).toArray
      val out = file.output
      out.write(bytes)
      out.close()
    }
  }
}

/** Upstream's `Compiler` with the phases a browser can run and Scala.js
 *  needs, through `GenSJSIR`. Left out, so that the linker never reaches
 *  them: the sbt callbacks (`ExtractDependencies`, `ExtractAPI`), SemanticDB,
 *  coverage instrumentation (each writes files and is off by default), and
 *  `GenBCode`, the JVM back end (ASM, class files, jars). Every other phase is
 *  upstream's, in upstream's order (Compiler.scala of 3.7.4). */
final class BrowserSJSCompiler extends Compiler {
  // `phases` itself, not the four lists it is made of: InteractiveCompiler
  // (the language server's) inherits upstream's lists, so overriding only
  // those would still let the linker reach upstream's, GenBCode included.
  override def phases: List[List[Phase]] = sjsFrontend ::: sjsPickler ::: sjsTransform ::: sjsBackend

  private def sjsFrontend: List[List[Phase]] =
    List(new Parser) ::
    List(new TyperPhase) ::
    List(CheckUnused.PostTyper(), CheckShadowing()) ::
    List(new YCheckPositions) ::
    List(new PostTyper) ::
    List(new UnrollDefinitions) ::
    List(new sjs.PrepJSInterop) ::
    List(new SetRootTree) ::
    Nil

  private def sjsPickler: List[List[Phase]] =
    List(new Pickler) ::
    List(new Inlining) ::
    List(new PostInlining) ::
    List(new Staging) ::
    List(new Splicing) ::
    List(new PickleQuotes) ::
    List(new CheckUnused.PostInlining) ::
    Nil

  private def sjsTransform: List[List[Phase]] =
    List(new CrossVersionChecks, new FirstTransform, new CheckReentrant, new ElimPackagePrefixes, new CookComments,
         new CheckLoopingImplicits, new BetaReduce, new InlineVals, new ExpandSAMs, new ElimRepeated, new RefChecks,
         new DropForMap) ::
    List(new init.Checker) ::
    List(new ProtectedAccessors, new ExtensionMethods, new UncacheGivenAliases, new CheckStatic, new ElimByName,
         new HoistSuperArgs, new ForwardDepChecks, new SpecializeApplyMethods, new TryCatchPatterns, new PatternMatcher) ::
    List(new ElimOpaque, new sjs.ExplicitJSClasses, new ExplicitOuter, new ExplicitSelf, new StringInterpolatorOpt,
         new DropBreaks) ::
    List(new PruneErasedDefs, new UninitializedDefs, new InlinePatterns, new VCInlineMethods, new SeqLiterals,
         new InterceptedMethods, new Getters, new SpecializeFunctions, new SpecializeTuples, new CollectNullableFields,
         new ElimOuterSelect, new ResolveSuper, new FunctionXXLForwarders, new ParamForwarding, new TupleOptimizations,
         new LetOverApply, new ArrayConstructors) ::
    List(new Erasure) ::
    List(new ElimErasedValueType, new PureStats, new VCElideAllocations, new EtaReduce, new ArrayApply,
         new sjs.AddLocalJSFakeNews, new ElimPolyFunction, new TailRec, new CompleteJavaEnums, new Mixin, new LazyVals,
         new Memoize, new NonLocalReturns, new CapturedVars) ::
    List(new Constructors, new Instrumentation) ::
    List(new LambdaLift, new ElimStaticThis, new CountOuterAccesses) ::
    List(new DropOuterAccessors, new DropParentRefinements, new CheckNoSuperThis, new Flatten, new TransformWildcards,
         new MoveStatics, new ExpandPrivate, new RestoreScopes, new SelectStatic, new RepeatableAnnotations) ::
    Nil

  private def sjsBackend: List[List[Phase]] =
    List(new dotty.tools.backend.sjs.GenSJSIR) :: Nil
}

/** Compiles a whole project with the full Scala 3 pipeline and the Scala.js
 *  back end (`-scalajs`), to Scala.js IR (.sjsir) in memory, for runner.js to
 *  link with the Scala.js linker. Every call is a fresh compiler universe:
 *  the runner compiles once per worker. */
@JSExportTopLevel("ScalaJSCompiler")
final class ScalaJSCompiler(bundles: js.Array[Int8Array]) {

  private val classPath: ClassPath = {
    val root = new VirtualDirectory("(classpath)", None)
    bundles.foreach(ClassPathBundle.addTo(root, _))
    VirtualDirectoryClassPath(root)
  }

  /** Compiles `files` (path -> text; only `.scala` files are compiled).
   *  Returns `{ diagnostics: [{ path, line, column, severity, message,
   *  lineText }], ir: [[path, Int8Array]], mains: [className] }`. `line` and
   *  `column` count from 1; severity is "error", "warning" or "info". `ir` is
   *  empty when there are errors. `mains` lists the classes with a static
   *  `main(Array[String])` (an `@main` method's class or an object with a
   *  `main` method), those of `entry` first. */
  @JSExport def compile(files: js.Dictionary[String], entry: String): js.Object = {
    val out = new VirtualDirectory("(output)", None)
    val cp = classPath
    val base: ContextBase = new ContextBase {
      override protected def newPlatform(using Context) = new SJSPlatform() {
        override def classPath(using Context): ClassPath = cp
      }
    }
    val init = base.initialCtx.fresh
    init.setSetting(init.settings.scalajs, true)
    init.setSetting(init.settings.outputDir, out)
    init.setSetting(init.settings.color, "never")
    dotty.tools.dotc.core.MacroClassLoader.init(init)
    dotty.tools.dotc.ast.Positioned.init(using init)
    init.initialize()(using init)

    val reporter = new StoreReporter(null) with UniqueMessagePositions with HideNonSensicalMessages
    val compiler = new BrowserSJSCompiler
    val runCtx = init.fresh.setReporter(reporter)
    val run = compiler.newRun(using runCtx)
    val paths = files.keys.toList.filter(_.endsWith(".scala")).sorted
    val sources = paths.map(p => SourceFile.virtual(p, files(p)))
    val diagnostics = js.Array[js.Object]()
    val mains = mutable.ListBuffer.empty[(Boolean, String)]
    try {
      run.compileSources(sources)
      given Context = run.runContext
      if (!reporter.hasErrors) {
        val typer = ctx.base.typerPhase.next
        for (unit <- run.units) {
          val isEntry = unit.source.file.path == entry
          unit.tpdTree.foreachSubTree {
            case td: tpd.TypeDef if td.symbol.isClass =>
              val sym = td.symbol
              if (sym.isStatic && !sym.is(Flags.Trait) && atPhase(typer)(ctx.platform.hasMainMethod(sym)))
                mains += ((isEntry, sym.fullName.stripModuleClassSuffix.toString))
            case _ =>
          }
        }
      }
    } catch {
      case ex: Throwable =>
        diagnostics.push(js.Dynamic.literal(path = entry, line = 0, column = 0, severity = "error",
          message = "the compiler crashed: " + ex.toString, lineText = ""))
    }
    for (d <- reporter.removeBufferedMessages(using runCtx)) {
      val severity = d.level match {
        case dotty.tools.dotc.interfaces.Diagnostic.ERROR => "error"
        case dotty.tools.dotc.interfaces.Diagnostic.WARNING => "warning"
        case _ => "info"
      }
      val p = d.pos
      if (p.exists)
        diagnostics.push(js.Dynamic.literal(path = p.source.file.path, line = p.line + 1, column = p.column + 1,
          severity = severity, message = d.message, lineText = p.lineContent.stripLineEnd))
      else
        diagnostics.push(js.Dynamic.literal(path = "", line = 0, column = 0, severity = severity,
          message = d.message, lineText = ""))
    }
    val ir = js.Array[js.Array[js.Any]]()
    val hasErrors = diagnostics.exists(_.asInstanceOf[js.Dynamic].severity.asInstanceOf[String] == "error")
    if (!hasErrors) {
      def walk(dir: AbstractFile, prefix: String): Unit = dir.iterator.foreach { f =>
        if (f.isDirectory) walk(f, prefix + f.name + "/")
        else if (f.name.endsWith(".sjsir")) {
          val bytes = f.toByteArray
          val arr = new Int8Array(bytes.length)
          var i = 0
          while (i < bytes.length) { arr(i) = bytes(i); i += 1 }
          ir.push(js.Array[js.Any](prefix + f.name, arr))
        }
      }
      walk(out, "")
    }
    val ordered = (mains.filter(_._1) ++ mains.filterNot(_._1)).map(_._2).distinct
    js.Dynamic.literal(diagnostics = diagnostics, ir = ir, mains = js.Array(ordered.toSeq*))
  }
}
