/*
 * Yukibana Java pack: the class library's dependency plugins, registered
 * by hand for the TeaVM that runs in the browser.
 *
 * TeaVM finds these through @PluggableDependency annotations, which it
 * instantiates by reflection, and skips when it runs as a "bootstrap"
 * build of itself (DependencyAnalyzer.attachDependencyPlugin), as it does
 * here. Without them, Object.clone, System.arraycopy, reflective arrays
 * and Class.getEnumConstants lose their type flow, and a class library
 * object's clone() returns null: `new DecimalFormat(...)` (and so
 * String.format("%.2f")) then traps with "dereferencing a null pointer".
 */
package org.teavm.javac;

import org.teavm.classlib.java.lang.ClassGenerator;
import org.teavm.classlib.java.lang.ObjectDependencyPlugin;
import org.teavm.classlib.java.lang.StringNativeDependency;
import org.teavm.classlib.java.lang.SystemDependencyPlugin;
import org.teavm.classlib.java.lang.reflect.ArrayDependencyPlugin;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodReference;
import org.teavm.model.ValueType;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

public class BootstrapDependencies implements TeaVMPlugin {
    private static final ValueType OBJECT = ValueType.object("java.lang.Object");
    private static final ValueType CLASS = ValueType.object("java.lang.Class");

    @Override
    public void install(TeaVMHost host) {
        host.add(ref("java.lang.Object", "clone", OBJECT), new ObjectDependencyPlugin());
        host.add(ref("java.lang.System", "doArrayCopy", OBJECT, ValueType.INTEGER, OBJECT, ValueType.INTEGER,
                ValueType.INTEGER, ValueType.VOID), new SystemDependencyPlugin());
        host.add(ref("java.lang.String", "intern", ValueType.object("java.lang.String")),
                new StringNativeDependency());
        var array = new ArrayDependencyPlugin();
        host.add(ref("java.lang.reflect.Array", "getLength", OBJECT, ValueType.INTEGER), array);
        host.add(ref("java.lang.reflect.Array", "newInstance", CLASS, ValueType.INTEGER, OBJECT), array);
        host.add(ref("java.lang.reflect.Array", "get", OBJECT, ValueType.INTEGER, OBJECT), array);
        host.add(ref("java.lang.reflect.Array", "set", OBJECT, ValueType.INTEGER, OBJECT, ValueType.VOID), array);
        var cls = new ClassGenerator();
        host.add(ref("java.lang.Class", "getSuperclass", CLASS), cls);
        host.add(ref("java.lang.Class", "getInterfaces", ValueType.arrayOf(CLASS)), cls);
        host.add(ref("java.lang.Class", "getEnumConstants", ValueType.arrayOf(OBJECT)), cls);
        host.add(ref("java.lang.Class", "getEnumConstantsFast", ValueType.arrayOf(OBJECT)), cls);
        host.add(ref("java.lang.Class", "newInstance", OBJECT), cls);
        host.add(ref("java.lang.Class", "getDeclaredClasses", ValueType.arrayOf(CLASS)), cls);
        new DivisionChecks().install(host);
    }

    private static MethodReference ref(String cls, String name, ValueType... signature) {
        return new MethodReference(cls, new MethodDescriptor(name, signature));
    }
}
