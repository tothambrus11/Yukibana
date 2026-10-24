/*
 *  Copyright 2017 Alexey Andreev.
 *  Modified for Yukibana: reads the runner's terminal.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
package org.teavm.classlib.java.lang;

import java.io.IOException;
import org.teavm.classlib.java.io.TInputStream;
import org.teavm.interop.Import;

/**
 * System.in. TeaVM's own is always at end of file; this one asks the Java
 * pack's runner (runner.js), which blocks the worker on the app's
 * SharedArrayBuffer until the user types a line (packs/CONTRACT.md,
 * "Standard input"). A byte at a time: input is typed by hand.
 */
class TConsoleInputStream extends TInputStream {
    /** The next byte of input, waiting for a line when none is buffered; -1 at end of file. */
    @Import(module = "yukibana", name = "stdinRead")
    private static native int read0();

    /** How many bytes can be read without waiting. */
    @Import(module = "yukibana", name = "stdinAvailable")
    private static native int available0();

    @Override
    public int read() throws IOException {
        return read0();
    }

    @Override
    public int read(byte[] b, int off, int len) throws IOException {
        if (len == 0) {
            return 0;
        }
        int c = read0();
        if (c < 0) {
            return -1;
        }
        b[off] = (byte) c;
        int n = 1;
        while (n < len && available0() > 0) {
            c = read0();
            if (c < 0) {
                break;
            }
            b[off + n++] = (byte) c;
        }
        return n;
    }

    @Override
    public int available() throws IOException {
        return available0();
    }
}
