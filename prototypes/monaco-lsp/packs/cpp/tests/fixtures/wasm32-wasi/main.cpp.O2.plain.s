	.file	"main.cpp"
	.globaltype	__stack_pointer, i32
	.functype	__original_main () -> (i32)
	.functype	printf (i32, i32) -> (i32)
	.functype	_Z8distanceRK5PointS1_ (i32, i32) -> (f64)
	.functype	__gxx_wasm_personality_v0 (i32) -> (i32)
	.functype	_ZNK5Point4normEv (i32) -> (f64)
	.functype	_Znwm (i32) -> (i32)
	.functype	_ZdlPvm (i32, i32) -> ()
	.functype	main (i32, i32) -> (i32)
	.functype	_Unwind_CallPersonality (i32) -> (i32)
	.section	.text.__original_main,"",@
	.hidden	__original_main                 # -- Begin function __original_main
	.globl	__original_main
	.type	__original_main,@function
__original_main:                        # @__original_main
.Lfunc_begin0:
	.functype	__original_main () -> (i32)
	.local  	i32, i32, i32, f64, exnref
# %bb.0:
	global.get	__stack_pointer
	i32.const	32
	i32.sub 
	local.tee	0
	global.set	__stack_pointer
	i32.const	32
	call	_Znwm
	local.tee	1
	i32.const	24
	i32.add 
	i32.const	0
	i64.load	.Lconstinit+24
	i64.store	0
	local.get	1
	i32.const	16
	i32.add 
	local.tee	2
	i32.const	0
	i64.load	.Lconstinit+16
	i64.store	0
	local.get	1
	i32.const	8
	i32.add 
	i32.const	0
	i64.load	.Lconstinit+8
	i64.store	0
	local.get	1
	i32.const	0
	i64.load	.Lconstinit
	i64.store	0
	block   	
	block   	exnref
	try_table 	 (catch_all_ref 0)      # 0: down to label1
.Ltmp0:
	local.get	1
	local.get	2
	call	_Z8distanceRK5PointS1_
	local.set	3
.Ltmp1:
# %bb.1:
	local.get	0
	local.get	3
	f64.store	16
	i32.const	.L.str
	local.get	0
	i32.const	16
	i32.add 
	call	printf
	drop
.Ltmp2:
	local.get	2
	call	_ZNK5Point4normEv
	local.set	3
.Ltmp3:
	br      	2                               # 2: down to label0
# %bb.2:
	end_try_table                           # label2:
	unreachable
.LBB0_3:
	end_block                               # label1:
.Ltmp4:
	local.set	4
	local.get	0
	global.set	__stack_pointer
	local.get	1
	i32.const	32
	call	_ZdlPvm
	local.get	4
	throw_ref
.LBB0_4:
	end_block                               # label0:
	local.get	0
	local.get	3
	f64.store	0
	i32.const	.L.str
	local.get	0
	call	printf
	drop
	local.get	1
	i32.const	32
	call	_ZdlPvm
	local.get	0
	i32.const	32
	i32.add 
	global.set	__stack_pointer
	i32.const	0
                                        # fallthrough-return
	end_function
.Lfunc_end0:
                                        # -- End function
	.section	.text.main,"",@
	.hidden	main                            # -- Begin function main
	.globl	main
	.type	main,@function
main:                                   # @main
	.functype	main (i32, i32) -> (i32)
# %bb.0:
	call	__original_main
                                        # fallthrough-return
	end_function
                                        # -- End function
	.type	.Lconstinit,@object             # @constinit
	.section	.rodata..Lconstinit,"",@
	.p2align	3, 0x0
.Lconstinit:
	.skip	16
	.int64	0x4008000000000000              # double 3
	.int64	0x4010000000000000              # double 4
	.size	.Lconstinit, 32

	.type	.L.str,@object                  # @.str
	.section	.rodata..L.str,"S",@
.L.str:
	.asciz	"%f\n"
	.size	.L.str, 4

	.globl	__main_void
	.type	__main_void,@function
	.hidden	__main_void
__main_void = __original_main
	.ident	"clang version 21.1.8"
	.no_dead_strip	__indirect_function_table
	.size	__wasm_lpad_context, 12
	.section	.custom_section.producers,"",@
	.int8	1
	.int8	12
	.ascii	"processed-by"
	.int8	1
	.int8	5
	.ascii	"clang"
	.int8	6
	.ascii	"21.1.8"
	.section	.rodata..L.str,"S",@
	.section	.custom_section.target_features,"",@
	.int8	10
	.int8	43
	.int8	11
	.ascii	"bulk-memory"
	.int8	43
	.int8	15
	.ascii	"bulk-memory-opt"
	.int8	43
	.int8	22
	.ascii	"call-indirect-overlong"
	.int8	43
	.int8	18
	.ascii	"exception-handling"
	.int8	43
	.int8	10
	.ascii	"multivalue"
	.int8	43
	.int8	15
	.ascii	"mutable-globals"
	.int8	43
	.int8	19
	.ascii	"nontrapping-fptoint"
	.int8	43
	.int8	15
	.ascii	"reference-types"
	.int8	43
	.int8	8
	.ascii	"sign-ext"
	.int8	45
	.int8	10
	.ascii	"shared-mem"
	.section	.rodata..L.str,"S",@
