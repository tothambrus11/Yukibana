package yk;

import org.jetbrains.org.objectweb.asm.*;
import java.io.*;
import java.util.*;
import java.util.zip.*;

/**
 * Copies a jar, dropping abstract redeclarations of Object's methods (equals, hashCode, toString)
 * from interfaces. They change nothing at run time, but GraalVM Web Image's single-abstract-method
 * check counts them and aborts the build on @FunctionalInterface interfaces that have them.
 */
public final class StripObjectMethods {
    static final Set<String> OBJ = Set.of("equals(Ljava/lang/Object;)Z", "hashCode()I", "toString()Ljava/lang/String;");

    public static void main(String[] a) throws IOException {
        int changed = 0;
        try (ZipInputStream in = new ZipInputStream(new FileInputStream(a[0]));
             ZipOutputStream out = new ZipOutputStream(new FileOutputStream(a[1]))) {
            for (ZipEntry e; (e = in.getNextEntry()) != null; ) {
                byte[] b = in.readAllBytes();
                if (e.getName().endsWith(".class")) {
                    byte[] nb = strip(b);
                    if (nb != b) { changed++; b = nb; }
                }
                out.putNextEntry(new ZipEntry(e.getName()));
                out.write(b);
                out.closeEntry();
            }
        }
        System.err.println("stripped Object methods from " + changed + " interfaces");
    }

    static byte[] strip(byte[] b) {
        ClassReader r = new ClassReader(b);
        if ((r.getAccess() & Opcodes.ACC_INTERFACE) == 0) return b;
        boolean[] hit = {false};
        ClassWriter w = new ClassWriter(0);
        r.accept(new ClassVisitor(Opcodes.ASM9, w) {
            @Override
            public MethodVisitor visitMethod(int acc, String name, String desc, String sig, String[] ex) {
                if ((acc & Opcodes.ACC_ABSTRACT) != 0 && OBJ.contains(name + desc)) { hit[0] = true; return null; }
                return super.visitMethod(acc, name, desc, sig, ex);
            }
        }, 0);
        return hit[0] ? w.toByteArray() : b;
    }
}
