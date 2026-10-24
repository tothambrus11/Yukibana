// Scala rewrites of upstream's dotc/sbt/interfaces/*.java (see
// interfaces/package.scala for why). The incremental-compilation callback is
// never set in the browser; only the shape is needed.
package dotty.tools.dotc.sbt.interfaces

import dotty.tools.dotc.util.SourceFile
import dotty.tools.dotc.CompilationUnit
import java.nio.file.Path
import java.util.EnumSet

trait IncrementalCallback {
  def api(sourceFile: SourceFile, classApi: xsbti.api.ClassLike): Unit = ()
  def startSource(sourceFile: SourceFile): Unit = ()
  def mainClass(sourceFile: SourceFile, className: String): Unit = ()
  def enabled(): Boolean = false
  def usedName(className: String, name: String, useScopes: EnumSet[xsbti.UseScope]): Unit = ()
  def binaryDependency(onBinaryEntry: Path, onBinaryClassName: String, fromClassName: String,
      fromSourceFile: SourceFile, context: xsbti.api.DependencyContext): Unit = ()
  def classDependency(onClassName: String, sourceClassName: String, context: xsbti.api.DependencyContext): Unit = ()
  def generatedLocalClass(source: SourceFile, classFile: Path): Unit = ()
  def generatedNonLocalClass(source: SourceFile, classFile: Path, binaryClassName: String, srcClassName: String): Unit = ()
  def apiPhaseCompleted(): Unit = ()
  def dependencyPhaseCompleted(): Unit = ()
}

trait ProgressCallback {
  def cancel(): Unit = ()
  def isCancelled(): Boolean = false
  def informUnitStarting(phase: String, unit: CompilationUnit): Unit = ()
  def progress(current: Int, total: Int, currPhase: String, nextPhase: String): Boolean = true
}
