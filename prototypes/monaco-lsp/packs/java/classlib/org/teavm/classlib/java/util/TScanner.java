/*
 *  Yukibana Java pack: java.util.Scanner for TeaVM, whose class library
 *  (0.16.0) has none.
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
package org.teavm.classlib.java.util;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.NoSuchElementException;

/**
 * The part of java.util.Scanner that programs reading a terminal or a string
 * use: tokens separated by whitespace (the default delimiter), lines, and
 * the primitive types in Java's own syntax (`Integer.parseInt` and friends,
 * so no locale grouping). Input is read a line at a time, so reading a token
 * from System.in waits for one line, as on the JVM. Not here: custom
 * delimiters, patterns (`findInLine`, `hasNext(String)`), radixes other than
 * ten, `Readable`/`File`/`Path` sources, and locales.
 */
public final class TScanner implements Closeable, java.util.Iterator<String> {
    private final InputStream in;
    private final StringBuilder buffer = new StringBuilder();
    private int position;
    private boolean eof;
    private boolean closed;

    public TScanner(InputStream source) {
        if (source == null) {
            throw new NullPointerException();
        }
        this.in = source;
    }

    public TScanner(String source) {
        this.in = null;
        buffer.append(source);
        eof = true;
    }

    private void ensureOpen() {
        if (closed) {
            throw new IllegalStateException("Scanner closed");
        }
    }

    /** Reads one more line (with its newline) into the buffer; false at end of input. */
    private boolean fill() {
        if (eof) {
            return false;
        }
        if (position > 4096 && position == buffer.length()) {
            buffer.setLength(0);
            position = 0;
        }
        var bytes = new ByteArrayOutputStream();
        try {
            while (true) {
                int b = in.read();
                if (b < 0) {
                    eof = true;
                    break;
                }
                bytes.write(b);
                if (b == '\n') {
                    break;
                }
            }
        } catch (IOException e) {
            eof = true;
        }
        if (bytes.size() == 0) {
            return false;
        }
        buffer.append(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        return true;
    }

    private static boolean isDelimiter(char c) {
        return Character.isWhitespace(c);
    }

    /** The start of the next token, reading lines as needed; -1 when there is none. */
    private int tokenStart() {
        int i = position;
        while (true) {
            while (i < buffer.length() && isDelimiter(buffer.charAt(i))) {
                i++;
            }
            if (i < buffer.length()) {
                return i;
            }
            if (!fill()) {
                return -1;
            }
        }
    }

    /** The end of the token at start, reading on while it reaches the end of the buffer. */
    private int tokenEnd(int start) {
        int i = start;
        while (true) {
            while (i < buffer.length() && !isDelimiter(buffer.charAt(i))) {
                i++;
            }
            if (i < buffer.length() || !fill()) {
                return i;
            }
        }
    }

    private String peekToken() {
        ensureOpen();
        int start = tokenStart();
        if (start < 0) {
            return null;
        }
        return buffer.substring(start, tokenEnd(start));
    }

    @Override
    public boolean hasNext() {
        return peekToken() != null;
    }

    @Override
    public String next() {
        ensureOpen();
        int start = tokenStart();
        if (start < 0) {
            throw new NoSuchElementException();
        }
        int end = tokenEnd(start);
        position = end;
        return buffer.substring(start, end);
    }

    public boolean hasNextLine() {
        ensureOpen();
        return position < buffer.length() || fill();
    }

    public String nextLine() {
        ensureOpen();
        while (true) {
            int newline = buffer.indexOf("\n", position);
            if (newline >= 0) {
                int end = newline > position && buffer.charAt(newline - 1) == '\r' ? newline - 1 : newline;
                var line = buffer.substring(position, end);
                position = newline + 1;
                return line;
            }
            if (!fill()) {
                if (position < buffer.length()) {
                    var line = buffer.substring(position);
                    position = buffer.length();
                    return line;
                }
                throw new NoSuchElementException("No line found");
            }
        }
    }

    private interface Parser<T> {
        T parse(String s);
    }

    private <T> T nextValue(Parser<T> parser) {
        var token = peekToken();
        if (token == null) {
            throw new NoSuchElementException();
        }
        T value;
        try {
            value = parser.parse(token);
        } catch (NumberFormatException e) {
            throw new TInputMismatchException("For input string: \"" + token + "\"");
        }
        next();
        return value;
    }

    private boolean hasNextValue(Parser<?> parser) {
        var token = peekToken();
        if (token == null) {
            return false;
        }
        try {
            parser.parse(token);
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    private static String plain(String s) {
        return s.startsWith("+") ? s.substring(1) : s;
    }

    public int nextInt() {
        return nextValue(s -> Integer.parseInt(plain(s)));
    }

    public boolean hasNextInt() {
        return hasNextValue(s -> Integer.parseInt(plain(s)));
    }

    public long nextLong() {
        return nextValue(s -> Long.parseLong(plain(s)));
    }

    public boolean hasNextLong() {
        return hasNextValue(s -> Long.parseLong(plain(s)));
    }

    public short nextShort() {
        return nextValue(s -> Short.parseShort(plain(s)));
    }

    public boolean hasNextShort() {
        return hasNextValue(s -> Short.parseShort(plain(s)));
    }

    public byte nextByte() {
        return nextValue(s -> Byte.parseByte(plain(s)));
    }

    public boolean hasNextByte() {
        return hasNextValue(s -> Byte.parseByte(plain(s)));
    }

    private static double parseDouble(String s) {
        // Scanner accepts "NaN" and "Infinity"; parseDouble's hexadecimal and
        // "1d" forms it does not.
        if (s.endsWith("d") || s.endsWith("D") || s.endsWith("f") || s.endsWith("F") || s.contains("x")
                || s.contains("X")) {
            throw new NumberFormatException(s);
        }
        return Double.parseDouble(s);
    }

    public double nextDouble() {
        return nextValue(TScanner::parseDouble);
    }

    public boolean hasNextDouble() {
        return hasNextValue(TScanner::parseDouble);
    }

    public float nextFloat() {
        return nextValue(s -> (float) parseDouble(s));
    }

    public boolean hasNextFloat() {
        return hasNextValue(s -> (float) parseDouble(s));
    }

    private static boolean parseBoolean(String s) {
        if (s.equalsIgnoreCase("true")) {
            return true;
        }
        if (s.equalsIgnoreCase("false")) {
            return false;
        }
        throw new NumberFormatException(s);
    }

    public boolean nextBoolean() {
        return nextValue(TScanner::parseBoolean);
    }

    public boolean hasNextBoolean() {
        return hasNextValue(TScanner::parseBoolean);
    }

    @Override
    public void close() {
        if (closed) {
            return;
        }
        closed = true;
        if (in != null) {
            try {
                in.close();
            } catch (IOException e) {
                // as Scanner: ignored
            }
        }
    }

    @Override
    public void remove() {
        throw new UnsupportedOperationException();
    }
}
