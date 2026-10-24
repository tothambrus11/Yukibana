package yk;

import org.jetbrains.org.objectweb.asm.*;
import java.io.*;
import java.util.*;
import java.util.zip.*;

/**
 * Prints reachability metadata registering the fields of every class that a method hands to
 * Atomic{Reference,Integer,Long}FieldUpdater.newUpdater, found by the class constants the calling
 * method loads. Web Image resolves those fields reflectively at run time.
 */
public final class FindUpdaters {
    public static void main(String[] jars) throws IOException {
        Set<String> types = new TreeSet<>();
        for (String jar : jars) {
            try (ZipInputStream in = new ZipInputStream(new FileInputStream(jar))) {
                for (ZipEntry e; (e = in.getNextEntry()) != null; ) {
                    if (!e.getName().endsWith(".class")) continue;
                    new ClassReader(in.readAllBytes()).accept(new ClassVisitor(Opcodes.ASM9) {
                        @Override
                        public MethodVisitor visitMethod(int a, String n, String d, String s, String[] x) {
                            return new MethodVisitor(Opcodes.ASM9) {
                                final List<String> consts = new ArrayList<>();
                                boolean uses;
                                @Override public void visitLdcInsn(Object v) {
                                    if (v instanceof Type t && t.getSort() == Type.OBJECT) consts.add(t.getClassName());
                                }
                                @Override public void visitMethodInsn(int op, String owner, String name, String desc, boolean itf) {
                                    if (name.equals("newUpdater") && owner.startsWith("java/util/concurrent/atomic/")) uses = true;
                                }
                                @Override public void visitEnd() { if (uses) types.addAll(consts); }
                            };
                        }
                    }, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
                }
            }
        }
        StringBuilder b = new StringBuilder("{\"reflection\":[\n");
        String sep = "";
        for (String t : types) {
            if (t.startsWith("java.lang.") && !t.contains("$")) continue;
            b.append(sep).append("{\"type\":\"").append(t).append("\",\"allDeclaredFields\":true}");
            sep = ",\n";
        }
        System.out.println(b.append("\n]}"));
        System.err.println(types.size() + " types");
    }
}
