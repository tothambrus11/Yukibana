	.file	"geometry.cpp"
	.text
	.globl	_ZNK5Point4normEv               // -- Begin function _ZNK5Point4normEv
	.p2align	2
	.type	_ZNK5Point4normEv,@function
_ZNK5Point4normEv:                      // @_ZNK5Point4normEv
	.cfi_startproc
// %bb.0:
	ldp	d0, d1, [x0]
	b	hypot
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
	ldp	d0, d1, [x0]
	ldp	d2, d3, [x1]
	fsub	d0, d0, d2
	fsub	d1, d1, d3
	b	hypot
.Lfunc_end1:
	.size	_Z8distanceRK5PointS1_, .Lfunc_end1-_Z8distanceRK5PointS1_
	.cfi_endproc
                                        // -- End function
	.ident	"clang version 21.1.8"
	.section	".note.GNU-stack","",@progbits
	.addrsig
