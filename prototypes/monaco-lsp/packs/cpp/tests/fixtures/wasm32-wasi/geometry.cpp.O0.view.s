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
.Lfunc_begin0:
	.file	1 "/workspace" "geometry.cpp"
	.loc	1 5 0                           # geometry.cpp:5:0
	.functype	_ZNK5Point4normEv (i32) -> (f64)
	.local  	i32, i32, f64
# %bb.0:                                # %entry
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
.Ltmp0:
	.loc	1 5 48 prologue_end             # geometry.cpp:5:48
	local.get	2
	f64.load	0
	.loc	1 5 51 is_stmt 0                # geometry.cpp:5:51
	local.get	2
	f64.load	8
	.loc	1 5 37                          # geometry.cpp:5:37
	call	hypot
	local.set	3
	.loc	1 5 30                          # geometry.cpp:5:30
	local.get	1
	i32.const	16
	i32.add 
	global.set	__stack_pointer
	local.get	3
	return
	end_function
.Ltmp1:
.Lfunc_end0:
                                        # -- End function
	.section	.text._Z8distanceRK5PointS1_,"",@
	.hidden	_Z8distanceRK5PointS1_          # -- Begin function _Z8distanceRK5PointS1_
	.globl	_Z8distanceRK5PointS1_
	.type	_Z8distanceRK5PointS1_,@function
_Z8distanceRK5PointS1_:                 # @_Z8distanceRK5PointS1_
.Lfunc_begin1:
	.loc	1 7 0 is_stmt 1                 # geometry.cpp:7:0
	.functype	_Z8distanceRK5PointS1_ (i32, i32) -> (f64)
	.local  	i32, f64
# %bb.0:                                # %entry
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
.Ltmp2:
	.loc	1 8 23 prologue_end             # geometry.cpp:8:23
	local.get	2
	i32.load	12
	.loc	1 8 25 is_stmt 0                # geometry.cpp:8:25
	f64.load	0
	.loc	1 8 29                          # geometry.cpp:8:29
	local.get	2
	i32.load	8
	.loc	1 8 31                          # geometry.cpp:8:31
	f64.load	0
	.loc	1 8 27                          # geometry.cpp:8:27
	f64.sub 
	.loc	1 8 34                          # geometry.cpp:8:34
	local.get	2
	i32.load	12
	.loc	1 8 36                          # geometry.cpp:8:36
	f64.load	8
	.loc	1 8 40                          # geometry.cpp:8:40
	local.get	2
	i32.load	8
	.loc	1 8 42                          # geometry.cpp:8:42
	f64.load	8
	.loc	1 8 38                          # geometry.cpp:8:38
	f64.sub 
	.loc	1 8 12                          # geometry.cpp:8:12
	call	hypot
	local.set	3
	.loc	1 8 5                           # geometry.cpp:8:5
	local.get	2
	i32.const	16
	i32.add 
	global.set	__stack_pointer
	local.get	3
	return
	end_function
.Ltmp3:
.Lfunc_end1:
                                        # -- End function
	.section	.debug_abbrev,"",@
	.int8	1                               # Abbreviation Code
	.int8	17                              # DW_TAG_compile_unit
	.int8	0                               # DW_CHILDREN_no
	.int8	37                              # DW_AT_producer
	.int8	14                              # DW_FORM_strp
	.int8	19                              # DW_AT_language
	.int8	5                               # DW_FORM_data2
	.int8	3                               # DW_AT_name
	.int8	14                              # DW_FORM_strp
	.int8	16                              # DW_AT_stmt_list
	.int8	23                              # DW_FORM_sec_offset
	.int8	27                              # DW_AT_comp_dir
	.int8	14                              # DW_FORM_strp
	.int8	17                              # DW_AT_low_pc
	.int8	1                               # DW_FORM_addr
	.int8	85                              # DW_AT_ranges
	.int8	23                              # DW_FORM_sec_offset
	.int8	0                               # EOM(1)
	.int8	0                               # EOM(2)
	.int8	0                               # EOM(3)
	.section	.debug_info,"",@
.Lcu_begin0:
	.int32	.Ldebug_info_end0-.Ldebug_info_start0 # Length of Unit
.Ldebug_info_start0:
	.int16	4                               # DWARF version number
	.int32	.debug_abbrev0                  # Offset Into Abbrev. Section
	.int8	4                               # Address Size (in bytes)
	.int8	1                               # Abbrev [1] 0xb:0x1b DW_TAG_compile_unit
	.int32	.Linfo_string0                  # DW_AT_producer
	.int16	33                              # DW_AT_language
	.int32	.Linfo_string1                  # DW_AT_name
	.int32	.Lline_table_start0             # DW_AT_stmt_list
	.int32	.Linfo_string2                  # DW_AT_comp_dir
	.int32	0                               # DW_AT_low_pc
	.int32	.Ldebug_ranges0                 # DW_AT_ranges
.Ldebug_info_end0:
	.section	.debug_ranges,"",@
.Ldebug_ranges0:
	.int32	.Lfunc_begin0
	.int32	.Lfunc_end0
	.int32	.Lfunc_begin1
	.int32	.Lfunc_end1
	.int32	0
	.int32	0
	.section	.debug_str,"S",@
.Linfo_string0:
	.asciz	"clang version 21.1.8"          # string offset=0
.Linfo_string1:
	.asciz	"geometry.cpp"                  # string offset=21
.Linfo_string2:
	.asciz	"/workspace"                    # string offset=34
	.ident	"clang version 21.1.8"
	.section	.custom_section.producers,"",@
	.int8	2
	.int8	8
	.ascii	"language"
	.int8	1
	.int8	14
	.ascii	"C_plus_plus_14"
	.int8	0
	.int8	12
	.ascii	"processed-by"
	.int8	1
	.int8	5
	.ascii	"clang"
	.int8	6
	.ascii	"21.1.8"
	.section	.debug_str,"S",@
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
	.section	.debug_str,"S",@
	.section	.debug_line,"",@
.Lline_table_start0:
