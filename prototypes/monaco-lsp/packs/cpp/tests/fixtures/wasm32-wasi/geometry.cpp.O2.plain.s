	.file	"geometry.cpp"
	.functype	_ZNK5Point4normEv (i32) -> (f64)
	.functype	hypot (f64, f64) -> (f64)
	.functype	_Z8distanceRK5PointS1_ (i32, i32) -> (f64)
	.section	.text._ZNK5Point4normEv,"",@
	.hidden	_ZNK5Point4normEv               # -- Begin function _ZNK5Point4normEv
	.globl	_ZNK5Point4normEv
	.type	_ZNK5Point4normEv,@function
_ZNK5Point4normEv:                      # @_ZNK5Point4normEv
	.functype	_ZNK5Point4normEv (i32) -> (f64)
# %bb.0:
	local.get	0
	f64.load	0
	local.get	0
	f64.load	8
	call	hypot
                                        # fallthrough-return
	end_function
                                        # -- End function
	.section	.text._Z8distanceRK5PointS1_,"",@
	.hidden	_Z8distanceRK5PointS1_          # -- Begin function _Z8distanceRK5PointS1_
	.globl	_Z8distanceRK5PointS1_
	.type	_Z8distanceRK5PointS1_,@function
_Z8distanceRK5PointS1_:                 # @_Z8distanceRK5PointS1_
	.functype	_Z8distanceRK5PointS1_ (i32, i32) -> (f64)
# %bb.0:
	local.get	0
	f64.load	0
	local.get	1
	f64.load	0
	f64.sub 
	local.get	0
	f64.load	8
	local.get	1
	f64.load	8
	f64.sub 
	call	hypot
                                        # fallthrough-return
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
