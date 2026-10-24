/*
 *  Yukibana Java pack: java.lang.IO (Java 25, JEP 512), which TeaVM's class
 *  library (0.16.0) does not have, for compact source files.
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

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** As in JDK 25: System.out for output, System.in (as UTF-8 lines) for input. */
public final class TIO {
    private TIO() {
    }

    public static void println(Object obj) {
        System.out.println(obj);
    }

    public static void println() {
        System.out.println();
    }

    public static void print(Object obj) {
        System.out.print(obj);
        System.out.flush();
    }

    public static String readln(String prompt) {
        print(prompt);
        return readln();
    }

    /** A line of input without its line terminator; null at end of input. */
    public static String readln() {
        var bytes = new ByteArrayOutputStream();
        try {
            while (true) {
                int b = System.in.read();
                if (b < 0) {
                    if (bytes.size() == 0) {
                        return null;
                    }
                    break;
                }
                if (b == '\n') {
                    break;
                }
                bytes.write(b);
            }
        } catch (IOException e) {
            throw new java.io.UncheckedIOException(e);
        }
        var line = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
        return line.endsWith("\r") ? line.substring(0, line.length() - 1) : line;
    }
}
