package yk;

import org.graalvm.webimage.api.JS;
import org.graalvm.webimage.api.JSNumber;
import org.graalvm.webimage.api.JSString;
import org.jetbrains.kotlin.cli.common.CLICompiler;
import org.jetbrains.kotlin.cli.common.messages.CompilerMessageSeverity;
import org.jetbrains.kotlin.cli.common.messages.CompilerMessageSourceLocation;
import org.jetbrains.kotlin.cli.common.messages.MessageRenderer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.stream.Stream;

/**
 * kotlinc as a service for JavaScript: the compiler and an in-memory file system, compiled to
 * WebAssembly GC by GraalVM Web Image. main() puts an instance at globalThis.yk and calls
 * globalThis.ykReady(yk) if it is defined. Bytes cross the boundary as Latin-1 strings (one
 * char per byte), the only bulk type Web Image converts.
 */
public final class KotlinService {
    @JS.Coerce
    @JS(args = {"s"}, value = "globalThis.yk = s; if (globalThis.ykReady) globalThis.ykReady(s);")
    static native void install(KotlinService s);

    public static void main(String[] args) {
        install(new KotlinService());
    }

    /** Writes a file, creating its directories. */
    public void writeFile(JSString path, JSString latin1) throws IOException {
        Path p = Path.of(path.asString());
        if (p.getParent() != null) Files.createDirectories(p.getParent());
        Files.write(p, latin1.asString().getBytes(StandardCharsets.ISO_8859_1));
    }

    /** A file's bytes as Latin-1. */
    public JSString readFile(JSString path) throws IOException {
        return JSString.of(new String(Files.readAllBytes(Path.of(path.asString())), StandardCharsets.ISO_8859_1));
    }

    /** Every regular file under a directory, one path per line. */
    public JSString listFiles(JSString dir) throws IOException {
        Path d = Path.of(dir.asString());
        if (!Files.exists(d)) return JSString.of("");
        try (Stream<Path> s = Files.walk(d)) {
            return JSString.of(String.join("\n", s.filter(Files::isRegularFile).map(Path::toString).sorted().toList()));
        }
    }

    /** Deletes a directory and everything under it; nothing if it does not exist. */
    public void deleteTree(JSString dir) throws IOException {
        Path d = Path.of(dir.asString());
        if (!Files.exists(d)) return;
        try (Stream<Path> s = Files.walk(d)) {
            for (Path p : s.sorted(Comparator.reverseOrder()).toList()) Files.delete(p);
        }
    }

    /**
     * Runs one compilation. which is "jvm", "js" or "wasm"; args are kotlinc's, one per line. Returns
     * JSON: {"exit": n, "ms": n, "messages": [{"severity", "message", "path", "line", "column",
     * "lineEnd", "columnEnd"}]}, lines and columns 1-based as kotlinc reports them, -1 when unknown.
     */
    public JSString compile(JSString which, JSString args) {
        CLICompiler<?> c = switch (which.asString()) {
            case "jvm" -> new org.jetbrains.kotlin.cli.jvm.K2JVMCompiler();
            case "js" -> new org.jetbrains.kotlin.cli.js.K2JSCompiler();
            case "wasm" -> new org.jetbrains.kotlin.cli.js.KotlinWasmCompiler();
            default -> throw new IllegalArgumentException("unknown compiler " + which.asString());
        };
        JsonRenderer r = new JsonRenderer();
        ByteArrayOutputStream sink = new ByteArrayOutputStream();
        long t0 = System.nanoTime();
        int exit;
        try (PrintStream ps = new PrintStream(sink, true, StandardCharsets.UTF_8)) {
            exit = c.exec(ps, r, args.asString().split("\n")).getCode();
        }
        long ms = (System.nanoTime() - t0) / 1_000_000;
        return JSString.of("{\"exit\":" + exit + ",\"ms\":" + ms + ",\"messages\":[" + r.out + "]}");
    }

    /** Collects messages as JSON objects instead of printing text. */
    static final class JsonRenderer implements MessageRenderer {
        final StringBuilder out = new StringBuilder();

        @Override public String renderPreamble() { return ""; }
        @Override public String renderUsage(String usage) { return render(CompilerMessageSeverity.ERROR, usage, null); }
        @Override public String renderConclusion() { return ""; }
        @Override public String getName() { return "json"; }

        @Override
        public String render(CompilerMessageSeverity severity, String message, CompilerMessageSourceLocation loc) {
            if (out.length() > 0) out.append(',');
            out.append("{\"severity\":").append(quote(severity.getPresentableName()))
               .append(",\"message\":").append(quote(message));
            if (loc != null) {
                out.append(",\"path\":").append(quote(loc.getPath()))
                   .append(",\"line\":").append(loc.getLine())
                   .append(",\"column\":").append(loc.getColumn())
                   .append(",\"lineEnd\":").append(loc.getLineEnd())
                   .append(",\"columnEnd\":").append(loc.getColumnEnd());
            }
            out.append('}');
            return "";
        }

        static String quote(String s) {
            StringBuilder b = new StringBuilder("\"");
            for (char ch : s.toCharArray()) {
                switch (ch) {
                    case '"' -> b.append("\\\"");
                    case '\\' -> b.append("\\\\");
                    case '\n' -> b.append("\\n");
                    case '\r' -> b.append("\\r");
                    case '\t' -> b.append("\\t");
                    default -> { if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch)); else b.append(ch); }
                }
            }
            return b.append('"').toString();
        }
    }
}
