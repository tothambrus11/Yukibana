	.file	"geometry.cpp"
	.text
	.globl	_ZNK5Point4normEv               # -- Begin function _ZNK5Point4normEv
	.p2align	4
	.type	_ZNK5Point4normEv,@function
_ZNK5Point4normEv:                      # @_ZNK5Point4normEv
	.cfi_startproc
# %bb.0:
	movsd	(%rdi), %xmm0                   # xmm0 = mem[0],zero
	movsd	8(%rdi), %xmm1                  # xmm1 = mem[0],zero
	jmp	hypot@PLT                       # TAILCALL
.Lfunc_end0:
	.size	_ZNK5Point4normEv, .Lfunc_end0-_ZNK5Point4normEv
	.cfi_endproc
                                        # -- End function
	.globl	_Z8distanceRK5PointS1_          # -- Begin function _Z8distanceRK5PointS1_
	.p2align	4
	.type	_Z8distanceRK5PointS1_,@function
_Z8distanceRK5PointS1_:                 # @_Z8distanceRK5PointS1_
	.cfi_startproc
# %bb.0:
	movsd	(%rdi), %xmm0                   # xmm0 = mem[0],zero
	movsd	8(%rdi), %xmm1                  # xmm1 = mem[0],zero
	subsd	(%rsi), %xmm0
	subsd	8(%rsi), %xmm1
	jmp	hypot@PLT                       # TAILCALL
.Lfunc_end1:
	.size	_Z8distanceRK5PointS1_, .Lfunc_end1-_Z8distanceRK5PointS1_
	.cfi_endproc
                                        # -- End function
	.ident	"clang version 21.1.8"
	.section	".note.GNU-stack","",@progbits
	.addrsig
