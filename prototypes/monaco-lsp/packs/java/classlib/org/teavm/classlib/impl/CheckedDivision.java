/*
 * Yukibana Java pack: integer division as the JVM does it, with the
 * ArithmeticException for a zero divisor.
 *
 * TeaVM's WebAssembly GC backend (0.16.0) compiles `a / b` and `a % b` on
 * int and long to the WebAssembly instructions, which trap on a zero
 * divisor: the trap ends the program and no Java `catch` sees it.
 * DivisionChecks (compiler/) replaces every such instruction with a call to
 * one of these, which TeaVM inlines. It is in the class library of the
 * programs the browser builds (classlib-teavm.bin) and, copied by build.sh,
 * in compiler.wasm, whose javac relies on the exception: its constant folder
 * catches it to leave `1 / 0` unfolded.
 */
package org.teavm.classlib.impl;

public final class CheckedDivision {
    private CheckedDivision() {
    }

    public static int divide(int a, int b) {
        if (b == 0) {
            throw new ArithmeticException("/ by zero");
        }
        return a / b;
    }

    public static int remainder(int a, int b) {
        if (b == 0) {
            throw new ArithmeticException("/ by zero");
        }
        return a % b;
    }

    public static long divide(long a, long b) {
        if (b == 0) {
            throw new ArithmeticException("/ by zero");
        }
        return a / b;
    }

    public static long remainder(long a, long b) {
        if (b == 0) {
            throw new ArithmeticException("/ by zero");
        }
        return a % b;
    }
}
