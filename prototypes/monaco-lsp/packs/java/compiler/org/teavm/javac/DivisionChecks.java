/*
 * Yukibana Java pack: ArithmeticException for integer division by zero in
 * what TeaVM compiles to WebAssembly GC, which otherwise traps (see
 * classlib/.../CheckedDivision.java).
 *
 * Installed twice: by Compiler.generateWebAssembly (through
 * BootstrapDependencies) for the programs the browser builds, and, through
 * META-INF/services/org.teavm.vm.spi.TeaVMPlugin (written by build.sh), by
 * the Gradle build of compiler.wasm itself.
 */
package org.teavm.javac;

import org.teavm.model.BasicBlock;
import org.teavm.model.ClassHolder;
import org.teavm.model.ClassHolderTransformer;
import org.teavm.model.ClassHolderTransformerContext;
import org.teavm.model.Instruction;
import org.teavm.model.MethodReference;
import org.teavm.model.ValueType;
import org.teavm.model.instructions.BinaryInstruction;
import org.teavm.model.instructions.BinaryOperation;
import org.teavm.model.instructions.InvocationType;
import org.teavm.model.instructions.InvokeInstruction;
import org.teavm.model.instructions.NumericOperandType;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

public class DivisionChecks implements TeaVMPlugin, ClassHolderTransformer {
    private static final String HELPER = "org.teavm.classlib.impl.CheckedDivision";

    @Override
    public void install(TeaVMHost host) {
        host.add(this);
    }

    @Override
    public void transformClass(ClassHolder cls, ClassHolderTransformerContext context) {
        if (cls.getName().equals(HELPER)) {
            return;
        }
        for (var method : cls.getMethods()) {
            var program = method.getProgram();
            if (program == null) {
                continue;
            }
            for (int i = 0; i < program.basicBlockCount(); i++) {
                transform(program.basicBlockAt(i));
            }
        }
    }

    private static void transform(BasicBlock block) {
        for (Instruction insn = block.getFirstInstruction(); insn != null; ) {
            var next = insn.getNext();
            if (insn instanceof BinaryInstruction binary) {
                var op = binary.getOperation();
                var type = binary.getOperandType();
                if ((op == BinaryOperation.DIVIDE || op == BinaryOperation.MODULO)
                        && (type == NumericOperandType.INT || type == NumericOperandType.LONG)) {
                    var valueType = type == NumericOperandType.INT ? ValueType.INTEGER : ValueType.LONG;
                    var call = new InvokeInstruction();
                    call.setType(InvocationType.SPECIAL);
                    call.setMethod(new MethodReference(HELPER, op == BinaryOperation.DIVIDE ? "divide" : "remainder",
                            valueType, valueType, valueType));
                    call.setArguments(binary.getFirstOperand(), binary.getSecondOperand());
                    call.setReceiver(binary.getReceiver());
                    call.setLocation(binary.getLocation());
                    binary.replace(call);
                }
            }
            insn = next;
        }
    }
}
