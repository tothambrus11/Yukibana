	.attribute	4, 16
	.attribute	5, "rv64i2p1_m2p0_a2p1_f2p2_d2p2_c2p0_zicsr2p0_zmmul1p0_zaamo1p0_zalrsc1p0_zca1p0_zcd1p0"
	.file	"geometry.cpp"
	.text
	.globl	_ZNK5Point4normEv               # -- Begin function _ZNK5Point4normEv
	.p2align	1
	.type	_ZNK5Point4normEv,@function
_ZNK5Point4normEv:                      # @_ZNK5Point4normEv
	.cfi_startproc
# %bb.0:
	fld	fa0, 0(a0)
	fld	fa1, 8(a0)
	tail	hypot
.Lfunc_end0:
	.size	_ZNK5Point4normEv, .Lfunc_end0-_ZNK5Point4normEv
	.cfi_endproc
                                        # -- End function
	.globl	_Z8distanceRK5PointS1_          # -- Begin function _Z8distanceRK5PointS1_
	.p2align	1
	.type	_Z8distanceRK5PointS1_,@function
_Z8distanceRK5PointS1_:                 # @_Z8distanceRK5PointS1_
	.cfi_startproc
# %bb.0:
	fld	fa5, 0(a0)
	fld	fa4, 8(a0)
	fld	fa3, 0(a1)
	fld	fa2, 8(a1)
	fsub.d	fa0, fa5, fa3
	fsub.d	fa1, fa4, fa2
	tail	hypot
.Lfunc_end1:
	.size	_Z8distanceRK5PointS1_, .Lfunc_end1-_Z8distanceRK5PointS1_
	.cfi_endproc
                                        # -- End function
	.ident	"clang version 21.1.8"
	.section	".note.GNU-stack","",@progbits
	.addrsig
