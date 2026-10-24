	.file	"main.cpp"
	.text
	.globl	main                            // -- Begin function main
	.p2align	2
	.type	main,@function
main:                                   // @main
.Lfunc_begin0:
	.cfi_startproc
	.cfi_personality 156, DW.ref.__gxx_personality_v0
	.cfi_lsda 28, .Lexception0
// %bb.0:
	stp	x29, x30, [sp, #-32]!           // 16-byte Folded Spill
	.cfi_def_cfa_offset 32
	stp	x20, x19, [sp, #16]             // 16-byte Folded Spill
	mov	x29, sp
	.cfi_def_cfa w29, 32
	.cfi_offset w19, -8
	.cfi_offset w20, -16
	.cfi_offset w30, -24
	.cfi_offset w29, -32
	.cfi_remember_state
	mov	w0, #32                         // =0x20
	bl	_Znwm
	adrp	x8, .Lconstinit
	add	x8, x8, :lo12:.Lconstinit
	mov	x19, x0
	ldp	q0, q1, [x8]
	stp	q0, q1, [x0]
.Ltmp0:
	add	x1, x0, #16
	bl	_Z8distanceRK5PointS1_
.Ltmp1:
// %bb.1:
	adrp	x0, .L.str
	add	x0, x0, :lo12:.L.str
	bl	printf
.Ltmp2:
	add	x0, x19, #16
	bl	_ZNK5Point4normEv
.Ltmp3:
// %bb.2:
	adrp	x0, .L.str
	add	x0, x0, :lo12:.L.str
	bl	printf
	mov	x0, x19
	mov	w1, #32                         // =0x20
	bl	_ZdlPvm
	mov	w0, wzr
	.cfi_def_cfa wsp, 32
	ldp	x20, x19, [sp, #16]             // 16-byte Folded Reload
	ldp	x29, x30, [sp], #32             // 16-byte Folded Reload
	.cfi_def_cfa_offset 0
	.cfi_restore w19
	.cfi_restore w20
	.cfi_restore w30
	.cfi_restore w29
	ret
.LBB0_3:
	.cfi_restore_state
.Ltmp4:
	mov	x20, x0
	mov	x0, x19
	mov	w1, #32                         // =0x20
	bl	_ZdlPvm
	mov	x0, x20
	bl	_Unwind_Resume
.Lfunc_end0:
	.size	main, .Lfunc_end0-main
	.cfi_endproc
	.section	.gcc_except_table,"a",@progbits
	.p2align	2, 0x0
GCC_except_table0:
.Lexception0:
	.byte	255                             // @LPStart Encoding = omit
	.byte	255                             // @TType Encoding = omit
	.byte	1                               // Call site Encoding = uleb128
	.uleb128 .Lcst_end0-.Lcst_begin0
.Lcst_begin0:
	.uleb128 .Lfunc_begin0-.Lfunc_begin0    // >> Call Site 1 <<
	.uleb128 .Ltmp0-.Lfunc_begin0           //   Call between .Lfunc_begin0 and .Ltmp0
	.byte	0                               //     has no landing pad
	.byte	0                               //   On action: cleanup
	.uleb128 .Ltmp0-.Lfunc_begin0           // >> Call Site 2 <<
	.uleb128 .Ltmp3-.Ltmp0                  //   Call between .Ltmp0 and .Ltmp3
	.uleb128 .Ltmp4-.Lfunc_begin0           //     jumps to .Ltmp4
	.byte	0                               //   On action: cleanup
	.uleb128 .Ltmp3-.Lfunc_begin0           // >> Call Site 3 <<
	.uleb128 .Lfunc_end0-.Ltmp3             //   Call between .Ltmp3 and .Lfunc_end0
	.byte	0                               //     has no landing pad
	.byte	0                               //   On action: cleanup
.Lcst_end0:
	.p2align	2, 0x0
                                        // -- End function
	.type	.Lconstinit,@object             // @constinit
	.section	.rodata.cst32,"aM",@progbits,32
	.p2align	3, 0x0
.Lconstinit:
	.zero	16
	.xword	0x4008000000000000              // double 3
	.xword	0x4010000000000000              // double 4
	.size	.Lconstinit, 32

	.type	.L.str,@object                  // @.str
	.section	.rodata.str1.1,"aMS",@progbits,1
.L.str:
	.asciz	"%f\n"
	.size	.L.str, 4

	.hidden	DW.ref.__gxx_personality_v0
	.weak	DW.ref.__gxx_personality_v0
	.section	.data.DW.ref.__gxx_personality_v0,"awG",@progbits,DW.ref.__gxx_personality_v0,comdat
	.p2align	3, 0x0
	.type	DW.ref.__gxx_personality_v0,@object
	.size	DW.ref.__gxx_personality_v0, 8
DW.ref.__gxx_personality_v0:
	.xword	__gxx_personality_v0
	.ident	"clang version 21.1.8"
	.section	".note.GNU-stack","",@progbits
	.addrsig
	.addrsig_sym __gxx_personality_v0
	.addrsig_sym _Unwind_Resume
