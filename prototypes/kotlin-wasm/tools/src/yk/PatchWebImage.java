package yk;

import org.jetbrains.org.objectweb.asm.*;
import java.nio.file.*;

/**
 * Web Image (GraalVM 25.1 EA) has no support method for the UNSTRUCTURED_LOCKING bytecode
 * exception, and aborts the build when a reachable method has one. Maps it to the
 * IncompatibleClassChangeError support method instead: the path only runs when monitors are
 * misused, which correct code never does.
 */
public final class PatchWebImage {
    public static void main(String[] a) throws Exception {
        byte[] in = Files.readAllBytes(Path.of(a[0]));
        ClassReader r = new ClassReader(in);
        ClassWriter w = new ClassWriter(r, ClassWriter.COMPUTE_FRAMES) {
            @Override protected String getCommonSuperClass(String x, String y) { return "java/lang/Object"; }
        };
        r.accept(new ClassVisitor(Opcodes.ASM9, w) {
            @Override
            public MethodVisitor visitMethod(int acc, String name, String desc, String sig, String[] ex) {
                MethodVisitor mv = super.visitMethod(acc, name, desc, sig, ex);
                if (!name.equals("getSupportMethodName")) return mv;
                return new MethodVisitor(Opcodes.ASM9, mv) {
                    @Override
                    public void visitMethodInsn(int op, String owner, String n, String d, boolean itf) {
                        if (n.equals("shouldNotReachHereUnexpectedValue")) {
                            super.visitInsn(Opcodes.POP);
                            super.visitLdcInsn("createNewIncompatibleClassChangeError");
                            super.visitInsn(Opcodes.ARETURN);
                            System.err.println("patched " + name);
                        }
                        super.visitMethodInsn(op, owner, n, d, itf);
                    }
                };
            }
        }, 0);
        Files.write(Path.of(a[1]), w.toByteArray());
    }
}
