package yk;

import java.io.PrintStream;

/** Runs kotlinc (JVM or JS) once on the given arguments; the first argument names the compiler. */
public final class Kc {
    public static void main(String[] args) throws Exception {
        String[] rest = java.util.Arrays.copyOfRange(args, 1, args.length);
        long t0 = System.nanoTime();
        int code = run(args[0], rest, System.err);
        System.err.printf("[yk] %s exit %d in %d ms%n", args[0], code, (System.nanoTime() - t0) / 1_000_000);
    }

    static int run(String which, String[] args, PrintStream out) {
        org.jetbrains.kotlin.cli.common.CLICompiler<?> c = switch (which) {
            case "jvm" -> new org.jetbrains.kotlin.cli.jvm.K2JVMCompiler();
            case "js" -> new org.jetbrains.kotlin.cli.js.K2JSCompiler();
            case "wasm" -> new org.jetbrains.kotlin.cli.js.KotlinWasmCompiler();
            default -> throw new IllegalArgumentException(which);
        };
        return c.exec(out, args).getCode();
    }
}
