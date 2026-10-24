	.file	"geometry.cpp"
	.globaltype	__stack_pointer, i32
	.functype	_ZNK5Point4normEv (i32) -> (f64)
	.functype	hypot (f64, f64) -> (f64)
	.functype	_Z8distanceRK5PointS1_ (i32, i32) -> (f64)
	.section	.text._ZNK5Point4normEv,"",@
	.hidden	_ZNK5Point4normEv               # -- Begin function _ZNK5Point4normEv
	.globl	_ZNK5Point4normEv
	.type	_ZNK5Point4normEv,@function
_ZNK5Point4normEv:                      # @_ZNK5Point4normEv
	.functype	_ZNK5Point4normEv (i32) -> (f64)
	.local  	i32, i32, f64
# %bb.0:
	global.get	__stack_pointer
	i32.const	16
	i32.sub 
	local.set	1
	local.get	1
	global.set	__stack_pointer
	local.get	1
	local.get	0
	i32.store	12
	local.get	1
	i32.load	12
	local.set	2
	local.get	2
	f64.load	0
	local.get	2
	f64.load	8
	call	hypot
	local.set	3
	local.get	1
	i32.const	16
	i32.add 
	global.set	__stack_pointer
	local.get	3
	return
	end_function
                                        # -- End function
	.section	.text._Z8distanceRK5PointS1_,"",@
	.hidden	_Z8distanceRK5PointS1_          # -- Begin function _Z8distanceRK5PointS1_
	.globl	_Z8distanceRK5PointS1_
	.type	_Z8distanceRK5PointS1_,@function
_Z8distanceRK5PointS1_:                 # @_Z8distanceRK5PointS1_
	.functype	_Z8distanceRK5PointS1_ (i32, i32) -> (f64)
	.local  	i32, f64
# %bb.0:
	global.get	__stack_pointer
	i32.const	16
	i32.sub 
	local.set	2
	local.get	2
	global.set	__stack_pointer
	local.get	2
	local.get	0
	i32.store	12
	local.get	2
	local.get	1
	i32.store	8
	local.get	2
	i32.load	12
	f64.load	0
	local.get	2
	i32.load	8
	f64.load	0
	f64.sub 
	local.get	2
	i32.load	12
	f64.load	8
	local.get	2
	i32.load	8
	f64.load	8
	f64.sub 
	call	hypot
	local.set	3
	local.get	2
	i32.const	16
	i32.add 
	global.set	__stack_pointer
	local.get	3
	return
	end_function
                                        # -- End function
	.ident	"clang version 21.1.8"
	.section	.custom_section.producers,"",@
	.int8	1
	.int8	12
	.ascii	"processed-by"
	.int8	1
	.int8	5
	.ascii	"clang"
	.int8	6
	.ascii	"21.1.8"
	.section	.text._Z8distanceRK5PointS1_,"",@
	.section	.custom_section.target_features,"",@
	.int8	9
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
	.section	.text._Z8distanceRK5PointS1_,"",@
