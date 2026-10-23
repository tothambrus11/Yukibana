/*
 * Yukibana Java pack: @Deprecated with its elements (since, forRemoval),
 * which TeaVM 0.16.0's lacks, so `@Deprecated(since = "2")` did not compile.
 */
package org.teavm.classlib.java.lang;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.CONSTRUCTOR, ElementType.FIELD, ElementType.LOCAL_VARIABLE, ElementType.METHOD,
        ElementType.PACKAGE, ElementType.PARAMETER, ElementType.TYPE})
public @interface TDeprecated {
    String since() default "";

    boolean forRemoval() default false;
}
