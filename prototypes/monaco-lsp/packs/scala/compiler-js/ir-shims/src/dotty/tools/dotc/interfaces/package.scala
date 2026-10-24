// Scala rewrites of the Java interfaces in upstream's `interfaces/` module
// (scala3-interfaces). Scala.js cannot compile Java sources, and the compiler's
// own classes implement these, so they must exist as Scala.js IR. Members are
// declared the way the implementing classes in the compiler declare them.
package dotty.tools.dotc.interfaces

import java.util.Optional

trait AbstractFile {
  def name: String
  def path: String
  def jfile: Optional[java.io.File]
}

trait CompilerCallback {
  def onClassGenerated(source: SourceFile, generatedClass: AbstractFile, className: String): Unit = ()
  def onSourceCompiled(source: SourceFile): Unit = ()
}

object Diagnostic {
  final val ERROR = 2
  final val WARNING = 1
  final val INFO = 0
}
trait Diagnostic {
  def message: String
  def level: Int
  def position: Optional[SourcePosition]
  def diagnosticRelatedInformation: java.util.List[DiagnosticRelatedInformation]
}

trait DiagnosticRelatedInformation {
  def position: SourcePosition
  def message: String
}

trait ReporterResult {
  def hasErrors: Boolean
  def errorCount: Int
  def hasWarnings: Boolean
  def warningCount: Int
}

trait SimpleReporter {
  def report(diag: Diagnostic): Unit
}

trait SourceFile extends AbstractFile {
  def content(): Array[Char]
}

trait SourcePosition {
  def lineContent: String
  def point: Int
  def line: Int
  def column: Int
  def start: Int
  def startLine: Int
  def startColumn: Int
  def end: Int
  def endLine: Int
  def endColumn: Int
  def source: SourceFile
}
