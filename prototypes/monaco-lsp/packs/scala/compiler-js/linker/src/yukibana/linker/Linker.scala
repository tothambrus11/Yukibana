package yukibana.linker

import scala.concurrent.{ExecutionContext, Future}
import scala.scalajs.js
import scala.scalajs.js.JSConverters.*
import scala.scalajs.js.annotation.*
import scala.scalajs.js.typedarray.*

import org.scalajs.ir
import org.scalajs.linker.{MemOutputDirectory, StandardImpl}
import org.scalajs.linker.interface.*
import org.scalajs.linker.interface.unstable.IRFileImpl
import org.scalajs.logging.{Level, Logger}

/** An IR file read straight from a slice of a downloaded bundle: no copy, and
 *  only the parts the linker asks for are ever deserialized. */
private final class SliceIRFile(path: String, bytes: Int8Array) extends IRFileImpl(path, ir.Version.Unversioned) {
  def entryPointsInfo(implicit ec: ExecutionContext): Future[ir.EntryPointsInfo] =
    IRFileImpl.withPathExceptionContext(path, Future(ir.Serializers.deserializeEntryPointsInfo(TypedArrayBuffer.wrap(bytes))))
  def tree(implicit ec: ExecutionContext): Future[ir.Trees.ClassDef] =
    IRFileImpl.withPathExceptionContext(path, Future(ir.Serializers.deserialize(TypedArrayBuffer.wrap(bytes))))
}

/** The Scala.js 1.19.0 linker (scalajs-linker_sjs1, i.e. the linker itself
 *  compiled with Scala.js), as runner.js calls it. */
object YukibanaLinker {
  private given ExecutionContext = scala.scalajs.concurrent.JSExecutionContext.queue

  /** Links `files` ([path, Int8Array] of .sjsir: the program's and the whole
   *  library's) into one ES module and resolves to its bytes (UTF-8).
   *
   *  `initializers` are [className, methodName, "args" | "noargs"], run in
   *  order when the module is evaluated: `noargs` names a static `m(): Unit`,
   *  `args` a static `m(Array[String]): Unit` called with no arguments.
   *  Semantics are Scala.js's "compliant" ones wherever there is a choice, so
   *  a bad cast, an index out of bounds or a null dereference throws the JVM's
   *  exception instead of being undefined behaviour. Errors and warnings go to
   *  `onLog(level, message)`; on a linking error the promise rejects. */
  @JSExportTopLevel("link")
  def link(files: js.Array[js.Array[js.Any]], initializers: js.Array[js.Array[String]], optimize: Boolean,
      onLog: js.Function2[String, String, Unit]): js.Promise[Int8Array] = {
    val irFiles = files.toList.map { f =>
      new SliceIRFile(f(0).asInstanceOf[String], f(1).asInstanceOf[Int8Array]): IRFile
    }
    val inits = initializers.toList.map { i =>
      if (i(2) == "args") ModuleInitializer.mainMethodWithArgs(i(0), i(1))
      else ModuleInitializer.mainMethod(i(0), i(1))
    }
    val compliant = CheckedBehavior.Compliant
    val semantics = Semantics.Defaults
      .withAsInstanceOfs(compliant)
      .withArrayIndexOutOfBounds(compliant)
      .withArrayStores(compliant)
      .withNegativeArraySizes(compliant)
      .withNullPointers(compliant)
      .withStringIndexOutOfBounds(compliant)
      .withModuleInit(compliant)
    val config = StandardConfig()
      .withModuleKind(ModuleKind.ESModule)
      .withESFeatures(_.withESVersion(ESVersion.ES2021))
      .withSemantics(semantics)
      .withOptimizer(optimize)
      .withCheckIR(false)
      .withSourceMap(false)
      .withPrettyPrint(false)
      .withParallel(false)
      .withBatchMode(true)
    val logger = new Logger {
      def log(level: Level, message: => String): Unit = level match {
        case Level.Error => onLog("error", message)
        case Level.Warn => onLog("warning", message)
        case _ =>
      }
      def trace(t: => Throwable): Unit = onLog("trace", t.toString)
    }
    val out = MemOutputDirectory()
    StandardImpl.linker(config).link(irFiles, inits, out, logger).map { report =>
      val name = report.publicModules.head.jsFileName
      out.content(name).getOrElse(throw new IllegalStateException(s"the linker wrote no $name")).toTypedArray
    }.toJSPromise
  }
}
