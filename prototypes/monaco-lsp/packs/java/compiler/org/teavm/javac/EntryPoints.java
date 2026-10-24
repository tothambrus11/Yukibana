/*
 * Yukibana Java pack: what a compiled project can be started from, read
 * from its class files with ASM (which teavm-javac already contains).
 *
 * Mains are what the `java` launcher of JDK 25 accepts (JEP 512): a
 * non-private `main(String[])` or `main()`, static or not; runner.js picks
 * one with the launcher's preference. Tests are JUnit Jupiter's: methods
 * annotated `@Test`, with the lifecycle methods of their class. The
 * runner calls them directly from generated code, because the JUnit
 * Platform discovers and invokes tests by reflection, which TeaVM does not
 * have (see README, "Tests").
 */
package org.teavm.javac;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipInputStream;
import org.objectweb.asm.AnnotationVisitor;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

final class EntryPoints {
    private static final String JUPITER = "Lorg/junit/jupiter/api/";

    private EntryPoints() {
    }

    static final class Method {
        String name;
        String descriptor;
        boolean isStatic;
        boolean isPrivate;
        final List<String> annotations = new ArrayList<>();
        String displayName;
    }

    static final class Cls extends ClassVisitor {
        String name;
        int access;
        boolean hasNoArgConstructor;
        boolean isInner;
        String displayName;
        boolean disabled;
        final List<String> annotations = new ArrayList<>();
        final List<Method> methods = new ArrayList<>();

        Cls() {
            super(Opcodes.ASM9);
        }

        @Override
        public void visit(int version, int access, String name, String signature, String superName,
                String[] interfaces) {
            this.name = name;
            this.access = access;
        }

        @Override
        public void visitInnerClass(String name, String outerName, String innerName, int access) {
            if (name.equals(this.name) && (access & Opcodes.ACC_STATIC) == 0 && outerName != null) {
                isInner = true;
            }
        }

        @Override
        public AnnotationVisitor visitAnnotation(String descriptor, boolean visible) {
            annotations.add(descriptor);
            if (descriptor.equals(JUPITER + "Disabled;")) {
                disabled = true;
            }
            if (descriptor.equals(JUPITER + "DisplayName;")) {
                return new AnnotationVisitor(Opcodes.ASM9) {
                    @Override
                    public void visit(String n, Object value) {
                        if (n.equals("value")) {
                            displayName = String.valueOf(value);
                        }
                    }
                };
            }
            return null;
        }

        @Override
        public MethodVisitor visitMethod(int access, String name, String descriptor, String signature,
                String[] exceptions) {
            if (name.equals("<init>")) {
                if (descriptor.equals("()V") && (access & Opcodes.ACC_PRIVATE) == 0) {
                    hasNoArgConstructor = true;
                }
                return null;
            }
            if ((access & (Opcodes.ACC_SYNTHETIC | Opcodes.ACC_BRIDGE)) != 0) {
                return null;
            }
            var m = new Method();
            m.name = name;
            m.descriptor = descriptor;
            m.isStatic = (access & Opcodes.ACC_STATIC) != 0;
            m.isPrivate = (access & Opcodes.ACC_PRIVATE) != 0;
            methods.add(m);
            return new MethodVisitor(Opcodes.ASM9) {
                @Override
                public AnnotationVisitor visitAnnotation(String desc, boolean visible) {
                    m.annotations.add(desc);
                    if (desc.equals(JUPITER + "DisplayName;")) {
                        return new AnnotationVisitor(Opcodes.ASM9) {
                            @Override
                            public void visit(String n, Object value) {
                                if (n.equals("value")) {
                                    m.displayName = String.valueOf(value);
                                }
                            }
                        };
                    }
                    return null;
                }
            };
        }
    }

    /**
     * {mains: [{cls, static, args}], tests: [{cls, display?, disabled,
     * instantiable, tests: [{name, display?, disabled, unsupported?}],
     * beforeAll, afterAll, beforeEach, afterEach}]}. Class names are binary
     * names with dots (`demo.Outer$Inner`).
     */
    static String find(byte[] jar) throws IOException {
        var classes = new ArrayList<Cls>();
        try (var input = new ZipInputStream(new ByteArrayInputStream(jar))) {
            while (true) {
                var entry = input.getNextEntry();
                if (entry == null) {
                    break;
                }
                if (!entry.getName().endsWith(".class") || entry.getName().endsWith("module-info.class")) {
                    continue;
                }
                var cls = new Cls();
                new ClassReader(input.readAllBytes()).accept(cls,
                        ClassReader.SKIP_CODE | ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
                classes.add(cls);
            }
        }
        var json = new Json().beginObject();
        json.key("mains").beginArray();
        for (var c : classes) {
            boolean concrete = (c.access & (Opcodes.ACC_ABSTRACT | Opcodes.ACC_INTERFACE)) == 0;
            for (var m : c.methods) {
                if (!m.name.equals("main") || m.isPrivate) {
                    continue;
                }
                boolean args = m.descriptor.equals("([Ljava/lang/String;)V");
                if (!args && !m.descriptor.equals("()V")) {
                    continue;
                }
                if (!m.isStatic && (!concrete || !c.hasNoArgConstructor || c.isInner)) {
                    continue;
                }
                json.beginObject().field("cls", c.name.replace('/', '.')).field("static", m.isStatic)
                        .field("args", args).endObject();
            }
        }
        json.endArray();
        json.key("tests").beginArray();
        for (var c : classes) {
            var tests = new ArrayList<Method>();
            for (var m : c.methods) {
                if (has(m, "Test;") || has(m, "ParameterizedTest;") || has(m, "RepeatedTest;")
                        || has(m, "TestFactory;") || has(m, "TestTemplate;")) {
                    tests.add(m);
                }
            }
            if (tests.isEmpty()) {
                continue;
            }
            json.beginObject().field("cls", c.name.replace('/', '.'));
            if (c.displayName != null) {
                json.field("display", c.displayName);
            }
            boolean concrete = (c.access & (Opcodes.ACC_ABSTRACT | Opcodes.ACC_INTERFACE)) == 0;
            json.field("disabled", c.disabled)
                    .field("instantiable", concrete && c.hasNoArgConstructor && !c.isInner);
            json.key("tests").beginArray();
            for (var m : tests) {
                json.beginObject().field("name", m.name);
                if (m.displayName != null) {
                    json.field("display", m.displayName);
                }
                json.field("disabled", has(m, "Disabled;"));
                String unsupported = null;
                if (!has(m, "Test;")) {
                    unsupported = m.annotations.stream().filter(a -> a.startsWith("Lorg/junit/jupiter/"))
                            .map(a -> "@" + a.substring(a.lastIndexOf('/') + 1, a.length() - 1))
                            .filter(a -> !a.equals("@DisplayName") && !a.equals("@Disabled"))
                            .findFirst().orElse("this kind of test");
                } else if (!m.descriptor.equals("()V") && !m.descriptor.startsWith("()")) {
                    unsupported = "a test method with parameters";
                } else if (m.isStatic) {
                    unsupported = "a static @Test method";
                } else if (m.isPrivate) {
                    unsupported = "a private @Test method";
                }
                if (unsupported != null) {
                    json.field("unsupported", unsupported);
                }
                json.endObject();
            }
            json.endArray();
            for (var kind : new String[] {"BeforeAll", "AfterAll", "BeforeEach", "AfterEach"}) {
                json.key(Character.toLowerCase(kind.charAt(0)) + kind.substring(1)).beginArray();
                for (var m : c.methods) {
                    if (has(m, kind + ";") && m.descriptor.equals("()V") && !m.isPrivate) {
                        json.value(m.name);
                    }
                }
                json.endArray();
            }
            json.endObject();
        }
        json.endArray();
        return json.endObject().toString();
    }

    /**
     * The class TeaVM starts a program from: `<package>.YukibanaEntry`, with
     * a static `main(String[])` that hands an instance of itself to
     * `yukibana.Launcher.start` (runner.js compiles that with the program),
     * and `run(String[])`, which calls the program's main as the JDK 25
     * launcher would: static or on a new instance, with or without the
     * arguments. Written as bytecode because a compact source file's class
     * (JEP 512) cannot be named from Java source, and the main may be
     * package-private, so the class goes into the main's package.
     */
    static byte[] makeEntry(String mainClass, boolean isStatic, boolean args) {
        var main = mainClass.replace('.', '/');
        int slash = main.lastIndexOf('/');
        var name = (slash < 0 ? "" : main.substring(0, slash + 1)) + "YukibanaEntry";
        // No COMPUTE_* flags, and a ClassWriter whose getCommonSuperClass is
        // overridden: ASM's own one uses Class.forName and throws
        // TypeNotPresentException, neither of which TeaVM's class library
        // has, and TeaVM refuses to compile code that can reach them.
        var w = new ClassWriter(0) {
            @Override
            protected String getCommonSuperClass(String type1, String type2) {
                return "java/lang/Object";
            }
        };
        w.visit(Opcodes.V1_8, Opcodes.ACC_PUBLIC | Opcodes.ACC_FINAL | Opcodes.ACC_SUPER, name, null,
                "java/lang/Object", new String[] {"yukibana/Launcher$Main"});
        var init = w.visitMethod(Opcodes.ACC_PUBLIC, "<init>", "()V", null, null);
        init.visitCode();
        init.visitVarInsn(Opcodes.ALOAD, 0);
        init.visitMethodInsn(Opcodes.INVOKESPECIAL, "java/lang/Object", "<init>", "()V", false);
        init.visitInsn(Opcodes.RETURN);
        init.visitMaxs(1, 1);
        init.visitEnd();
        var start = w.visitMethod(Opcodes.ACC_PUBLIC | Opcodes.ACC_STATIC, "main", "([Ljava/lang/String;)V", null,
                null);
        start.visitCode();
        start.visitVarInsn(Opcodes.ALOAD, 0);
        start.visitTypeInsn(Opcodes.NEW, name);
        start.visitInsn(Opcodes.DUP);
        start.visitMethodInsn(Opcodes.INVOKESPECIAL, name, "<init>", "()V", false);
        start.visitMethodInsn(Opcodes.INVOKESTATIC, "yukibana/Launcher", "start",
                "([Ljava/lang/String;Lyukibana/Launcher$Main;)V", false);
        start.visitInsn(Opcodes.RETURN);
        start.visitMaxs(3, 1);
        start.visitEnd();
        var run = w.visitMethod(Opcodes.ACC_PUBLIC, "run", "([Ljava/lang/String;)V", null,
                new String[] {"java/lang/Throwable"});
        run.visitCode();
        var descriptor = args ? "([Ljava/lang/String;)V" : "()V";
        if (isStatic) {
            if (args) {
                run.visitVarInsn(Opcodes.ALOAD, 1);
            }
            run.visitMethodInsn(Opcodes.INVOKESTATIC, main, "main", descriptor, false);
        } else {
            run.visitTypeInsn(Opcodes.NEW, main);
            run.visitInsn(Opcodes.DUP);
            run.visitMethodInsn(Opcodes.INVOKESPECIAL, main, "<init>", "()V", false);
            if (args) {
                run.visitVarInsn(Opcodes.ALOAD, 1);
            }
            run.visitMethodInsn(Opcodes.INVOKEVIRTUAL, main, "main", descriptor, false);
        }
        run.visitInsn(Opcodes.RETURN);
        run.visitMaxs(3, 2);
        run.visitEnd();
        w.visitEnd();
        return w.toByteArray();
    }

    private static boolean has(Method m, String simpleDescriptor) {
        return m.annotations.contains(JUPITER + simpleDescriptor)
                || m.annotations.contains("Lorg/junit/jupiter/params/" + simpleDescriptor);
    }
}
