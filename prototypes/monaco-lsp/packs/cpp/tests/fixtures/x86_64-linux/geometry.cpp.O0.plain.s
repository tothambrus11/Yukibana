	.file	"geometry.cpp"
	.text
	.globl	_ZNK5Point4normEv               # -- Begin function _ZNK5Point4normEv
	.p2align	4
	.type	_ZNK5Point4normEv,@function
_ZNK5Point4normEv:                      # @_ZNK5Point4normEv
	.cfi_startproc
# %bb.0:
	pushq	%rbp
	.cfi_def_cfa_offset 16
	.cfi_offset %rbp, -16
	movq	%rsp, %rbp
	.cfi_def_cfa_register %rbp
	subq	$16, %rsp
	movq	%rdi, -8(%rbp)
	movq	-8(%rbp), %rax
	movsd	(%rax), %xmm0                   # xmm0 = mem[0],zero
	movsd	8(%rax), %xmm1                  # xmm1 = mem[0],zero
	callq	hypot@PLT
	addq	$16, %rsp
	popq	%rbp
	.cfi_def_cfa %rsp, 8
	retq
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
	pushq	%rbp
	.cfi_def_cfa_offset 16
	.cfi_offset %rbp, -16
	movq	%rsp, %rbp
	.cfi_def_cfa_register %rbp
	subq	$16, %rsp
	movq	%rdi, -8(%rbp)
	movq	%rsi, -16(%rbp)
	movq	-8(%rbp), %rax
	movsd	(%rax), %xmm0                   # xmm0 = mem[0],zero
	movq	-16(%rbp), %rax
	subsd	(%rax), %xmm0
	movq	-8(%rbp), %rax
	movsd	8(%rax), %xmm1                  # xmm1 = mem[0],zero
	movq	-16(%rbp), %rax
	subsd	8(%rax), %xmm1
	callq	hypot@PLT
	addq	$16, %rsp
	popq	%rbp
	.cfi_def_cfa %rsp, 8
	retq
.Lfunc_end1:
	.size	_Z8distanceRK5PointS1_, .Lfunc_end1-_Z8distanceRK5PointS1_
	.cfi_endproc
                                        # -- End function
	.ident	"clang version 21.1.8"
	.section	".note.GNU-stack","",@progbits
	.addrsig
	.addrsig_sym hypot
