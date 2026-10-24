/*
 * Yukibana Java pack: @SuppressWarnings with its element. TeaVM 0.16.0's has
 * none, so javac rejected `@SuppressWarnings("unchecked")` ("cannot find
 * symbol: method value()"). Only javac reads it (classlib-javac.bin).
 */
package org.teavm.classlib.java.lang;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target({ElementType.TYPE, ElementType.FIELD, ElementType.METHOD, ElementType.PARAMETER, ElementType.CONSTRUCTOR,
        ElementType.LOCAL_VARIABLE})
@Retention(RetentionPolicy.SOURCE)
public @interface TSuppressWarnings {
    String[] value();
}
