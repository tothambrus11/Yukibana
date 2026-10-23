/*
 * Yukibana Java pack: a minimal JSON writer for LanguageService's answers.
 * TeaVM's JSO can pass strings cheaply, so every answer crosses to
 * JavaScript as one JSON string and is parsed there.
 */
package org.teavm.javac;

final class Json {
    private final StringBuilder sb = new StringBuilder();
    // Whether the next value in the current object or array needs a comma first.
    private boolean comma;

    Json beginObject() {
        sep();
        sb.append('{');
        comma = false;
        return this;
    }

    Json endObject() {
        sb.append('}');
        comma = true;
        return this;
    }

    Json beginArray() {
        sep();
        sb.append('[');
        comma = false;
        return this;
    }

    Json endArray() {
        sb.append(']');
        comma = true;
        return this;
    }

    Json key(String name) {
        sep();
        string(name);
        sb.append(':');
        comma = false;
        return this;
    }

    Json value(String s) {
        sep();
        if (s == null) {
            sb.append("null");
        } else {
            string(s);
        }
        comma = true;
        return this;
    }

    Json value(int n) {
        sep();
        sb.append(n);
        comma = true;
        return this;
    }

    Json value(boolean b) {
        sep();
        sb.append(b);
        comma = true;
        return this;
    }

    Json nullValue() {
        sep();
        sb.append("null");
        comma = true;
        return this;
    }

    Json field(String name, String s) {
        return key(name).value(s);
    }

    Json field(String name, int n) {
        return key(name).value(n);
    }

    Json field(String name, boolean b) {
        return key(name).value(b);
    }

    private void sep() {
        if (comma) {
            sb.append(',');
            comma = false;
        }
    }

    private void string(String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append("\\u00").append(Character.forDigit(c >> 4, 16)).append(Character.forDigit(c & 15, 16));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
    }

    @Override
    public String toString() {
        return sb.toString();
    }
}
