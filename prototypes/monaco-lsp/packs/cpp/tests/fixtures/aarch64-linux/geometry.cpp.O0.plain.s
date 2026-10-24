	.file	"geometry.cpp"
	.text
	.globl	_ZNK5Point4normEv               // -- Begin function _ZNK5Point4normEv
	.p2align	2
	.type	_ZNK5Point4normEv,@function
_ZNK5Point4normEv:                      // @_ZNK5Point4normEv
	.cfi_startproc
// %bb.0:
	sub	sp, sp, #32
	.cfi_def_cfa_offset 32
	stp	x29, x30, [sp, #16]             // 16-byte Folded Spill
	add	x29, sp, #16
	.cfi_def_cfa w29, 16
	.cfi_offset w30, -8
	.cfi_offset w29, -16
	str	x0, [sp, #8]
	ldr	x8, [sp, #8]
	ldr	d0, [x8]
	ldr	d1, [x8, #8]
	bl	hypot
	.cfi_def_cfa wsp, 32
	ldp	x29, x30, [sp, #16]             // 16-byte Folded Reload
	add	sp, sp, #32
	.cfi_def_cfa_offset 0
	.cfi_restore w30
	.cfi_restore w29
	ret
.Lfunc_end0:
	.size	_ZNK5Point4normEv, .Lfunc_end0-_ZNK5Point4normEv
	.cfi_endproc
                                        // -- End function
	.globl	_Z8distanceRK5PointS1_          // -- Begin function _Z8distanceRK5PointS1_
	.p2align	2
	.type	_Z8distanceRK5PointS1_,@function
_Z8distanceRK5PointS1_:                 // @_Z8distanceRK5PointS1_
	.cfi_startproc
// %bb.0:
	sub	sp, sp, #32
	.cfi_def_cfa_offset 32
	stp	x29, x30, [sp, #16]             // 16-byte Folded Spill
	add	x29, sp, #16
	.cfi_def_cfa w29, 16
	.cfi_offset w30, -8
	.cfi_offset w29, -16
	str	x0, [sp, #8]
	str	x1, [sp]
	ldr	x8, [sp, #8]
	ldr	d0, [x8]
	ldr	x8, [sp]
	ldr	d1, [x8]
	fsub	d0, d0, d1
	ldr	x8, [sp, #8]
	ldr	d1, [x8, #8]
	ldr	x8, [sp]
	ldr	d2, [x8, #8]
	fsub	d1, d1, d2
	bl	hypot
	.cfi_def_cfa wsp, 32
	ldp	x29, x30, [sp, #16]             // 16-byte Folded Reload
	add	sp, sp, #32
	.cfi_def_cfa_offset 0
	.cfi_restore w30
	.cfi_restore w29
	ret
.Lfunc_end1:
	.size	_Z8distanceRK5PointS1_, .Lfunc_end1-_Z8distanceRK5PointS1_
	.cfi_endproc
                                        // -- End function
	.ident	"clang version 21.1.8"
	.section	".note.GNU-stack","",@progbits
	.addrsig
	.addrsig_sym hypot
