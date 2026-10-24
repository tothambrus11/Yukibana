package yk;

import com.oracle.svm.core.annotate.Alias;
import com.oracle.svm.core.annotate.Substitute;
import com.oracle.svm.core.annotate.TargetClass;

import java.util.concurrent.atomic.AtomicIntegerFieldUpdater;
import java.util.concurrent.atomic.AtomicLongFieldUpdater;
import java.util.concurrent.atomic.AtomicReferenceFieldUpdater;

/*
 * Web Image cannot walk the stack, so Reflection.getCallerClass() is null and every
 * Atomic*FieldUpdater.newUpdater fails with a NullPointerException in the updater's constructor
 * (caller.getClassLoader()). kotlin.Lazy and IntelliJ's collections create updaters in static
 * initialisers, so kotlinc fails before it parses its arguments. These substitutions pass the
 * updated class as its own caller, which satisfies the same access checks for the fields the
 * class declares (all of kotlinc's uses). The fields must be registered for reflection.
 */

@TargetClass(className = "java.util.concurrent.atomic.AtomicReferenceFieldUpdater$AtomicReferenceFieldUpdaterImpl")
final class Target_AtomicReferenceFieldUpdaterImpl {
    @Alias
    Target_AtomicReferenceFieldUpdaterImpl(Class<?> tclass, Class<?> vclass, String fieldName, Class<?> caller) {
    }
}

@TargetClass(AtomicReferenceFieldUpdater.class)
final class Target_AtomicReferenceFieldUpdater {
    @Substitute
    @SuppressWarnings("unchecked")
    static <U, W> AtomicReferenceFieldUpdater<U, W> newUpdater(Class<U> tclass, Class<W> vclass, String fieldName) {
        return (AtomicReferenceFieldUpdater<U, W>) (Object) new Target_AtomicReferenceFieldUpdaterImpl(tclass, vclass, fieldName, tclass);
    }
}

@TargetClass(className = "java.util.concurrent.atomic.AtomicIntegerFieldUpdater$AtomicIntegerFieldUpdaterImpl")
final class Target_AtomicIntegerFieldUpdaterImpl {
    @Alias
    Target_AtomicIntegerFieldUpdaterImpl(Class<?> tclass, String fieldName, Class<?> caller) {
    }
}

@TargetClass(AtomicIntegerFieldUpdater.class)
final class Target_AtomicIntegerFieldUpdater {
    @Substitute
    @SuppressWarnings("unchecked")
    static <U> AtomicIntegerFieldUpdater<U> newUpdater(Class<U> tclass, String fieldName) {
        return (AtomicIntegerFieldUpdater<U>) (Object) new Target_AtomicIntegerFieldUpdaterImpl(tclass, fieldName, tclass);
    }
}

@TargetClass(className = "java.util.concurrent.atomic.AtomicLongFieldUpdater$CASUpdater")
final class Target_AtomicLongFieldUpdater_CASUpdater {
    @Alias
    Target_AtomicLongFieldUpdater_CASUpdater(Class<?> tclass, String fieldName, Class<?> caller) {
    }
}

@TargetClass(AtomicLongFieldUpdater.class)
final class Target_AtomicLongFieldUpdater {
    @Substitute
    @SuppressWarnings("unchecked")
    static <U> AtomicLongFieldUpdater<U> newUpdater(Class<U> tclass, String fieldName) {
        return (AtomicLongFieldUpdater<U>) (Object) new Target_AtomicLongFieldUpdater_CASUpdater(tclass, fieldName, tclass);
    }
}
