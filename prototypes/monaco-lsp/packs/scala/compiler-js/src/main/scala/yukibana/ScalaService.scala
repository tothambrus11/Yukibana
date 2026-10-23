// In the compiler's package because the tree cleanup, like upstream InteractiveDriver's,
// assigns a symbol's info (protected[dotc]).
package dotty.tools.dotc.yukibana

import scala.language.unsafeNulls

import scala.collection.mutable
import scala.scalajs.js
import scala.scalajs.js.annotation.*
import scala.scalajs.js.typedarray.*

import dotty.tools.dotc.ast.{tpd, untpd}
import dotty.tools.dotc.ast.tpd.TreeOps
import dotty.tools.dotc.core.NameOps.*
import dotty.tools.dotc.classpath.VirtualDirectoryClassPath
import dotty.tools.dotc.config.JavaPlatform
import dotty.tools.dotc.core.Contexts.*
import dotty.tools.dotc.core.Flags
import dotty.tools.dotc.core.Mode
import dotty.tools.dotc.core.Symbols.*
import dotty.tools.dotc.core.Types.*
import dotty.tools.dotc.interactive.{Completion, Interactive, InteractiveCompiler, SourceTree}
import dotty.tools.dotc.interactive.Interactive.Include
import dotty.tools.dotc.reporting.*
import dotty.tools.dotc.typer.ImportInfo.withRootImports
import dotty.tools.dotc.util.{ParsedComment, Signatures, SourceFile, SourcePosition}
import dotty.tools.dotc.util.Spans.Span
import dotty.tools.io.{AbstractFile, ClassPath, VirtualDirectory}

/** The class path is one in-memory directory: the bundle that build.sh makes
 *  from the JDK's java.base and the Scala 2.13 / Scala 3 libraries. */
final class BrowserPlatform(cp: ClassPath) extends JavaPlatform {
  override def classPath(using Context): ClassPath = cp
}

/** The Scala 3 compiler's interactive front end (parser + typer, the phases
 *  upstream's `InteractiveCompiler` runs) over every open file of the
 *  workspace at once, so that files see each other's definitions. The JS side
 *  (server.js) speaks LSP and calls these methods with offsets in UTF-16 code
 *  units, which is what both Scala strings and LSP count in.
 */
@JSExportTopLevel("ScalaService")
final class ScalaService(bundle: Int8Array) {

  private val classPathRoot: VirtualDirectory = {
    val root = new VirtualDirectory("(classpath)", None)
    ClassPathBundle.addTo(root, bundle)
    root
  }

  private val classPath = VirtualDirectoryClassPath(classPathRoot)

  /** A new compiler universe: symbol tables, caches, the class path read
   *  afresh (lazily). In interactive mode a symbol entered from a source file
   *  stays visible in later runs even when no file defines it any more (that
   *  is how upstream's one-file-per-run IDE driver sees other files), so a
   *  deleted file or a removed top-level definition needs a new universe. */
  private def newInitCtx(): Context = {
    val base: ContextBase = new ContextBase {
      override protected def newPlatform(using Context) = new BrowserPlatform(classPath)
    }
    val c = base.initialCtx.fresh.addMode(Mode.ReadPositions).addMode(Mode.Interactive)
    c.setSetting(c.settings.YretainTrees, true)
    c.setSetting(c.settings.XcookComments, true)
    c.setSetting(c.settings.XreadComments, true)
    c.setSetting(c.settings.color, "never")
    // What upstream Driver.setup does besides reading arguments.
    dotty.tools.dotc.core.MacroClassLoader.init(c)
    dotty.tools.dotc.ast.Positioned.init(using c)
    c.setProperty(dotty.tools.dotc.core.Comments.ContextDoc, new dotty.tools.dotc.core.Comments.ContextDocstrings)
    c.initialize()(using c)
    c
  }

  private var initCtx: Context = newInitCtx()
  private val compiler = new InteractiveCompiler
  private var current: Context = initCtx
  /** Full names of the top-level definitions the last check saw. */
  private var topLevel = Set.empty[String]
  private var needsReset = false

  /** uri -> text of every open document. */
  private val texts = mutable.LinkedHashMap.empty[String, String]
  private val sources = mutable.Map.empty[String, SourceFile]
  private val units = mutable.Map.empty[String, dotty.tools.dotc.CompilationUnit]
  private val trees = mutable.Map.empty[String, List[SourceTree]]

  /** The file name the compiler sees for a document: the URI's path. */
  private def pathOf(uri: String): String =
    if (uri.startsWith("file://")) js.URIUtils.decodeURIComponent(uri.stripPrefix("file://")) else uri

  @JSExport def setText(uri: String, text: String): Unit = texts(uri) = text
  @JSExport def remove(uri: String): Unit = {
    if (texts.remove(uri).isDefined) needsReset = true
    sources.remove(uri); units.remove(uri); trees.remove(uri)
  }

  /** Typechecks every open document together. Returns uri -> diagnostics for
   *  every open document (an empty array clears its old ones). */
  @JSExport def check(): js.Dictionary[js.Array[js.Object]] = {
    if (needsReset) { needsReset = false; initCtx = newInitCtx() }
    val result = checkOnce()
    val now = { given Context = current; trees.values.flatten.collect { case SourceTree(t: tpd.TypeDef, _) => t.symbol.fullName.toString }.toSet }
    val gone = topLevel -- now
    topLevel = now
    if (gone.isEmpty) result
    else { initCtx = newInitCtx(); checkOnce() }
  }

  private def checkOnce(): js.Dictionary[js.Array[js.Object]] = {
    val reporter = new StoreReporter(null) with UniqueMessagePositions with HideNonSensicalMessages
    val run = compiler.newRun(using initCtx.fresh.setReporter(reporter))
    current = run.runContext.withRootImports
    given Context = current
    sources.clear(); units.clear(); trees.clear()
    val byPath = mutable.Map.empty[String, String]
    val srcs = texts.toList.map { (uri, text) =>
      val s = SourceFile.virtual(pathOf(uri), text)
      sources(uri) = s
      byPath(s.file.path) = uri
      s
    }
    val result = js.Dictionary.empty[js.Array[js.Object]]
    texts.keys.foreach(uri => result(uri) = js.Array())
    try {
      run.compileSources(srcs)
      val r = ctx.run.nn
      for (unit <- r.units ++ r.suspendedUnits; uri <- byPath.get(unit.source.file.path)) {
        val t = unit.tpdTree
        cleanup(t)
        units(uri) = unit
        trees(uri) = topLevelTrees(t, unit.source)
      }
      current = current.fresh.setPhase(initCtx.base.typerPhase)
    } catch {
      case ex: Throwable =>
        val uri = texts.keys.headOption
        uri.foreach(u => result(u).push(diag(0, 0, 0, 0, 1, "compiler crashed: " + ex.toString)))
    }
    for (d <- reporter.removeBufferedMessages(using current) if d.pos.exists; uri <- byPath.get(d.pos.source.file.path)) {
      val p = d.pos
      val severity = d.level match {
        case dotty.tools.dotc.interfaces.Diagnostic.ERROR => 1
        case dotty.tools.dotc.interfaces.Diagnostic.WARNING => 2
        case _ => 3
      }
      result(uri).push(diag(p.start, p.end, p.source, severity, d.message))
    }
    result
  }

  private def diag(start: Int, end: Int, src: SourceFile, severity: Int, message: String): js.Object = {
    val (sl, sc) = lineCol(src, start)
    val (el, ec) = lineCol(src, end max start)
    diag(sl, sc, el, ec, severity, message)
  }
  private def diag(sl: Int, sc: Int, el: Int, ec: Int, severity: Int, message: String): js.Object =
    js.Dynamic.literal(range = range(sl, sc, el, ec), severity = severity, source = "scala3", message = message)

  private def range(sl: Int, sc: Int, el: Int, ec: Int): js.Object =
    js.Dynamic.literal(start = js.Dynamic.literal(line = sl, character = sc), end = js.Dynamic.literal(line = el, character = ec))

  private def lineCol(src: SourceFile, offset: Int): (Int, Int) = {
    val o = offset min src.content().length max 0
    val line = src.offsetToLine(o)
    (line, o - src.lineToOffset(line))
  }

  private def rangeOf(pos: SourcePosition): js.Object = {
    val (sl, sc) = lineCol(pos.source, pos.start)
    val (el, ec) = lineCol(pos.source, pos.end)
    range(sl, sc, el, ec)
  }

  private def uriOfSource(src: SourceFile): Option[String] =
    sources.collectFirst { case (uri, s) if s.file.path == src.file.path => uri }

  private def position(uri: String, line: Int, character: Int): Option[SourcePosition] =
    sources.get(uri).map { src =>
      // As LSP says, a character past the end of its line means the end of
      // that line. Clamping only to the end of the file (as this once did)
      // made such a position answer for a token on a later line.
      val text = src.content()
      val start = src.lineToOffset((line max 0) min src.offsetToLine(text.length))
      var end = start
      while end < text.length && text(end) != '\n' && text(end) != '\r' do end += 1
      SourcePosition(src, Span(start + ((character max 0) min (end - start))))
    }

  private def unitCtx(uri: String): Context = {
    val c = current.fresh
    units.get(uri).foreach(c.setCompilationUnit)
    c
  }

  private def allTrees: List[SourceTree] = trees.values.flatten.toList

  /** Completion items at a position: label, detail (the member's type) and an
   *  LSP CompletionItemKind. */
  @JSExport def completion(uri: String, line: Int, character: Int): js.Array[js.Object] = {
    val out = js.Array[js.Object]()
    for (pos <- position(uri, line, character)) {
      given Context = unitCtx(uri)
      val (_, items) = Completion.completions(pos)
      items.foreach { c =>
        // sortText orders; label and filterText (= label) are left as the
        // compiler gives them, so typing still filters on the real name.
        out.push(js.Dynamic.literal(label = c.label, detail = c.description, kind = kindOf(c.symbols),
          sortText = rank(c.label, c.symbols).toString + c.label))
      }
    }
    out
  }

  /** Where a completion sorts, the way Metals ranks members:
   *   0. what the receiver's own class and its user-defined (or library,
   *      e.g. List's) supertypes declare: `norm`, `x`, `copy`, `map`;
   *   1. what every value or every case class has: members of Any, AnyRef /
   *      Object, Product, Equals, Serializable, Predef (`toString`,
   *      `equals`, `productArity`, `canEqual`, ...), including the copies a
   *      case class synthesizes for itself (they are Synthetic but owned by
   *      the class, which is why the owner alone once ranked `canEqual` and
   *      `_1` with `norm`);
   *   2. symbolic names and plumbing: `==`, `##`, `->`, `_1`,
   *      `asInstanceOf`, `isInstanceOf`, `synchronized`, `ensuring`, ...
   *  Within a rank, the label decides. In the IDE this once listed
   *  `!=`, `##`, `->`, `==`, `_1` before `norm`, which is the bug this fixes. */
  private def rank(label: String, syms: List[Symbol])(using Context): Int = {
    val sym = syms.headOption.getOrElse(NoSymbol)
    val owner = if (sym.exists) sym.owner.fullName.toString else ""
    val symbolic = label.nonEmpty && !Character.isLetter(label.charAt(0)) && label.charAt(0) != '_' && label.charAt(0) != '$'
    if (symbolic || label.matches("_[0-9]+") || plumbing(label) || owner.startsWith("scala.Predef.")) 2
    else if (universalOwners(owner) || (sym.exists && sym.is(Flags.Synthetic) && universalNames(label))) 1
    else 0
  }

  private val universalOwners = Set("scala.Any", "scala.AnyRef", "java.lang.Object", "scala.Product", "scala.Equals",
    "scala.Serializable", "java.io.Serializable", "scala.Predef", "scala.runtime.stdLibPatches.Predef")
  /** What a case class synthesizes for itself that Product, Equals or Any declare. */
  private val universalNames = Set("productArity", "productElement", "productElementName", "productElementNames",
    "productIterator", "productPrefix", "canEqual", "equals", "hashCode", "toString")
  /** Members of every value that are rarely what one is looking for. */
  private val plumbing = Set("asInstanceOf", "isInstanceOf", "$asInstanceOf$", "$isInstanceOf$", "synchronized",
    "wait", "notify", "notifyAll", "getClass", "ne", "eq", "ensuring", "formatted", "nn", "runtimeChecked", "clone", "finalize")

  private def kindOf(syms: List[Symbol])(using Context): Int = syms.headOption match {
    case None => 1
    case Some(s) =>
      if (s.is(Flags.Package)) 9
      else if (s.is(Flags.Module)) 9
      else if (s.isClass && s.is(Flags.Trait)) 8
      else if (s.isClass) 7
      else if (s.isType) 25
      else if (s.is(Flags.Method)) { if (s.isConstructor) 4 else if (s.owner.isClass) 2 else 3 }
      else if (s.is(Flags.Mutable)) 6
      else if (s.owner.isClass) 5
      else 6
  }

  /** Markdown hover: the declaration (or the expression's type) and the
   *  symbol's Scaladoc. */
  @JSExport def hover(uri: String, line: Int, character: Int): js.Object | Null = {
    position(uri, line, character).flatMap { pos =>
      given Context = unitCtx(uri)
      val ts = trees.getOrElse(uri, Nil)
      val path = Interactive.pathTo(ts, pos)
      val tp = Interactive.enclosingType(ts, pos)
      val tpw = tp.widenTermRefExpr
      if (tp.isError || tpw == NoType) None
      else {
        val sym = Interactive.enclosingSourceSymbols(path, pos).headOption.getOrElse(NoSymbol)
        val shown = if (sym.exists) sym.showDcl else tpw.show
        val doc = if (sym.exists) ParsedComment.docOf(sym).map(_.renderAsMarkdown) else None
        val value = "```scala\n" + shown + "\n```" + doc.fold("")("\n\n" + _)
        Some(js.Dynamic.literal(contents = js.Dynamic.literal(kind = "markdown", value = value)))
      }
    }.orNull
  }

  private def locations(uri: String, line: Int, character: Int, include: Include.Set): js.Array[js.Object] = {
    val out = js.Array[js.Object]()
    for (pos <- position(uri, line, character)) {
      given Context = unitCtx(uri)
      val path = Interactive.pathTo(trees.getOrElse(uri, Nil), pos)
      val syms = Interactive.enclosingSourceSymbols(path, pos)
      val seen = mutable.Set.empty[(String, Int, Int)]
      for (sym <- syms; t <- Interactive.namedTrees(allTrees, include, sym)) {
        val np = t.namePos
        for (u <- uriOfSource(np.source) if np.exists && seen.add((u, np.start, np.end)))
          out.push(js.Dynamic.literal(uri = u, range = rangeOf(np)))
      }
    }
    out
  }

  /** What renaming the symbol at a position touches, for the server's
   *  rename: `{ declared, locations }`, or null when there is no symbol.
   *  `declared` is whether the project declares it (a library symbol must
   *  not be renamed). A class, its companion object and a case class's
   *  synthetic `apply` are one name in the source, so they rename together:
   *  `Point(3, 4)` refers to the companion's `apply`, not to the class. */
  @JSExport def renameTarget(uri: String, line: Int, character: Int): js.Object | Null = {
    position(uri, line, character).flatMap { pos =>
      given Context = unitCtx(uri)
      val path = Interactive.pathTo(trees.getOrElse(uri, Nil), pos)
      val found = Interactive.enclosingSourceSymbols(path, pos).filter(_.exists)
      if (found.isEmpty) None
      else {
        def owners(sym: Symbol): List[Symbol] =
          if (sym.is(Flags.Synthetic) && (sym.name.toString == "apply" || sym.name.toString == "unapply") && sym.owner.is(Flags.ModuleClass))
            List(sym.owner)
          else List(sym)
        val roots = found.flatMap(owners)
        val syms = roots.flatMap { sym =>
          if (sym.isClass || sym.is(Flags.Module))
            List(sym, sym.companionClass, sym.companionModule, sym.moduleClass, sym.sourceModule, sym.linkedClass)
          else List(sym)
        }.filter(_.exists).distinct
        // Not Interactive.namedTrees: it skips trees whose symbol is synthetic,
        // and a companion object is, so `Point(3, 4)` (an Ident of the
        // synthetic module val) would keep its old name.
        val wanted = syms.toSet
        val out = js.Array[js.Object]()
        val seen = mutable.Set.empty[(String, Int, Int)]
        var declared = false
        for (st <- allTrees) new tpd.TreeTraverser {
          def traverse(tree: tpd.Tree)(using Context): Unit = {
            tree match {
              case t: tpd.NameTree if wanted.contains(t.symbol) && t.span.exists && !t.span.isSynthetic =>
                val np = SourceTree(t, st.source).namePos
                if (np.exists && !np.span.isZeroExtent) {
                  if (t.isInstanceOf[tpd.MemberDef]) declared = true
                  for (u <- uriOfSource(np.source) if seen.add((u, np.start, np.end)))
                    out.push(js.Dynamic.literal(uri = u, range = rangeOf(np)))
                }
              case _ =>
            }
            traverseChildren(tree)
          }
        }.traverse(st.tree)
        Some(js.Dynamic.literal(declared = declared, locations = out))
      }
    }.orNull
  }

  @JSExport def definition(uri: String, line: Int, character: Int): js.Array[js.Object] =
    locations(uri, line, character, Include.definitions | Include.linkedClass)

  @JSExport def references(uri: String, line: Int, character: Int, includeDeclaration: Boolean): js.Array[js.Object] =
    // Include.local: without it namedTrees does not look inside method bodies.
    locations(uri, line, character,
      if (includeDeclaration) Include.references | Include.definitions | Include.local else Include.references | Include.local)

  @JSExport def highlight(uri: String, line: Int, character: Int): js.Array[js.Object] = {
    val out = js.Array[js.Object]()
    locations(uri, line, character, Include.references | Include.definitions | Include.local).foreach { l =>
      if (l.asInstanceOf[js.Dynamic].uri.asInstanceOf[String] == uri)
        out.push(js.Dynamic.literal(range = l.asInstanceOf[js.Dynamic].range, kind = 1))
    }
    out
  }

  /** Document symbols, nested: classes, objects, traits, defs, vals. */
  @JSExport def symbols(uri: String): js.Array[js.Object] = {
    given Context = unitCtx(uri)
    def go(tree: tpd.Tree): js.Array[js.Object] = {
      val out = js.Array[js.Object]()
      tree match {
        case tpd.PackageDef(_, stats) => stats.foreach(s => go(s).foreach(out.push(_)))
        case t: tpd.MemberDef if t.symbol.exists && !t.symbol.is(Flags.Synthetic) && t.span.exists && !t.span.isSynthetic &&
            !(t.symbol.is(Flags.Module) && !t.symbol.isClass) && !t.symbol.isConstructor =>
          val sym = t.symbol
          val children = t match {
            case td: tpd.TypeDef => td.rhs match {
              case tmpl: tpd.Template => tmpl.body.flatMap(b => go(b).toList)
              case _ => Nil
            }
            case _ => Nil
          }
          val name = if (sym.is(Flags.Module)) sym.name.stripModuleClassSuffix.show else sym.name.show
          val src = ctx.compilationUnit.source
          val full = SourcePosition(src, t.span)
          val sel = SourcePosition(src, t.nameSpan)
          out.push(js.Dynamic.literal(name = name, kind = kindOf(List(sym)), detail = if (sym.isTerm) sym.info.widenTermRefExpr.show else "",
            range = rangeOf(full), selectionRange = rangeOf(if (sel.exists) sel else full), children = js.Array(children*)))
        case _ =>
      }
      out
    }
    units.get(uri).map(u => go(u.tpdTree)).getOrElse(js.Array())
  }

  /** Signature help for the call around a position. */
  @JSExport def signatureHelp(uri: String, line: Int, character: Int): js.Object | Null = {
    position(uri, line, character).flatMap { pos =>
      given Context = unitCtx(uri)
      val path = Interactive.pathTo(trees.getOrElse(uri, Nil), pos)
      val (paramN, callableN, sigs) = Signatures.signatureHelp(path, pos.span)
      if (sigs.isEmpty) None
      else Some(js.Dynamic.literal(
        activeSignature = callableN, activeParameter = paramN,
        signatures = js.Array(sigs.map { s =>
          val tparams = s.paramss.flatten.collect { case p: Signatures.TypeParam => p.show }
          val params = s.paramss.flatten.collect { case p: Signatures.MethodParam => p.show }
          val label = s.name + (if (tparams.isEmpty) "" else tparams.mkString("[", ", ", "]")) + params.mkString("(", ", ", ")") + s.returnType.fold("")(": " + _)
          js.Dynamic.literal(label = label, documentation = s.doc.getOrElse(""),
            parameters = js.Array(params.map(p => js.Dynamic.literal(label = p))*))
        }*)))
    }.orNull
  }

  private def topLevelTrees(topTree: tpd.Tree, source: SourceFile): List[SourceTree] = {
    val buf = mutable.ListBuffer.empty[SourceTree]
    def add(tree: tpd.Tree): Unit = tree match {
      case tpd.PackageDef(_, stats) => stats.foreach(add)
      case imp: tpd.Import => buf += SourceTree(imp, source)
      case t: tpd.TypeDef => buf += SourceTree(t, source)
      case _ =>
    }
    add(topTree)
    buf.toList
  }

  /** As upstream InteractiveDriver.cleanup: drop attachments and error out
   *  completers so a tree does not keep an old run's context alive. */
  private def cleanup(tree: tpd.Tree)(using Context): Unit = {
    val seen = mutable.Set.empty[tpd.Tree]
    def cleanupTree(tree: tpd.Tree): Unit = {
      seen += tree
      tree.foreachSubTree { t =>
        if (t.symbol.exists && t.hasType) {
          if (!t.symbol.isCompleted) t.symbol.info = UnspecifiedErrorType
          t.symbol.annotations.foreach { annot =>
            if (annot.isEvaluated && !seen(annot.tree)) cleanupTree(annot.tree)
          }
        }
        t.removeAllAttachments()
      }
    }
    cleanupTree(tree)
  }
}
