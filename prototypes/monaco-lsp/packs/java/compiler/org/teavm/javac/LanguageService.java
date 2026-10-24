/*
 * Yukibana Java pack: javac's own analysis behind the language server.
 *
 * The same javac that teavm-javac compiles to WebAssembly (OpenJDK 25's
 * jdk.compiler) parses, enters, attributes and flow-analyses every open
 * .java file of the project together, and the answers come from its
 * attributed trees and symbols: diagnostics are javac's, a member list is
 * the members javac's Elements give for the type javac attributed, hover is
 * the symbol javac resolved, definition and references are tree positions
 * of the same symbol. Nothing here re-implements Java's rules.
 *
 * Every analysis uses a fresh javac Context (javac's contexts cannot be
 * reused for another compilation); the class library archive is decoded
 * once and its class files are shared between contexts.
 *
 * Positions are char offsets into the file text (javac's positions), which
 * are UTF-16 code unit offsets, as LSP's are; server.js turns them into
 * lines and characters. Every answer is a JSON string.
 */
package org.teavm.javac;

import com.sun.tools.javac.code.Flags;
import com.sun.tools.javac.code.Kinds;
import com.sun.tools.javac.code.Symbol;
import com.sun.tools.javac.code.Symbol.ClassSymbol;
import com.sun.tools.javac.code.Symbol.MethodSymbol;
import com.sun.tools.javac.code.Symbol.PackageSymbol;
import com.sun.tools.javac.code.Symbol.VarSymbol;
import com.sun.tools.javac.code.Symtab;
import com.sun.tools.javac.code.Type;
import com.sun.tools.javac.code.TypeTag;
import com.sun.tools.javac.code.Types;
import com.sun.tools.javac.main.JavaCompiler;
import com.sun.tools.javac.model.JavacElements;
import com.sun.tools.javac.tree.JCTree;
import com.sun.tools.javac.tree.JCTree.JCBlock;
import com.sun.tools.javac.tree.JCTree.JCCatch;
import com.sun.tools.javac.tree.JCTree.JCClassDecl;
import com.sun.tools.javac.tree.JCTree.JCCompilationUnit;
import com.sun.tools.javac.tree.JCTree.JCEnhancedForLoop;
import com.sun.tools.javac.tree.JCTree.JCFieldAccess;
import com.sun.tools.javac.tree.JCTree.JCForLoop;
import com.sun.tools.javac.tree.JCTree.JCIdent;
import com.sun.tools.javac.tree.JCTree.JCImport;
import com.sun.tools.javac.tree.JCTree.JCLambda;
import com.sun.tools.javac.tree.JCTree.JCMemberReference;
import com.sun.tools.javac.tree.JCTree.JCMethodDecl;
import com.sun.tools.javac.tree.JCTree.JCMethodInvocation;
import com.sun.tools.javac.tree.JCTree.JCNewClass;
import com.sun.tools.javac.tree.JCTree.JCTry;
import com.sun.tools.javac.tree.JCTree.JCTypeParameter;
import com.sun.tools.javac.tree.JCTree.JCVariableDecl;
import com.sun.tools.javac.tree.TreeInfo;
import com.sun.tools.javac.tree.TreeScanner;
import com.sun.tools.javac.tree.JCTree.JCErroneous;
import com.sun.tools.javac.util.Context;
import com.sun.tools.javac.util.Names;
import com.sun.tools.javac.util.Options;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.zip.ZipInputStream;
import javax.lang.model.element.TypeElement;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticListener;
import javax.tools.JavaFileManager;
import javax.tools.JavaFileObject;
import org.teavm.jso.JSClass;
import org.teavm.jso.JSExport;
import org.teavm.jso.typedarrays.Int8Array;

@JSClass(name = "LanguageService")
public final class LanguageService {
    private final Map<String, FileData> sources = new LinkedHashMap<>();
    private final Map<String, FileData> classFiles = new LinkedHashMap<>();
    private final Map<String, FileData> sdkFiles = new LinkedHashMap<>();
    /** Package name -> simple names of the top-level classes the class path has in it. */
    private final Map<String, TreeSet<String>> libraryClasses = new TreeMap<>();
    private Analysis analysis;
    static final boolean DEBUG = false;

    LanguageService() {
    }

    // ---- Files

    /** The class library javac compiles against (teavm-javac's compile-classlib archive). */
    @JSExport
    public void setSdk(Int8Array content) throws IOException {
        try (var input = new ArchiveReader(new ByteArrayInputStream(content.copyToJavaArray()))) {
            while (true) {
                var entry = input.readNext();
                if (entry == null) {
                    break;
                }
                var file = new FileData(sdkFiles);
                file.path = entry;
                file.data = input.readData();
                file.isJavaBase = true;
                sdkFiles.put(entry, file);
                indexLibraryClass(entry);
            }
        }
        analysis = null;
    }

    /** A jar on the class path (the JUnit Jupiter API). */
    @JSExport
    public void addJar(Int8Array content) throws IOException {
        try (var input = new ZipInputStream(new ByteArrayInputStream(content.copyToJavaArray()))) {
            while (true) {
                var entry = input.getNextEntry();
                if (entry == null) {
                    break;
                }
                if (entry.isDirectory()) {
                    continue;
                }
                var file = new FileData(classFiles);
                file.path = entry.getName();
                file.data = input.readAllBytes();
                classFiles.put(file.path, file);
                indexLibraryClass(file.path);
            }
        }
        analysis = null;
    }

    private void indexLibraryClass(String path) {
        if (!path.endsWith(".class") || path.indexOf('$') >= 0 || path.endsWith("module-info.class")
                || path.endsWith("package-info.class")) {
            return;
        }
        int slash = path.lastIndexOf('/');
        var pkg = slash < 0 ? "" : path.substring(0, slash).replace('/', '.');
        var name = path.substring(slash + 1, path.length() - ".class".length());
        libraryClasses.computeIfAbsent(pkg, k -> new TreeSet<>()).add(name);
    }

    @JSExport
    public void setFile(String path, String text) {
        var file = new FileData(sources);
        file.path = path;
        file.data = text.getBytes(StandardCharsets.UTF_8);
        file.lastModified = System.currentTimeMillis();
        sources.put(path, file);
        analysis = null;
    }

    @JSExport
    public void removeFile(String path) {
        if (sources.remove(path) != null) {
            analysis = null;
        }
    }

    private Analysis analysis() {
        if (analysis == null) {
            analysis = new Analysis();
            analysis.run();
        }
        return analysis;
    }

    // ---- Diagnostics

    /**
     * javac's diagnostics for every file: {path: [{start, end, severity,
     * message, code}]}, with an entry (maybe empty) for each file.
     */
    @JSExport
    public String check() {
        var a = analysis();
        var byFile = new LinkedHashMap<String, List<Diagnostic<? extends JavaFileObject>>>();
        for (var path : sources.keySet()) {
            byFile.put(path, new ArrayList<>());
        }
        for (var d : a.diagnostics) {
            if (d.getKind() == Diagnostic.Kind.NOTE || d.getSource() == null) {
                continue;
            }
            var list = byFile.get(d.getSource().getName());
            if (list != null) {
                list.add(d);
            }
        }
        var json = new Json().beginObject();
        for (var e : byFile.entrySet()) {
            json.key(e.getKey()).beginArray();
            for (var d : e.getValue()) {
                int start = (int) d.getStartPosition();
                int end = (int) d.getEndPosition();
                if (start < 0) {
                    start = (int) d.getPosition();
                }
                json.beginObject()
                        .field("start", start)
                        .field("end", end)
                        .field("severity", d.getKind() == Diagnostic.Kind.ERROR ? "error" : "warning")
                        .field("message", d.getMessage(Locale.ENGLISH))
                        .field("code", d.getCode())
                        .endObject();
            }
            json.endArray();
        }
        return json.endObject().toString();
    }

    // ---- Hover, definition, references

    @JSExport
    public String hover(String path, int offset) {
        var a = analysis();
        var occ = a.occurrenceAt(path, offset);
        if (occ == null) {
            return "null";
        }
        var sym = occ.sym;
        var sb = new StringBuilder("```java\n").append(a.describe(sym)).append("\n```");
        var doc = a.docComment(sym);
        if (doc != null && !doc.isBlank()) {
            sb.append("\n\n").append(javadocToMarkdown(doc));
        }
        var origin = a.origin(sym);
        if (origin != null) {
            sb.append("\n\n*").append(origin).append('*');
        }
        return new Json().beginObject()
                .field("contents", sb.toString())
                .field("start", occ.start)
                .field("end", occ.end)
                .endObject().toString();
    }

    @JSExport
    public String definition(String path, int offset) {
        var a = analysis();
        var occ = a.occurrenceAt(path, offset);
        if (occ == null) {
            return "[]";
        }
        var json = new Json().beginArray();
        for (var d : a.declarations(occ.sym)) {
            d.write(json);
        }
        return json.endArray().toString();
    }

    /**
     * Every occurrence of the symbol at the position, project-wide:
     * {name, declared, locations: [{path, start, end, decl}]}; null when
     * there is no symbol there. `declared` says whether the symbol is
     * declared in the project (so it may be renamed).
     */
    @JSExport
    public String references(String path, int offset) {
        var a = analysis();
        var occ = a.occurrenceAt(path, offset);
        if (occ == null) {
            return "null";
        }
        var target = a.referenceTarget(occ.sym);
        var related = a.related(target);
        var json = new Json().beginObject()
                .field("name", target.isConstructor() ? target.owner.name.toString() : target.name.toString())
                .field("declared", !a.declarations(target).isEmpty())
                .field("kind", target.kind == Kinds.Kind.TYP && target.owner.kind == Kinds.Kind.PCK
                        && (target.flags() & Flags.PUBLIC) != 0 ? "publicTopLevelClass" : "other");
        json.key("locations").beginArray();
        for (var list : a.occurrences.values()) {
            for (var o : list) {
                if (related.contains(o.sym)) {
                    o.write(json);
                }
            }
        }
        json.endArray();
        return json.endObject().toString();
    }

    // ---- Document symbols

    @JSExport
    public String symbols(String path) {
        var a = analysis();
        var unit = a.units.get(path);
        var json = new Json().beginArray();
        if (unit != null) {
            for (var def : unit.defs) {
                a.symbol(unit, def, json);
            }
        }
        return json.endArray().toString();
    }

    // ---- Completion

    /**
     * Completion at the position: {start, items: [{label, kind, detail,
     * sort, insert?, importText?}]}, where `start` is where the word being
     * completed begins.
     */
    @JSExport
    public String complete(String path, int offset) {
        var a = analysis();
        var unit = a.units.get(path);
        var text = a.text(path);
        if (unit == null || text == null) {
            return "null";
        }
        offset = Math.min(offset, text.length());
        int start = offset;
        while (start > 0 && Character.isJavaIdentifierPart(text.charAt(start - 1))) {
            start--;
        }
        var prefix = text.substring(start, offset);
        int before = start - 1;
        while (before >= 0 && Character.isWhitespace(text.charAt(before))) {
            before--;
        }
        var items = new Items(prefix);
        if (before >= 0 && text.charAt(before) == '.' && (before == 0 || text.charAt(before - 1) != '.')) {
            a.completeMember(unit, text, before, items);
        } else if (before >= 1 && text.charAt(before) == ':' && text.charAt(before - 1) == ':') {
            a.completeMember(unit, text, before - 1, items);
        } else if (isCaseLabel(text, before) && a.completeCaseLabel(unit, text, offset, items)) {
            // An enum's constants, unqualified: nothing else may follow `case` there.
        } else {
            a.completeScope(unit, text, offset, items);
        }
        var json = new Json().beginObject().field("start", start);
        json.key("items").beginArray();
        for (var item : items.list.values()) {
            item.write(json);
        }
        json.endArray();
        return json.endObject().toString();
    }

    /**
     * Whether the word being completed is a case label: `case` before it,
     * maybe with labels already listed (`case RED, GR`). `before` is the
     * last non-blank character before the word.
     */
    static boolean isCaseLabel(String text, int before) {
        int at = before;
        while (at >= 0 && text.charAt(at) == ',') {
            at--;
            while (at >= 0 && Character.isWhitespace(text.charAt(at))) {
                at--;
            }
            while (at >= 0 && (Character.isJavaIdentifierPart(text.charAt(at)) || text.charAt(at) == '.')) {
                at--;
            }
            while (at >= 0 && Character.isWhitespace(text.charAt(at))) {
                at--;
            }
        }
        int end = at + 1;
        while (at >= 0 && Character.isJavaIdentifierPart(text.charAt(at))) {
            at--;
        }
        return text.substring(at + 1, end).equals("case");
    }

    // ---- Code actions

    /**
     * The classes a simple name could be imported as, for the quick fix on
     * `cannot find symbol`: {at, classes: [qualified name]}, where `at` is
     * where the import goes (as Item.importText's offset). The project's
     * classes in other packages first, then the class library's, from the
     * packages auto-import offers.
     */
    @JSExport
    public String importsFor(String path, String name) {
        var a = analysis();
        var unit = a.units.get(path);
        if (unit == null) {
            return "null";
        }
        var pkg = unit.packge != null ? unit.packge.fullname.toString() : "";
        var classes = new java.util.LinkedHashSet<String>();
        for (var u : a.units.values()) {
            var upkg = u.packge != null ? u.packge.fullname.toString() : "";
            // A class in the unnamed package cannot be imported at all.
            if (upkg.isEmpty() || upkg.equals(pkg)) {
                continue;
            }
            for (var def : u.defs) {
                if (def instanceof JCClassDecl c && c.name.contentEquals(name)) {
                    classes.add(upkg + "." + name);
                }
            }
        }
        for (var e : libraryClasses.entrySet()) {
            if (Analysis.importable(e.getKey(), pkg) && e.getValue().contains(name)) {
                classes.add(e.getKey() + "." + name);
            }
        }
        var importAt = a.importText(unit);
        var json = new Json().beginObject().field("at", Integer.parseInt(importAt.substring(0, importAt.length() - 1)));
        json.key("classes").beginArray();
        for (var c : classes) {
            json.value(c);
        }
        json.endArray();
        return json.endObject().toString();
    }

    // ---- Type definition

    /**
     * Where the type of the symbol at the position is declared: a
     * variable's or field's type, a method's return type, a class itself;
     * an array's element type. [{path, start, end}]; empty for a type of
     * the class library, which has no source here.
     */
    @JSExport
    public String typeDefinition(String path, int offset) {
        var a = analysis();
        var occ = a.occurrenceAt(path, offset);
        var json = new Json().beginArray();
        if (occ == null) {
            return json.endArray().toString();
        }
        var sym = occ.sym;
        Type t = sym.isConstructor() ? sym.owner.type
                : sym instanceof MethodSymbol m ? m.getReturnType() : sym.type;
        while (t != null && t.hasTag(TypeTag.ARRAY)) {
            t = ((Type.ArrayType) t).elemtype;
        }
        if (t != null && t.tsym != null) {
            for (var d : a.declarations(t.tsym)) {
                d.write(json);
            }
        }
        return json.endArray().toString();
    }

    // ---- Signature help

    @JSExport
    public String signatureHelp(String path, int offset) {
        var a = analysis();
        var unit = a.units.get(path);
        var text = a.text(path);
        if (unit == null || text == null) {
            return "null";
        }
        return a.signatureHelp(unit, text, offset);
    }

    /** One completion item; items are keyed by label + detail, so overloads stay apart and duplicates go. */
    static final class Item {
        String label;
        int kind;
        String detail;
        String sort;
        String insert;
        String importText;

        void write(Json json) {
            json.beginObject().field("label", label).field("kind", kind);
            if (detail != null) {
                json.field("detail", detail);
            }
            json.field("sort", sort);
            if (insert != null) {
                json.field("insert", insert);
            }
            if (importText != null) {
                json.field("importText", importText);
            }
            json.endObject();
        }
    }

    static final class Items {
        final String prefix;
        final Map<String, Item> list = new LinkedHashMap<>();

        Items(String prefix) {
            this.prefix = prefix;
        }

        /** Whether a name could complete the prefix (its first letter, either case: the editor filters the rest). */
        boolean wants(String name) {
            if (name.isEmpty() || name.startsWith("<") || name.indexOf('$') >= 0) {
                return false;
            }
            return prefix.isEmpty() || Character.toLowerCase(name.charAt(0)) == Character.toLowerCase(prefix.charAt(0));
        }

        Item add(String label, int kind, String detail, String sort) {
            var key = label + "\u0000" + (detail == null ? "" : detail);
            var item = list.get(key);
            if (item == null) {
                item = new Item();
                item.label = label;
                item.kind = kind;
                item.detail = detail;
                item.sort = sort + label;
                list.put(key, item);
            }
            return item;
        }
    }

    // LSP CompletionItemKind
    static final int K_METHOD = 2;
    static final int K_CONSTRUCTOR = 4;
    static final int K_FIELD = 5;
    static final int K_VARIABLE = 6;
    static final int K_CLASS = 7;
    static final int K_INTERFACE = 8;
    static final int K_MODULE = 9;
    static final int K_KEYWORD = 14;
    static final int K_ENUM = 13;
    static final int K_ENUM_MEMBER = 20;
    static final int K_CONSTANT = 21;
    static final int K_STRUCT = 22;
    static final int K_TYPE_PARAMETER = 25;

    static final String[] KEYWORDS = {
        "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "continue",
        "default", "do", "double", "else", "enum", "extends", "final", "finally", "float", "for", "if",
        "implements", "import", "instanceof", "int", "interface", "long", "new", "null", "package", "private",
        "protected", "public", "record", "return", "short", "static", "super", "switch", "synchronized",
        "this", "throw", "throws", "true", "false", "try", "var", "void", "while", "yield"
    };

    // ---- One compilation and what it found

    /** An occurrence of a symbol's name in a file. */
    static final class Occurrence {
        final String path;
        final int start;
        final int end;
        final Symbol sym;
        final boolean decl;
        final JCTree tree;

        Occurrence(String path, int start, int end, Symbol sym, boolean decl, JCTree tree) {
            this.path = path;
            this.start = start;
            this.end = end;
            this.sym = sym;
            this.decl = decl;
            this.tree = tree;
        }

        void write(Json json) {
            json.beginObject().field("path", path).field("start", start).field("end", end).field("decl", decl)
                    .endObject();
        }
    }

    private final class Analysis {
        final List<Diagnostic<? extends JavaFileObject>> diagnostics = new ArrayList<>();
        final Map<String, JCCompilationUnit> units = new LinkedHashMap<>();
        final Map<String, List<Occurrence>> occurrences = new LinkedHashMap<>();
        final Map<Symbol, List<Occurrence>> declarations = new IdentityHashMap<>();
        final Map<Symbol, JCTree> declTrees = new IdentityHashMap<>();
        final Map<Symbol, JCCompilationUnit> declUnits = new IdentityHashMap<>();
        Context context;
        Names names;
        Types types;
        Symtab syms;
        JavacElements elements;

        void run() {
            context = new Context();
            context.put(DiagnosticListener.class, (DiagnosticListener<JavaFileObject>) diagnostics::add);
            var options = Options.instance(context);
            // Attribute (and flow-analyse) everything even when a file has a
            // syntax error: an IDE checks the rest, and completion on an
            // unfinished `p.` needs the attributed type of `p`.
            options.put("should-stop.ifError", "FLOW");
            var fileManager = new FileManagerImpl(new LinkedHashMap<>(), classFiles, sdkFiles,
                    new LinkedHashMap<>());
            context.put(JavaFileManager.class, fileManager);
            var compiler = new AnalysisCompiler(context);
            compiler.genEndPos = true;
            compiler.keepComments = true;
            compiler.prepare();
            names = Names.instance(context);
            types = Types.instance(context);
            syms = Symtab.instance(context);
            elements = JavacElements.instance(context);
            var files = new ArrayList<JavaFileObject>(sources.values());
            try {
                var parsed = compiler.parseFiles(files);
                var roots = compiler.initModules(parsed);
                compiler.enterTrees(roots);
                compiler.flow(compiler.attribute(compiler.todo));
                for (var unit : roots) {
                    units.put(((FileData) unit.sourcefile).path, unit);
                }
            } catch (RuntimeException e) {
                // A javac crash on half-typed code must not take the server
                // down: what was parsed before it still answers.
                System.err.println("javac: " + e);
            }
            for (var e : units.entrySet()) {
                var list = new ArrayList<Occurrence>();
                new Collector(this, e.getKey(), e.getValue(), text(e.getKey()), list).scan(e.getValue());
                occurrences.put(e.getKey(), list);
            }
        }

        String text(String path) {
            var file = sources.get(path);
            return file == null ? null : new String(file.data, StandardCharsets.UTF_8);
        }

        Occurrence occurrenceAt(String path, int offset) {
            var list = occurrences.get(path);
            if (list == null) {
                return null;
            }
            Occurrence best = null;
            for (var o : list) {
                if (o.start <= offset && offset <= o.end && (best == null || o.end - o.start < best.end - best.start)) {
                    best = o;
                }
            }
            return best;
        }

        List<Occurrence> declarations(Symbol sym) {
            var list = declarations.get(sym);
            if (list == null && sym instanceof MethodSymbol m && m.owner instanceof ClassSymbol c
                    && (c.flags() & Flags.RECORD) != 0 && m.params().isEmpty()) {
                // A record's accessor is generated: its declaration is the component's.
                for (var member : c.members().getSymbolsByName(m.name)) {
                    if (member instanceof VarSymbol) {
                        list = declarations.get(member);
                    }
                }
            }
            return list == null ? List.of() : list;
        }

        /** What references and rename are about: a constructor's are its class's. */
        Symbol referenceTarget(Symbol sym) {
            if (sym.isConstructor()) {
                return sym.owner;
            }
            return sym;
        }

        /** The symbol and the symbols that share its name in source: a class and its constructors, a record component and its accessor. */
        Set<Symbol> related(Symbol sym) {
            Set<Symbol> set = java.util.Collections.newSetFromMap(new IdentityHashMap<>());
            set.add(sym);
            if (sym instanceof ClassSymbol c) {
                for (var m : c.members().getSymbolsByName(names.init)) {
                    set.add(m);
                }
            }
            if (sym.owner instanceof ClassSymbol c && (c.flags() & Flags.RECORD) != 0) {
                for (var m : c.members().getSymbolsByName(sym.name)) {
                    if (m instanceof VarSymbol || (m instanceof MethodSymbol ms && ms.params().isEmpty())) {
                        set.add(m);
                    }
                }
            }
            return set;
        }

        boolean fromSource(Symbol sym) {
            var outer = sym.outermostClass();
            return outer != null && outer.sourcefile instanceof FileData f && sources.containsKey(f.path);
        }

        String origin(Symbol sym) {
            if (sym.kind == Kinds.Kind.PCK || fromSource(sym)) {
                return null;
            }
            var outer = sym.outermostClass();
            if (outer == null) {
                return null;
            }
            var pkg = outer.packge().fullname.toString();
            return pkg.startsWith("org.junit") || pkg.startsWith("org.opentest4j") ? "JUnit Jupiter API"
                    : "Java class library (as TeaVM implements it): " + outer.getQualifiedName();
        }

        String docComment(Symbol sym) {
            var tree = declTrees.get(sym);
            var unit = declUnits.get(sym);
            if (tree == null && sym instanceof MethodSymbol) {
                var decls = declarations(sym);
                if (!decls.isEmpty()) {
                    tree = decls.get(0).tree;
                    unit = units.get(decls.get(0).path);
                }
            }
            if (tree == null || unit == null || unit.docComments == null) {
                return null;
            }
            return unit.docComments.getCommentText(tree);
        }

        // ---- Describing symbols

        String type(Type t) {
            if (t == null) {
                return "?";
            }
            switch (t.getTag()) {
                case CLASS: {
                    var sb = new StringBuilder();
                    var enclosing = t.getEnclosingType();
                    if (enclosing != null && enclosing.hasTag(TypeTag.CLASS)) {
                        sb.append(type(enclosing)).append('.');
                    } else if (t.tsym.owner != null && t.tsym.owner.kind == Kinds.Kind.TYP) {
                        sb.append(t.tsym.owner.name).append('.');
                    }
                    sb.append(t.tsym.name);
                    var args = t.getTypeArguments();
                    if (!args.isEmpty()) {
                        sb.append('<');
                        for (int i = 0; i < args.size(); i++) {
                            if (i > 0) {
                                sb.append(", ");
                            }
                            sb.append(type(args.get(i)));
                        }
                        sb.append('>');
                    }
                    return sb.toString();
                }
                case ARRAY:
                    return type(((Type.ArrayType) t).elemtype) + "[]";
                case WILDCARD: {
                    var w = (Type.WildcardType) t;
                    return switch (w.kind) {
                        case UNBOUND -> "?";
                        case EXTENDS -> "? extends " + type(w.type);
                        case SUPER -> "? super " + type(w.type);
                    };
                }
                case TYPEVAR:
                    return t.tsym.name.toString();
                case ERROR:
                    return t.tsym != null ? t.tsym.name.toString() : "?";
                default:
                    return t.toString();
            }
        }

        String params(MethodSymbol m, Type mt) {
            var sb = new StringBuilder("(");
            var ps = m.params();
            var argTypes = mt != null ? mt.getParameterTypes() : null;
            for (int i = 0; i < ps.size(); i++) {
                if (i > 0) {
                    sb.append(", ");
                }
                var pt = argTypes != null && i < argTypes.size() ? argTypes.get(i) : ps.get(i).type;
                if ((m.flags() & Flags.VARARGS) != 0 && i == ps.size() - 1 && pt.hasTag(TypeTag.ARRAY)) {
                    sb.append(type(((Type.ArrayType) pt).elemtype)).append("...");
                } else {
                    sb.append(type(pt));
                }
                if (!isPlaceholder(ps.get(i).name.toString())) {
                    sb.append(' ').append(ps.get(i).name);
                }
            }
            return sb.append(')').toString();
        }

        /** The class library is stripped of parameter names: javac then calls them arg0, arg1, ... */
        boolean isPlaceholder(String name) {
            return name.length() > 3 && name.startsWith("arg") && name.substring(3).chars().allMatch(Character::isDigit);
        }

        String typeParams(Symbol s) {
            var tps = s.type != null ? s.type.getTypeArguments() : null;
            if (s instanceof MethodSymbol m && m.type != null) {
                tps = m.type.getTypeArguments();
            }
            if (tps == null || tps.isEmpty()) {
                return "";
            }
            var sb = new StringBuilder("<");
            for (int i = 0; i < tps.size(); i++) {
                if (i > 0) {
                    sb.append(", ");
                }
                sb.append(type(tps.get(i)));
            }
            return sb.append("> ").toString();
        }

        String modifiers(Symbol s) {
            var sb = new StringBuilder();
            long f = s.flags();
            if ((f & Flags.PUBLIC) != 0) {
                sb.append("public ");
            } else if ((f & Flags.PROTECTED) != 0) {
                sb.append("protected ");
            } else if ((f & Flags.PRIVATE) != 0) {
                sb.append("private ");
            }
            if ((f & Flags.STATIC) != 0) {
                sb.append("static ");
            }
            if ((f & Flags.ABSTRACT) != 0 && (f & Flags.INTERFACE) == 0) {
                sb.append("abstract ");
            }
            if ((f & Flags.FINAL) != 0 && (f & (Flags.ENUM | Flags.RECORD)) == 0) {
                sb.append("final ");
            }
            if ((f & Flags.DEFAULT) != 0) {
                sb.append("default ");
            }
            return sb.toString();
        }

        String describe(Symbol s) {
            switch (s.kind) {
                case PCK:
                    return "package " + ((PackageSymbol) s).fullname;
                case TYP: {
                    if (s.type != null && s.type.hasTag(TypeTag.TYPEVAR)) {
                        var bound = s.type.getUpperBound();
                        return "<" + s.name + (bound != null && bound.tsym != syms.objectType.tsym
                                ? " extends " + type(bound) : "") + ">";
                    }
                    long f = s.flags();
                    var c = (ClassSymbol) s;
                    var sb = new StringBuilder(modifiers(s));
                    if ((f & Flags.ANNOTATION) != 0) {
                        sb.append("@interface ");
                    } else if ((f & Flags.INTERFACE) != 0) {
                        sb.append("interface ");
                    } else if ((f & Flags.ENUM) != 0) {
                        sb.append("enum ");
                    } else if ((f & Flags.RECORD) != 0) {
                        sb.append("record ");
                    } else {
                        sb.append("class ");
                    }
                    var pkg = c.packge();
                    if (pkg != null && !pkg.isUnnamed() && c.owner.kind == Kinds.Kind.PCK) {
                        sb.append(pkg.fullname).append('.');
                    }
                    sb.append(type(c.type));
                    if ((f & Flags.RECORD) != 0) {
                        sb.append('(');
                        var first = true;
                        for (var rc : c.getRecordComponents()) {
                            if (!first) {
                                sb.append(", ");
                            }
                            first = false;
                            sb.append(type(rc.type)).append(' ').append(rc.name);
                        }
                        sb.append(')');
                    }
                    var sup = c.getSuperclass();
                    if (sup != null && sup.hasTag(TypeTag.CLASS) && sup.tsym != syms.objectType.tsym
                            && (f & (Flags.ENUM | Flags.RECORD | Flags.INTERFACE)) == 0) {
                        sb.append(" extends ").append(type(sup));
                    }
                    var ifaces = c.getInterfaces();
                    if (!ifaces.isEmpty()) {
                        sb.append((f & Flags.INTERFACE) != 0 ? " extends " : " implements ");
                        for (int i = 0; i < ifaces.size(); i++) {
                            if (i > 0) {
                                sb.append(", ");
                            }
                            sb.append(type(ifaces.get(i)));
                        }
                    }
                    return sb.toString();
                }
                case MTH: {
                    var m = (MethodSymbol) s;
                    var sb = new StringBuilder(modifiers(s)).append(typeParams(s));
                    if (m.isConstructor()) {
                        sb.append(m.owner.name).append(params(m, m.type));
                    } else {
                        sb.append(type(m.getReturnType())).append(' ').append(m.owner.name).append('.')
                                .append(m.name).append(params(m, m.type));
                    }
                    var thrown = m.getThrownTypes();
                    if (!thrown.isEmpty()) {
                        sb.append(" throws ");
                        for (int i = 0; i < thrown.size(); i++) {
                            if (i > 0) {
                                sb.append(", ");
                            }
                            sb.append(type(thrown.get(i)));
                        }
                    }
                    return sb.toString();
                }
                case VAR: {
                    var v = (VarSymbol) s;
                    if ((v.flags() & Flags.ENUM) != 0) {
                        return v.owner.name + "." + v.name;
                    }
                    if (v.owner.kind == Kinds.Kind.TYP) {
                        var sb = new StringBuilder(modifiers(v)).append(type(v.type)).append(' ')
                                .append(v.owner.name).append('.').append(v.name);
                        var constant = v.getConstValue();
                        if (constant != null) {
                            sb.append(" = ").append(constant instanceof String str ? quote(str) : constant);
                        }
                        return sb.toString();
                    }
                    var kind = (v.flags() & Flags.PARAMETER) != 0 ? "parameter" : "local variable";
                    return type(v.type) + " " + v.name + "    // " + kind;
                }
                default:
                    return s.name.toString();
            }
        }

        String quote(String s) {
            return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"";
        }

        // ---- Document symbols

        void symbol(JCCompilationUnit unit, JCTree tree, Json json) {
            var path = ((FileData) unit.sourcefile).path;
            var text = text(path);
            if (tree instanceof JCClassDecl c && c.sym != null && !c.name.isEmpty()) {
                long f = c.sym.flags();
                int kind = (f & Flags.INTERFACE) != 0 ? 11 : (f & Flags.ENUM) != 0 ? 10
                        : (f & Flags.RECORD) != 0 ? 23 : 5;
                int name = Collector.namePos(text, c, c.name.toString());
                symbolHeader(json, c.name.toString(), kind, null, unit, tree, name, c.name.length());
                json.key("children").beginArray();
                for (var def : c.defs) {
                    symbol(unit, def, json);
                }
                json.endArray().endObject();
            } else if (tree instanceof JCMethodDecl m && m.sym != null && !generated(m)) {
                var label = m.sym.isConstructor() ? m.sym.owner.name.toString() : m.name.toString();
                int name = Collector.namePos(text, m, label);
                if (name < 0) {
                    return;
                }
                symbolHeader(json, label, m.sym.isConstructor() ? 9 : 6, params(m.sym, m.sym.type), unit, tree,
                        name, label.length());
                json.endObject();
            } else if (tree instanceof JCVariableDecl v && v.sym != null
                    && (v.mods.flags & Flags.GENERATED_MEMBER) == 0) {
                int name = Collector.namePos(text, v, v.name.toString());
                if (name < 0) {
                    return;
                }
                boolean isEnum = (v.sym.flags() & Flags.ENUM) != 0;
                boolean constant = (v.sym.flags() & (Flags.STATIC | Flags.FINAL)) == (Flags.STATIC | Flags.FINAL);
                symbolHeader(json, v.name.toString(), isEnum ? 22 : constant ? 14 : 8,
                        isEnum ? null : type(v.sym.type), unit, tree, name, v.name.length());
                json.endObject();
            }
        }

        private void symbolHeader(Json json, String name, int kind, String detail, JCCompilationUnit unit,
                JCTree tree, int namePos, int nameLength) {
            int start = TreeInfo.getStartPos(tree);
            int end = TreeInfo.getEndPos(tree, unit.endPositions);
            if (end < namePos + nameLength) {
                end = namePos + nameLength;
            }
            if (start > namePos) {
                start = namePos;
            }
            json.beginObject().field("name", name).field("kind", kind);
            if (detail != null) {
                json.field("detail", detail);
            }
            json.field("start", start).field("end", end).field("nameStart", namePos)
                    .field("nameEnd", namePos + nameLength);
        }

        boolean generated(JCMethodDecl m) {
            return (m.mods.flags & Flags.GENERATED_MEMBER) != 0 || (m.sym.flags() & Flags.GENERATEDCONSTR) != 0;
        }

        // ---- Completion

        /** Completion after `expr.` (or `expr::`), the dot at `dot`. */
        void completeMember(JCCompilationUnit unit, String text, int dot, Items items) {
            // The innermost select or reference whose qualifier ends right
            // before the dot: javac parsed `p.` as p.<error>, and attributed p.
            var finder = new SelectFinder(unit, text, dot);
            finder.scan(unit);
            JCTree qualifier = finder.qualifier;
            if (DEBUG) {
                System.err.println("completeMember: qualifier " + qualifier + " type "
                        + (qualifier != null ? qualifier.type : null) + " sym "
                        + (qualifier != null ? TreeInfo.symbol(qualifier) : null));
            }
            if (qualifier != null) {
                var sym = TreeInfo.symbol(qualifier);
                if (sym != null && sym.kind == Kinds.Kind.PCK) {
                    packageMembers(((PackageSymbol) sym).fullname.toString(), items);
                    return;
                }
                if (sym != null && sym.kind == Kinds.Kind.TYP && TreeInfo.isStaticSelector(qualifier, names)) {
                    staticMembers(sym.type, unit, items);
                    return;
                }
                if (qualifier.type != null && !qualifier.type.isErroneous()) {
                    instanceMembers(qualifier.type, unit, items);
                    return;
                }
            }
            // Not attributed (an import, or code the parser gave up on): a
            // dotted name before the dot may still be a package or a class.
            int begin = dot;
            while (begin > 0 && (Character.isJavaIdentifierPart(text.charAt(begin - 1)) || text.charAt(begin - 1) == '.')) {
                begin--;
            }
            var dotted = text.substring(begin, dot);
            if (dotted.isEmpty()) {
                return;
            }
            if (isPackage(dotted)) {
                packageMembers(dotted, items);
                return;
            }
            var cls = elements.getTypeElement(dotted);
            if (cls == null && dotted.indexOf('.') < 0) {
                // A simple name: a variable in scope or a class the file sees.
                var scope = new Items("");
                completeScope(unit, text, dot, scope);
                for (var e : scopeSymbols.entrySet()) {
                    if (e.getKey().equals(dotted)) {
                        var s = e.getValue();
                        if (s.kind == Kinds.Kind.VAR && s.type != null) {
                            instanceMembers(s.type, unit, items);
                            return;
                        }
                        if (s.kind == Kinds.Kind.TYP) {
                            staticMembers(s.type, unit, items);
                            return;
                        }
                    }
                }
                cls = elements.getTypeElement("java.lang." + dotted);
            }
            if (cls instanceof ClassSymbol c) {
                staticMembers(c.type, unit, items);
            }
        }

        boolean isPackage(String name) {
            var slashed = name.replace('.', '/') + "/";
            for (var path : sdkFiles.keySet()) {
                if (path.startsWith(slashed)) {
                    return true;
                }
            }
            for (var path : classFiles.keySet()) {
                if (path.startsWith(slashed)) {
                    return true;
                }
            }
            for (var unit : units.values()) {
                if (unit.packge != null) {
                    var p = unit.packge.fullname.toString();
                    if (p.equals(name) || p.startsWith(name + ".")) {
                        return true;
                    }
                }
            }
            return false;
        }

        void packageMembers(String pkg, Items items) {
            var classes = libraryClasses.get(pkg);
            if (classes != null) {
                for (var name : classes) {
                    if (items.wants(name)) {
                        items.add(name, K_CLASS, pkg + "." + name, "1");
                    }
                }
            }
            var prefix = pkg + ".";
            var subpackages = new TreeSet<String>();
            for (var p : libraryClasses.keySet()) {
                if (p.startsWith(prefix)) {
                    var rest = p.substring(prefix.length());
                    int dot = rest.indexOf('.');
                    subpackages.add(dot < 0 ? rest : rest.substring(0, dot));
                }
            }
            for (var unit : units.values()) {
                if (unit.packge == null) {
                    continue;
                }
                var p = unit.packge.fullname.toString();
                if (p.equals(pkg)) {
                    for (var def : unit.defs) {
                        if (def instanceof JCClassDecl c && items.wants(c.name.toString())) {
                            items.add(c.name.toString(), K_CLASS, pkg + "." + c.name, "0");
                        }
                    }
                } else if (p.startsWith(prefix)) {
                    var rest = p.substring(prefix.length());
                    int dot = rest.indexOf('.');
                    subpackages.add(dot < 0 ? rest : rest.substring(0, dot));
                }
            }
            for (var sub : subpackages) {
                if (items.wants(sub)) {
                    items.add(sub, K_MODULE, "package " + prefix + sub, "2");
                }
            }
        }

        void instanceMembers(Type site, JCCompilationUnit unit, Items items) {
            if (site.hasTag(TypeTag.ARRAY)) {
                if (items.wants("length")) {
                    items.add("length", K_FIELD, "int length", "0");
                }
                members(syms.objectType, site, false, unit, items);
                return;
            }
            if (site.hasTag(TypeTag.TYPEVAR)) {
                site = site.getUpperBound();
            }
            if (site.isPrimitive()) {
                return;
            }
            members(site, site, false, unit, items);
        }

        void staticMembers(Type site, JCCompilationUnit unit, Items items) {
            members(site, site, true, unit, items);
            if (items.wants("class")) {
                items.add("class", K_KEYWORD, "Class<" + type(site) + ">", "3");
            }
            if (items.wants("this")) {
                items.add("this", K_KEYWORD, null, "3");
            }
        }

        void members(Type site, Type shown, boolean statics, JCCompilationUnit unit, Items items) {
            if (site == null || !(site.tsym instanceof ClassSymbol cls)) {
                return;
            }
            for (var s : allMembers(site)) {
                var name = s.name.toString();
                if (!items.wants(name)) {
                    continue;
                }
                boolean isStatic = (s.flags() & Flags.STATIC) != 0;
                if (statics && !isStatic && s.kind != Kinds.Kind.TYP) {
                    continue;
                }
                if (!statics && s.kind == Kinds.Kind.TYP) {
                    continue;
                }
                // An interface's static methods are not members of its instances;
                // a class's are, but nobody means them after `value.`.
                if (!statics && isStatic && (s.owner.flags() & Flags.INTERFACE) != 0) {
                    continue;
                }
                if ((s.flags() & Flags.PRIVATE) != 0 && enclosingOutermost(unit, s) == null) {
                    continue;
                }
                addMember(s, site, items, !statics && isStatic ? "4" : rank(s, cls));
            }
        }

        /**
         * The members of a type and its supertypes, most derived first, an
         * overridden method once (as its most derived declaration), without
         * constructors, initialisers and synthetic members.
         */
        List<Symbol> allMembers(Type site) {
            var out = new ArrayList<Symbol>();
            var seen = new HashSet<String>();
            List<Type> closure;
            try {
                closure = new ArrayList<>(types.closure(site));
            } catch (RuntimeException e) {
                System.err.println("closure of " + site + ": " + e);
                closure = List.of(site);
            }
            if (site.tsym != null && (site.tsym.flags() & Flags.INTERFACE) != 0) {
                closure.add(syms.objectType);
            }
            for (var t : closure) {
                if (!(t.tsym instanceof ClassSymbol c)) {
                    continue;
                }
                try {
                    for (var s : c.members().getSymbols(com.sun.tools.javac.code.Scope.LookupKind.NON_RECURSIVE)) {
                        var name = s.name.toString();
                        if (s.isConstructor() || name.equals("<clinit>") || (s.flags() & Flags.SYNTHETIC) != 0) {
                            continue;
                        }
                        String key;
                        if (s.kind == Kinds.Kind.MTH) {
                            var mt = types.memberType(site, s);
                            key = "m " + name + types.erasure(mt).getParameterTypes();
                        } else {
                            key = (s.kind == Kinds.Kind.TYP ? "t " : "v ") + name;
                        }
                        if (seen.add(key)) {
                            out.add(s);
                        }
                    }
                } catch (RuntimeException e) {
                    System.err.println("members of " + c + ": " + e);
                }
            }
            // A scope lists its members last declared first: put each class's back in source order.
            return out;
        }

        /** The member's outermost class when the file declares it, so a private member shows only in its own file. */
        ClassSymbol enclosingOutermost(JCCompilationUnit unit, Symbol s) {
            var outer = s.outermostClass();
            for (var def : unit.defs) {
                if (def instanceof JCClassDecl c && c.sym == outer) {
                    return outer;
                }
            }
            return null;
        }

        /** Sort group: the type's own members, then the project's supertypes, then the library's, Object's last. */
        String rank(Symbol s, ClassSymbol site) {
            if (s.owner == site) {
                return "0";
            }
            if (s.owner == syms.objectType.tsym) {
                return "3";
            }
            return fromSource(s) ? "1" : "2";
        }

        void addMember(Symbol s, Type site, Items items, String sort) {
            var name = s.name.toString();
            Type t;
            try {
                t = site != null ? types.memberType(site, s) : s.type;
            } catch (RuntimeException e) {
                t = s.type;
            }
            switch (s.kind) {
                case MTH -> {
                    var m = (MethodSymbol) s;
                    var detail = type(t != null ? t.getReturnType() : m.getReturnType()) + " " + name
                            + params(m, t);
                    var item = items.add(name, K_METHOD, detail, sort);
                    item.insert = m.params().isEmpty() ? name + "()" : null;
                }
                case VAR -> {
                    long f = s.flags();
                    int kind = (f & Flags.ENUM) != 0 ? K_ENUM_MEMBER
                            : (f & (Flags.STATIC | Flags.FINAL)) == (Flags.STATIC | Flags.FINAL) ? K_CONSTANT
                            : s.owner.kind == Kinds.Kind.TYP ? K_FIELD : K_VARIABLE;
                    items.add(name, kind, type(t) + " " + name, sort);
                }
                case TYP -> items.add(name, classKind(s), describe(s), sort);
                default -> { }
            }
        }

        int classKind(Symbol s) {
            if (s.type != null && s.type.hasTag(TypeTag.TYPEVAR)) {
                return K_TYPE_PARAMETER;
            }
            long f = s.flags();
            return (f & Flags.INTERFACE) != 0 ? K_INTERFACE : (f & Flags.ENUM) != 0 ? K_ENUM
                    : (f & Flags.RECORD) != 0 ? K_STRUCT : K_CLASS;
        }

        /** Names in scope at the last completeScope, for completeMember's fallback. */
        final Map<String, Symbol> scopeSymbols = new LinkedHashMap<>();

        /** Completion of a name: what is in scope, the classes the file sees, keywords, and classes to import. */
        void completeScope(JCCompilationUnit unit, String text, int offset, Items items) {
            scopeSymbols.clear();
            var finder = new PathFinder(unit, offset);
            finder.scan(unit);
            var path = finder.best;
            // Innermost first, so a local hides a field of the same name.
            for (int i = path.size() - 1; i >= 0; i--) {
                var tree = path.get(i);
                var child = i + 1 < path.size() ? path.get(i + 1) : null;
                if (tree instanceof JCBlock b) {
                    for (var stat : b.stats) {
                        if (stat == child || TreeInfo.getStartPos(stat) >= offset) {
                            break;
                        }
                        if (stat instanceof JCVariableDecl v) {
                            local(v, items);
                        } else if (stat instanceof JCClassDecl c && c.sym != null) {
                            scoped(c.sym, items, "0");
                        }
                    }
                } else if (tree instanceof JCMethodDecl m) {
                    for (var p : m.params) {
                        local(p, items);
                    }
                    for (var tp : m.typarams) {
                        typeParameter(tp, items);
                    }
                } else if (tree instanceof JCLambda l) {
                    for (var p : l.params) {
                        local(p, items);
                    }
                } else if (tree instanceof JCForLoop f) {
                    for (var s : f.init) {
                        if (s instanceof JCVariableDecl v && v != child) {
                            local(v, items);
                        }
                    }
                } else if (tree instanceof JCEnhancedForLoop f && child != f.var && child != f.expr) {
                    local(f.var, items);
                } else if (tree instanceof JCCatch c && child != c.param) {
                    local(c.param, items);
                } else if (tree instanceof JCTry t) {
                    for (var r : t.resources) {
                        if (r instanceof JCVariableDecl v && v != child) {
                            local(v, items);
                        }
                    }
                } else if (tree instanceof JCClassDecl c && c.sym != null) {
                    for (var tp : c.typarams) {
                        typeParameter(tp, items);
                    }
                    for (var s : allMembers(c.sym.type)) {
                        var name = s.name.toString();
                        scopeSymbols.putIfAbsent(name, s);
                        if (items.wants(name)) {
                            addMember(s, c.sym.type, items, s.owner == c.sym ? "1" : "2");
                        }
                    }
                }
            }
            // Classes the file sees: its own and its package's, its imports, java.lang.
            var pkg = unit.packge != null ? unit.packge.fullname.toString() : "";
            for (var u : units.values()) {
                var upkg = u.packge != null ? u.packge.fullname.toString() : "";
                if (upkg.equals(pkg)) {
                    for (var def : u.defs) {
                        if (def instanceof JCClassDecl c && c.sym != null) {
                            scoped(c.sym, items, "3");
                        }
                    }
                }
            }
            var imported = new HashSet<String>();
            for (var def : unit.defs) {
                if (def instanceof JCImport imp && !imp.staticImport && imp.qualid instanceof JCFieldAccess fa) {
                    var qualifier = fa.selected.toString();
                    if (fa.name == names.asterisk) {
                        var classes = libraryClasses.get(qualifier);
                        if (classes != null) {
                            for (var name : classes) {
                                imported.add(name);
                                if (items.wants(name)) {
                                    items.add(name, K_CLASS, qualifier + "." + name, "4");
                                }
                            }
                        }
                    } else {
                        imported.add(fa.name.toString());
                        var cls = elements.getTypeElement(fa.toString());
                        if (cls instanceof ClassSymbol c) {
                            scoped(c, items, "3");
                        } else if (items.wants(fa.name.toString())) {
                            items.add(fa.name.toString(), K_CLASS, fa.toString(), "3");
                        }
                    }
                }
            }
            var lang = libraryClasses.get("java.lang");
            if (lang != null) {
                for (var name : lang) {
                    imported.add(name);
                    if (items.wants(name)) {
                        items.add(name, K_CLASS, "java.lang." + name, "4");
                    }
                }
            }
            for (var k : KEYWORDS) {
                if (items.wants(k)) {
                    items.add(k, K_KEYWORD, null, "5");
                }
            }
            // Classes to import: a capitalised prefix of two letters or more,
            // from the class library's packages, with the import as an edit.
            if (items.prefix.length() >= 2 && Character.isUpperCase(items.prefix.charAt(0))) {
                var importAt = importText(unit);
                for (var e : libraryClasses.entrySet()) {
                    var p = e.getKey();
                    if (!importable(p, pkg)) {
                        continue;
                    }
                    for (var name : e.getValue()) {
                        if (imported.contains(name) || !name.startsWith(items.prefix)) {
                            continue;
                        }
                        var item = items.add(name, K_CLASS, p + "." + name, "6");
                        item.importText = importAt + p + "." + name;
                    }
                }
            }
        }

        /**
         * Whether auto-import and the quick fix offer a class library package:
         * not java.lang or the file's own (nothing to import), not TeaVM's or
         * the JDK's internals, which the archive has but a program cannot use.
         */
        static boolean importable(String p, String pkg) {
            return !(p.equals("java.lang") || p.equals(pkg) || p.startsWith("org.teavm")
                    || p.startsWith("jdk.") || p.startsWith("sun.") || p.startsWith("com."));
        }

        /**
         * Completion of a case label in a switch over an enum: the enum's
         * constants, unqualified (JLS 14.11.1), in declaration order. False
         * when the switch's selector is not an enum, so the caller completes
         * a name as usual (a pattern's type, a constant).
         */
        boolean completeCaseLabel(JCCompilationUnit unit, String text, int offset, Items items) {
            Type selector = null;
            var finder = new SwitchFinder(unit, offset);
            finder.scan(unit);
            if (finder.selector != null) {
                selector = TreeInfo.skipParens(finder.selector).type;
            }
            if (selector == null || selector.isErroneous()) {
                // The switch did not parse (the label is half typed): a simple
                // name in the last `switch (name)` before the case is looked up
                // in scope, as completeMember does for `name.`.
                var m = java.util.regex.Pattern.compile("\\bswitch\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)\\s*\\{")
                        .matcher(text.substring(0, offset));
                String name = null;
                while (m.find()) {
                    name = m.group(1);
                }
                if (name != null) {
                    completeScope(unit, text, offset, new Items(""));
                    var s = scopeSymbols.get(name);
                    selector = s != null && s.kind == Kinds.Kind.VAR ? s.type : null;
                }
            }
            if (selector == null || !(selector.tsym instanceof ClassSymbol c) || (c.flags() & Flags.ENUM) == 0) {
                return false;
            }
            var constants = new ArrayList<Symbol>();
            for (var s : c.members().getSymbols(com.sun.tools.javac.code.Scope.LookupKind.NON_RECURSIVE)) {
                if (s.kind == Kinds.Kind.VAR && (s.flags() & Flags.ENUM) != 0) {
                    constants.add(0, s);
                }
            }
            for (int i = 0; i < constants.size(); i++) {
                var s = constants.get(i);
                if (items.wants(s.name.toString())) {
                    addMember(s, c.type, items, "0" + (char) ('a' + i / 26) + (char) ('a' + i % 26));
                }
            }
            return true;
        }

        /** Where an import goes: "<offset>|" before the class name, so server.js can make the edit. */
        String importText(JCCompilationUnit unit) {
            int at = 0;
            for (var def : unit.defs) {
                if (def instanceof JCImport || def instanceof JCTree.JCPackageDecl) {
                    at = Math.max(at, TreeInfo.getEndPos(def, unit.endPositions));
                }
            }
            return at + "|";
        }

        void local(JCVariableDecl v, Items items) {
            var name = v.name.toString();
            if (v.sym != null) {
                scopeSymbols.putIfAbsent(name, v.sym);
            }
            if (!items.wants(name)) {
                return;
            }
            var t = v.sym != null ? type(v.sym.type) : v.vartype != null ? v.vartype.toString() : "var";
            items.add(name, K_VARIABLE, t + " " + name, "0");
        }

        void typeParameter(JCTypeParameter tp, Items items) {
            if (items.wants(tp.name.toString())) {
                items.add(tp.name.toString(), K_TYPE_PARAMETER, null, "0");
            }
        }

        void scoped(ClassSymbol c, Items items, String sort) {
            var name = c.name.toString();
            scopeSymbols.putIfAbsent(name, c);
            if (items.wants(name)) {
                items.add(name, classKind(c), describe(c), sort);
            }
        }

        // ---- Signature help

        String signatureHelp(JCCompilationUnit unit, String text, int offset) {
            var finder = new CallFinder(unit, text, offset);
            finder.scan(unit);
            if (finder.call == null) {
                return "null";
            }
            JCTree call = finder.call;
            List<Symbol> candidates = new ArrayList<>();
            Symbol chosen = null;
            if (call instanceof JCMethodInvocation inv) {
                chosen = TreeInfo.symbol(inv.meth);
                Name: {
                    Type site = null;
                    String name;
                    if (inv.meth instanceof JCFieldAccess fa) {
                        site = fa.selected.type;
                        name = fa.name.toString();
                    } else if (inv.meth instanceof JCIdent id) {
                        name = id.name.toString();
                    } else {
                        break Name;
                    }
                    if (site != null && site.tsym instanceof ClassSymbol c) {
                        collectMethods(c, name, candidates);
                    } else {
                        for (var t : finder.classes) {
                            collectMethods(t, name, candidates);
                        }
                    }
                }
            } else if (call instanceof JCNewClass nc) {
                chosen = nc.constructor;
                var cls = TreeInfo.symbol(nc.clazz);
                if (cls instanceof ClassSymbol c) {
                    for (var m : c.members().getSymbolsByName(names.init)) {
                        candidates.add(m);
                    }
                }
            }
            if (candidates.isEmpty()) {
                return "null";
            }
            var json = new Json().beginObject();
            int active = 0;
            json.key("signatures").beginArray();
            for (int i = 0; i < candidates.size(); i++) {
                var m = (MethodSymbol) candidates.get(i);
                if (m == chosen) {
                    active = i;
                }
                json.beginObject();
                var label = m.isConstructor() ? m.owner.name.toString() : m.name.toString();
                var sb = new StringBuilder(label).append('(');
                json.key("parameters").beginArray();
                var ps = m.params();
                for (int j = 0; j < ps.size(); j++) {
                    if (j > 0) {
                        sb.append(", ");
                    }
                    int from = sb.length();
                    var pt = ps.get(j).type;
                    if ((m.flags() & Flags.VARARGS) != 0 && j == ps.size() - 1 && pt.hasTag(TypeTag.ARRAY)) {
                        sb.append(type(((Type.ArrayType) pt).elemtype)).append("...");
                    } else {
                        sb.append(type(pt));
                    }
                    if (!isPlaceholder(ps.get(j).name.toString())) {
                        sb.append(' ').append(ps.get(j).name);
                    }
                    json.beginArray().value(from).value(sb.length()).endArray();
                }
                json.endArray();
                sb.append(')');
                if (!m.isConstructor()) {
                    sb.append(": ").append(type(m.getReturnType()));
                }
                json.field("label", sb.toString());
                var doc = docComment(m);
                if (doc != null) {
                    json.field("documentation", javadocToMarkdown(doc));
                }
                json.endObject();
            }
            json.endArray();
            json.field("activeSignature", active).field("activeParameter", finder.argument);
            return json.endObject().toString();
        }

        void collectMethods(ClassSymbol c, String name, List<Symbol> out) {
            for (var s : allMembers(c.type)) {
                if (s.kind == Kinds.Kind.MTH && s.name.toString().equals(name) && !out.contains(s)) {
                    out.add(s);
                }
            }
        }
    }

    /** javac's subclass hook: the unnamed module reads java.base, as teavm-javac's compiler sets it up. */
    private static final class AnalysisCompiler extends JavaCompiler {
        AnalysisCompiler(Context context) {
            super(context);
        }

        void prepare() {
            syms.unnamedModule.visiblePackages = new LinkedHashMap<>();
            syms.unnamedModule.readModules = Set.of(syms.unnamedModule, syms.java_base);
            syms.java_base.complete();
            for (var export : syms.java_base.exports) {
                syms.unnamedModule.visiblePackages.put(export.packge.fullname, export.packge);
            }
        }
    }

    /**
     * javac's TreeScanner, into erroneous trees too: an unfinished `p.` on a
     * line of its own is "not a statement", which javac wraps (attributed)
     * in a JCErroneous that TreeScanner does not enter.
     */
    abstract static class Scanner extends TreeScanner {
        @Override
        public void visitErroneous(JCErroneous tree) {
            scan(tree.errs);
        }
    }

    /** Collects every occurrence of a symbol's name whose text in the file is that name. */
    static final class Collector extends Scanner {
        private final String path;
        private final JCCompilationUnit unit;
        private final String text;
        private final List<Occurrence> out;
        private final Set<Long> seen = new HashSet<>();

        private final Analysis owner;

        Collector(Analysis owner, String path, JCCompilationUnit unit, String text, List<Occurrence> out) {
            this.owner = owner;
            this.path = path;
            this.unit = unit;
            this.text = text == null ? "" : text;
            this.out = out;
        }

        private void add(Symbol sym, int start, String name, boolean decl, JCTree tree) {
            if (sym == null || start < 0 || name.isEmpty() || !text.startsWith(name, start)) {
                return;
            }
            if (sym.kind == Kinds.Kind.ERR || sym.type != null && sym.type.isErroneous() && sym.kind != Kinds.Kind.MTH
                    && sym.kind != Kinds.Kind.VAR) {
                return;
            }
            long key = ((long) start << 20) ^ (decl ? 1 : 0);
            if (!seen.add(key)) {
                return;
            }
            var occ = new Occurrence(path, start, start + name.length(), sym, decl, tree);
            out.add(occ);
            if (decl) {
                owner.declarations.computeIfAbsent(sym, k -> new ArrayList<>()).add(occ);
                owner.declTrees.putIfAbsent(sym, tree);
                owner.declUnits.putIfAbsent(sym, unit);
            }
        }

        @Override
        public void visitIdent(JCIdent tree) {
            add(tree.sym, tree.pos, tree.name.toString(), false, tree);
        }

        @Override
        public void visitSelect(JCFieldAccess tree) {
            super.visitSelect(tree);
            int end = TreeInfo.getEndPos(tree, unit.endPositions);
            var name = tree.name.toString();
            if (end > 0) {
                add(tree.sym, end - name.length(), name, false, tree);
            }
        }

        @Override
        public void visitReference(JCMemberReference tree) {
            super.visitReference(tree);
            int end = TreeInfo.getEndPos(tree, unit.endPositions);
            var name = tree.name.toString();
            if (end > 0 && !name.equals("<init>")) {
                add(tree.sym, end - name.length(), name, false, tree);
            }
        }

        @Override
        public void visitClassDef(JCClassDecl tree) {
            if (tree.sym != null && !tree.name.isEmpty()) {
                add(tree.sym, namePos(text, tree, tree.name.toString()), tree.name.toString(), true, tree);
            }
            super.visitClassDef(tree);
        }

        @Override
        public void visitMethodDef(JCMethodDecl tree) {
            if (tree.sym != null && (tree.mods.flags & Flags.GENERATED_MEMBER) == 0
                    && (tree.sym.flags() & Flags.GENERATEDCONSTR) == 0) {
                var name = tree.sym.isConstructor() ? tree.sym.owner.name.toString() : tree.name.toString();
                add(tree.sym, namePos(text, tree, name), name, true, tree);
            }
            super.visitMethodDef(tree);
        }

        @Override
        public void visitVarDef(JCVariableDecl tree) {
            if (tree.sym != null) {
                // A record component's field is GENERATED_MEMBER but written in
                // the header; the text check in add() drops what is not written.
                add(tree.sym, namePos(text, tree, tree.name.toString()), tree.name.toString(), true, tree);
            }
            super.visitVarDef(tree);
        }

        /** Where a declaration's name is: its tree position when the name is there, else its first whole-word use after the start. */
        static int namePos(String text, JCTree tree, String name) {
            if (text == null || name.isEmpty()) {
                return -1;
            }
            int pos = tree.pos;
            if (pos >= 0 && isWordAt(text, name, pos) && !(tree instanceof JCClassDecl)) {
                return pos;
            }
            int from = Math.max(0, TreeInfo.getStartPos(tree));
            if (tree instanceof JCClassDecl) {
                // After the keyword: annotations and modifiers may repeat the name.
                for (var kw : new String[] {"class", "interface", "enum", "record"}) {
                    int k = from;
                    while ((k = text.indexOf(kw, k)) >= 0) {
                        int n = k + kw.length();
                        while (n < text.length() && Character.isWhitespace(text.charAt(n))) {
                            n++;
                        }
                        if (isWordAt(text, kw, k) && isWordAt(text, name, n)) {
                            return n;
                        }
                        k += kw.length();
                        if (k > from + 4096) {
                            break;
                        }
                    }
                }
            }
            int i = from;
            while ((i = text.indexOf(name, i)) >= 0) {
                if (isWordAt(text, name, i)) {
                    return i;
                }
                i += name.length();
            }
            return -1;
        }

        static boolean isWordAt(String text, String word, int at) {
            if (at < 0 || !text.startsWith(word, at)) {
                return false;
            }
            int end = at + word.length();
            return (at == 0 || !Character.isJavaIdentifierPart(text.charAt(at - 1)))
                    && (end >= text.length() || !Character.isJavaIdentifierPart(text.charAt(end)));
        }
    }

    /** The trees enclosing a position, outermost first: the deepest such path. */
    static final class PathFinder extends Scanner {
        private final JCCompilationUnit unit;
        private final int offset;
        private final ArrayList<JCTree> stack = new ArrayList<>();
        ArrayList<JCTree> best = new ArrayList<>();

        PathFinder(JCCompilationUnit unit, int offset) {
            this.unit = unit;
            this.offset = offset;
        }

        @Override
        public void scan(JCTree tree) {
            if (tree == null) {
                return;
            }
            int start = TreeInfo.getStartPos(tree);
            int end = TreeInfo.getEndPos(tree, unit.endPositions);
            boolean contains = start <= offset && (end < 0 || offset <= end || end <= start);
            if (!contains && !(tree instanceof JCCompilationUnit)) {
                return;
            }
            stack.add(tree);
            if (stack.size() > best.size()) {
                best = new ArrayList<>(stack);
            }
            super.scan(tree);
            stack.remove(stack.size() - 1);
        }
    }

    /**
     * The selector of the innermost switch (statement or expression) whose
     * body holds a position: the switch starts before it and its selector
     * ends before it, and javac's end of the switch is after it (or unknown,
     * where the parser recovered from the half-typed label).
     */
    static final class SwitchFinder extends Scanner {
        private final JCCompilationUnit unit;
        private final int offset;
        JCTree selector;
        private int start = -1;

        SwitchFinder(JCCompilationUnit unit, int offset) {
            this.unit = unit;
            this.offset = offset;
        }

        private void consider(JCTree tree, JCTree selector) {
            int from = TreeInfo.getStartPos(tree);
            int end = TreeInfo.getEndPos(tree, unit.endPositions);
            int selectorEnd = TreeInfo.getEndPos(selector, unit.endPositions);
            if (from <= offset && from > start && selectorEnd >= 0 && selectorEnd <= offset
                    && (end < 0 || end <= from || offset <= end)) {
                this.selector = selector;
                start = from;
            }
        }

        @Override
        public void visitSwitch(JCTree.JCSwitch tree) {
            consider(tree, tree.selector);
            super.visitSwitch(tree);
        }

        @Override
        public void visitSwitchExpression(JCTree.JCSwitchExpression tree) {
            consider(tree, tree.selector);
            super.visitSwitchExpression(tree);
        }
    }

    /** The qualifier of the select (or method reference) whose dot is at a position. */
    static final class SelectFinder extends Scanner {
        private final JCCompilationUnit unit;
        private final String text;
        private final int dot;
        JCTree qualifier;
        private int qualifierEnd = -1;

        SelectFinder(JCCompilationUnit unit, String text, int dot) {
            this.unit = unit;
            this.text = text;
            this.dot = dot;
        }

        private void consider(JCTree q) {
            int end = TreeInfo.getEndPos(q, unit.endPositions);
            if (end >= 0 && end <= dot && end > qualifierEnd) {
                if (text.substring(end, dot).isBlank()) {
                    qualifier = q;
                    qualifierEnd = end;
                }
            }
        }

        @Override
        public void visitSelect(JCFieldAccess tree) {
            consider(tree.selected);
            super.visitSelect(tree);
        }

        @Override
        public void visitReference(JCMemberReference tree) {
            consider(tree.expr);
            super.visitReference(tree);
        }
    }

    /** The innermost call whose argument list contains a position, and which argument it is in. */
    static final class CallFinder extends Scanner {
        private final JCCompilationUnit unit;
        private final String text;
        private final int offset;
        JCTree call;
        int argument;
        final List<ClassSymbol> classes = new ArrayList<>();
        private final List<ClassSymbol> enclosing = new ArrayList<>();

        CallFinder(JCCompilationUnit unit, String text, int offset) {
            this.unit = unit;
            this.text = text;
            this.offset = offset;
        }

        @Override
        public void visitClassDef(JCClassDecl tree) {
            if (tree.sym != null) {
                enclosing.add(tree.sym);
            }
            super.visitClassDef(tree);
            if (tree.sym != null) {
                enclosing.remove(enclosing.size() - 1);
            }
        }

        private void consider(JCTree tree, JCTree callee) {
            int open = text.indexOf('(', Math.max(0, TreeInfo.getEndPos(callee, unit.endPositions)));
            int end = TreeInfo.getEndPos(tree, unit.endPositions);
            if (open < 0 || offset <= open || (end > 0 && offset >= end && text.charAt(end - 1) == ')')) {
                return;
            }
            if (end > 0 && offset > end && text.charAt(end - 1) == ')') {
                return;
            }
            call = tree;
            classes.clear();
            for (int i = enclosing.size() - 1; i >= 0; i--) {
                classes.add(enclosing.get(i));
            }
            argument = 0;
            int depth = 0;
            for (int i = open + 1; i < offset && i < text.length(); i++) {
                char c = text.charAt(i);
                if (c == '(' || c == '[' || c == '{') {
                    depth++;
                } else if (c == ')' || c == ']' || c == '}') {
                    depth--;
                } else if (c == ',' && depth == 0) {
                    argument++;
                } else if (c == '"' || c == '\'') {
                    int j = i + 1;
                    while (j < offset && text.charAt(j) != c) {
                        j += text.charAt(j) == '\\' ? 2 : 1;
                    }
                    i = j;
                }
            }
        }

        @Override
        public void visitApply(JCMethodInvocation tree) {
            int start = TreeInfo.getStartPos(tree);
            if (start <= offset) {
                consider(tree, tree.meth);
            }
            super.visitApply(tree);
        }

        @Override
        public void visitNewClass(JCNewClass tree) {
            int start = TreeInfo.getStartPos(tree);
            if (start <= offset) {
                consider(tree, tree.clazz);
            }
            super.visitNewClass(tree);
        }
    }

    /** Javadoc (javac's cleaned comment text) as Markdown: inline tags as code, block tags as a list. */
    static String javadocToMarkdown(String doc) {
        var sb = new StringBuilder();
        int i = 0;
        while (i < doc.length()) {
            if (doc.startsWith("{@", i)) {
                int close = doc.indexOf('}', i);
                int space = doc.indexOf(' ', i);
                if (close > 0) {
                    var tag = doc.substring(i + 2, space > 0 && space < close ? space : close);
                    var body = space > 0 && space < close ? doc.substring(space + 1, close).trim() : "";
                    if (tag.equals("code") || tag.equals("link") || tag.equals("linkplain") || tag.equals("literal")) {
                        sb.append('`').append(body.replace('#', '.')).append('`');
                    } else {
                        sb.append(body);
                    }
                    i = close + 1;
                    continue;
                }
            }
            sb.append(doc.charAt(i++));
        }
        var lines = sb.toString().split("\n");
        var out = new StringBuilder();
        boolean inTags = false;
        for (var line : lines) {
            var t = line.trim();
            if (t.startsWith("@")) {
                if (!inTags) {
                    out.append('\n');
                    inTags = true;
                }
                int sp = t.indexOf(' ');
                var tag = sp < 0 ? t : t.substring(0, sp);
                var rest = sp < 0 ? "" : t.substring(sp + 1).trim();
                if ((tag.equals("@param") || tag.equals("@throws") || tag.equals("@exception")) && !rest.isEmpty()) {
                    int sp2 = rest.indexOf(' ');
                    var name = sp2 < 0 ? rest : rest.substring(0, sp2);
                    rest = sp2 < 0 ? "" : rest.substring(sp2 + 1);
                    out.append("* *").append(tag).append("* `").append(name).append("` ").append(rest).append('\n');
                } else {
                    out.append("* *").append(tag).append("* ").append(rest).append('\n');
                }
            } else {
                out.append(line).append('\n');
            }
        }
        return out.toString().trim();
    }
}
