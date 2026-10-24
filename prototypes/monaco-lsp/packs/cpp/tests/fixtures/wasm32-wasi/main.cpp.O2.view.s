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
	.file	1 "/workspace" "main.cpp"
	.loc	1 6 0                           # main.cpp:6:0
	.functype	__original_main () -> (i32)
	.local  	i32, i32, i32, f64, exnref
# %bb.0:                                # %_ZNSt3__219__allocate_at_leastB8fe210108INS_9allocatorI5PointEEEENS_19__allocation_resultINS_16allocator_traitsIT_E7pointerEEERS6_m.exit.i.i.i
	global.get	__stack_pointer
	i32.const	32
	i32.sub 
	local.tee	0
	global.set	__stack_pointer
	i32.const	32
.Ltmp5:
	.file	2 "/wasi/include/wasm32-wasip1/c++/v1/__new" "allocate.h"
	.loc	2 43 28 prologue_end            # /wasi/include/wasm32-wasip1/c++/v1/__new/allocate.h:43:28 @[ /wasi/include/wasm32-wasip1/c++/v1/__memory/allocator.h:105:14 @[ /wasi/include/wasm32-wasip1/c++/v1/__memory/allocate_at_least.h:41:19 @[ /wasi/include/wasm32-wasip1/c++/v1/__vector/vector.h:574:25 @[ /wasi/include/wasm32-wasip1/c++/v1/__vector/vector.h:592:7 @[ /wasi/include/wasm32-wasip1/c++/v1/__vector/vector.h:277:5 @[ main.cpp:7:24 ] ] ] ] ] ]
	call	_Znwm
.Ltmp6:
	.loc	2 0 28 is_stmt 0                # /wasi/include/wasm32-wasip1/c++/v1/__new/allocate.h:0:28
	local.tee	1
	i32.const	24
.Ltmp7:
	.file	3 "/wasi/include/wasm32-wasip1/c++/v1/__memory" "construct_at.h"
	.loc	3 38 49 is_stmt 1               # /wasi/include/wasm32-wasip1/c++/v1/__memory/construct_at.h:38:49 @[ /wasi/include/wasm32-wasip1/c++/v1/__memory/construct_at.h:46:10 @[ /wasi/include/wasm32-wasip1/c++/v1/__memory/allocator_traits.h:302:5 @[ /wasi/include/wasm32-wasip1/c++/v1/__memory/uninitialized_algorithms.h:543:5 @[ /wasi/include/wasm32-wasip1/c++/v1/__memory/uninitialized_algorithms.h:582:28 @[ /wasi/include/wasm32-wasip1/c++/v1/__vector/vector.h:945:17 @[ /wasi/include/wasm32-wasip1/c++/v1/__vector/vector.h:593:7 @[ /wasi/include/wasm32-wasip1/c++/v1/__vector/vector.h:277:5 @[ main.cpp:7:24 ] ] ] ] ] ] ] ]
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
.Ltmp8:
	.loc	1 8 25                          # main.cpp:8:25
	block   	
	block   	exnref
	try_table 	 (catch_all_ref 0)      # 0: down to label1
.Ltmp0:
	local.get	1
	local.get	2
	call	_Z8distanceRK5PointS1_
.Ltmp9:
	local.set	3
.Ltmp1:
# %bb.1:                                # %_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit31
	.loc	1 8 5 is_stmt 0                 # main.cpp:8:5
	local.get	0
	local.get	3
	f64.store	16
	i32.const	.L.str
	local.get	0
	i32.const	16
	i32.add 
	call	printf
.Ltmp10:
	drop
.Ltmp2:
	.loc	1 9 35 is_stmt 1                # main.cpp:9:35
	local.get	2
	call	_ZNK5Point4normEv
.Ltmp11:
	local.set	3
.Ltmp3:
	br      	2                               # 2: down to label0
# %bb.2:
	.loc	1 0 35 is_stmt 0                # main.cpp:0:35
	end_try_table                           # label2:
	unreachable
.LBB0_3:                                # %_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit41
	end_block                               # label1:
.Ltmp4:
.Ltmp12:
	.loc	2 63 10 is_stmt 1               # /wasi/include/wasm32-wasip1/c++/v1/__new/allocate.h:63:10 @[ /wasi/include/wasm32-wasip1/c++/v1/__memory/allocator.h:120:7 @[ /wasi/include/wasm32-wasip1/c++/v1/__memory/allocator_traits.h:289:9 @[ /wasi/include/wasm32-wasip1/c++/v1/__vector/vector.h:253:9 @[ /wasi/include/wasm32-wasip1/c++/v1/__vector/vector.h:262:67 @[ main.cpp:11:1 ] ] ] ] ]
	local.set	4
	local.get	0
	global.set	__stack_pointer
	local.get	1
	i32.const	32
	call	_ZdlPvm
.Ltmp13:
	.loc	1 11 1                          # main.cpp:11:1
	local.get	4
	throw_ref
.LBB0_4:                                # %_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit
	.loc	1 0 1 is_stmt 0                 # main.cpp:0:1
	end_block                               # label0:
	.loc	1 9 5 is_stmt 1                 # main.cpp:9:5
	local.get	0
	local.get	3
	f64.store	0
	i32.const	.L.str
	local.get	0
	call	printf
.Ltmp14:
	drop
	local.get	1
	i32.const	32
.Ltmp15:
	.loc	2 63 10                         # /wasi/include/wasm32-wasip1/c++/v1/__new/allocate.h:63:10 @[ /wasi/include/wasm32-wasip1/c++/v1/__memory/allocator.h:120:7 @[ /wasi/include/wasm32-wasip1/c++/v1/__memory/allocator_traits.h:289:9 @[ /wasi/include/wasm32-wasip1/c++/v1/__vector/vector.h:253:9 @[ /wasi/include/wasm32-wasip1/c++/v1/__vector/vector.h:262:67 @[ main.cpp:11:1 ] ] ] ] ]
	call	_ZdlPvm
.Ltmp16:
	.loc	1 11 1                          # main.cpp:11:1
	local.get	0
	i32.const	32
	i32.add 
	global.set	__stack_pointer
	i32.const	0
                                        # fallthrough-return
	end_function
.Ltmp17:
.Lfunc_end0:
	.file	4 "/wasi/include/wasm32-wasip1/c++/v1/__vector" "vector.h"
	.file	5 "/wasi/include/wasm32-wasip1/c++/v1/__memory" "allocate_at_least.h"
	.file	6 "/wasi/include/wasm32-wasip1/c++/v1/__memory" "allocator.h"
	.file	7 "/wasi/include/wasm32-wasip1/c++/v1/__memory" "uninitialized_algorithms.h"
	.file	8 "/wasi/include/wasm32-wasip1/c++/v1/__memory" "allocator_traits.h"
	.file	9 "/workspace" "./geometry.h"
	.file	10 "/wasi/include/wasm32-wasip1" "stdio.h"
                                        # -- End function
	.section	.text.main,"",@
	.hidden	main                            # -- Begin function main
	.globl	main
	.type	main,@function
main:                                   # @main
.Lfunc_begin1:
	.functype	main (i32, i32) -> (i32)
# %bb.0:                                # %body
	call	__original_main
                                        # fallthrough-return
	end_function
.Lfunc_end1:
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
	.section	.debug_abbrev,"",@
	.int8	1                               # Abbreviation Code
	.int8	17                              # DW_TAG_compile_unit
	.int8	1                               # DW_CHILDREN_yes
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
	.int8	18                              # DW_AT_high_pc
	.int8	6                               # DW_FORM_data4
	.int8	0                               # EOM(1)
	.int8	0                               # EOM(2)
	.int8	2                               # Abbreviation Code
	.int8	52                              # DW_TAG_variable
	.int8	0                               # DW_CHILDREN_no
	.int8	71                              # DW_AT_specification
	.int8	19                              # DW_FORM_ref4
	.ascii	"\210\001"                      # DW_AT_alignment
	.int8	15                              # DW_FORM_udata
	.int8	110                             # DW_AT_linkage_name
	.int8	14                              # DW_FORM_strp
	.int8	0                               # EOM(1)
	.int8	0                               # EOM(2)
	.int8	3                               # Abbreviation Code
	.int8	57                              # DW_TAG_namespace
	.int8	1                               # DW_CHILDREN_yes
	.int8	3                               # DW_AT_name
	.int8	14                              # DW_FORM_strp
	.int8	0                               # EOM(1)
	.int8	0                               # EOM(2)
	.int8	4                               # Abbreviation Code
	.int8	2                               # DW_TAG_class_type
	.int8	1                               # DW_CHILDREN_yes
	.int8	3                               # DW_AT_name
	.int8	14                              # DW_FORM_strp
	.int8	60                              # DW_AT_declaration
	.int8	25                              # DW_FORM_flag_present
	.int8	0                               # EOM(1)
	.int8	0                               # EOM(2)
	.int8	5                               # Abbreviation Code
	.int8	13                              # DW_TAG_member
	.int8	0                               # DW_CHILDREN_no
	.int8	3                               # DW_AT_name
	.int8	14                              # DW_FORM_strp
	.int8	73                              # DW_AT_type
	.int8	19                              # DW_FORM_ref4
	.int8	63                              # DW_AT_external
	.int8	25                              # DW_FORM_flag_present
	.int8	60                              # DW_AT_declaration
	.int8	25                              # DW_FORM_flag_present
	.int8	52                              # DW_AT_artificial
	.int8	25                              # DW_FORM_flag_present
	.int8	0                               # EOM(1)
	.int8	0                               # EOM(2)
	.int8	6                               # Abbreviation Code
	.int8	15                              # DW_TAG_pointer_type
	.int8	0                               # DW_CHILDREN_no
	.int8	0                               # EOM(1)
	.int8	0                               # EOM(2)
	.int8	7                               # Abbreviation Code
	.int8	46                              # DW_TAG_subprogram
	.int8	0                               # DW_CHILDREN_no
	.int8	3                               # DW_AT_name
	.int8	14                              # DW_FORM_strp
	.int8	32                              # DW_AT_inline
	.int8	11                              # DW_FORM_data1
	.int8	0                               # EOM(1)
	.int8	0                               # EOM(2)
	.int8	8                               # Abbreviation Code
	.int8	46                              # DW_TAG_subprogram
	.int8	1                               # DW_CHILDREN_yes
	.int8	17                              # DW_AT_low_pc
	.int8	1                               # DW_FORM_addr
	.int8	18                              # DW_AT_high_pc
	.int8	6                               # DW_FORM_data4
	.ascii	"\227B"                         # DW_AT_GNU_all_call_sites
	.int8	25                              # DW_FORM_flag_present
	.int8	3                               # DW_AT_name
	.int8	14                              # DW_FORM_strp
	.int8	0                               # EOM(1)
	.int8	0                               # EOM(2)
	.int8	9                               # Abbreviation Code
	.int8	29                              # DW_TAG_inlined_subroutine
	.int8	1                               # DW_CHILDREN_yes
	.int8	49                              # DW_AT_abstract_origin
	.int8	19                              # DW_FORM_ref4
	.int8	17                              # DW_AT_low_pc
	.int8	1                               # DW_FORM_addr
	.int8	18                              # DW_AT_high_pc
	.int8	6                               # DW_FORM_data4
	.int8	88                              # DW_AT_call_file
	.int8	11                              # DW_FORM_data1
	.int8	89                              # DW_AT_call_line
	.int8	11                              # DW_FORM_data1
	.int8	87                              # DW_AT_call_column
	.int8	11                              # DW_FORM_data1
	.int8	0                               # EOM(1)
	.int8	0                               # EOM(2)
	.int8	10                              # Abbreviation Code
	.int8	29                              # DW_TAG_inlined_subroutine
	.int8	1                               # DW_CHILDREN_yes
	.int8	49                              # DW_AT_abstract_origin
	.int8	19                              # DW_FORM_ref4
	.int8	17                              # DW_AT_low_pc
	.int8	1                               # DW_FORM_addr
	.int8	18                              # DW_AT_high_pc
	.int8	6                               # DW_FORM_data4
	.int8	88                              # DW_AT_call_file
	.int8	11                              # DW_FORM_data1
	.int8	89                              # DW_AT_call_line
	.int8	5                               # DW_FORM_data2
	.int8	87                              # DW_AT_call_column
	.int8	11                              # DW_FORM_data1
	.int8	0                               # EOM(1)
	.int8	0                               # EOM(2)
	.int8	11                              # Abbreviation Code
	.int8	29                              # DW_TAG_inlined_subroutine
	.int8	0                               # DW_CHILDREN_no
	.int8	49                              # DW_AT_abstract_origin
	.int8	19                              # DW_FORM_ref4
	.int8	17                              # DW_AT_low_pc
	.int8	1                               # DW_FORM_addr
	.int8	18                              # DW_AT_high_pc
	.int8	6                               # DW_FORM_data4
	.int8	88                              # DW_AT_call_file
	.int8	11                              # DW_FORM_data1
	.int8	89                              # DW_AT_call_line
	.int8	11                              # DW_FORM_data1
	.int8	87                              # DW_AT_call_column
	.int8	11                              # DW_FORM_data1
	.int8	0                               # EOM(1)
	.int8	0                               # EOM(2)
	.int8	12                              # Abbreviation Code
	.ascii	"\211\202\001"                  # DW_TAG_GNU_call_site
	.int8	0                               # DW_CHILDREN_no
	.int8	49                              # DW_AT_abstract_origin
	.int8	19                              # DW_FORM_ref4
	.int8	17                              # DW_AT_low_pc
	.int8	1                               # DW_FORM_addr
	.int8	0                               # EOM(1)
	.int8	0                               # EOM(2)
	.int8	13                              # Abbreviation Code
	.int8	46                              # DW_TAG_subprogram
	.int8	0                               # DW_CHILDREN_no
	.int8	3                               # DW_AT_name
	.int8	14                              # DW_FORM_strp
	.int8	58                              # DW_AT_decl_file
	.int8	11                              # DW_FORM_data1
	.int8	59                              # DW_AT_decl_line
	.int8	11                              # DW_FORM_data1
	.int8	60                              # DW_AT_declaration
	.int8	25                              # DW_FORM_flag_present
	.int8	63                              # DW_AT_external
	.int8	25                              # DW_FORM_flag_present
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
	.int8	1                               # Abbrev [1] 0xb:0x257 DW_TAG_compile_unit
	.int32	.Linfo_string0                  # DW_AT_producer
	.int16	33                              # DW_AT_language
	.int32	.Linfo_string1                  # DW_AT_name
	.int32	.Lline_table_start0             # DW_AT_stmt_list
	.int32	.Linfo_string2                  # DW_AT_comp_dir
	.int32	.Lfunc_begin0                   # DW_AT_low_pc
	.int32	.Lfunc_end0-.Lfunc_begin0       # DW_AT_high_pc
	.int8	2                               # Abbrev [2] 0x26:0xa DW_TAG_variable
	.int32	58                              # DW_AT_specification
	.int8	4                               # DW_AT_alignment
	.int32	.Linfo_string6                  # DW_AT_linkage_name
	.int8	3                               # Abbrev [3] 0x30:0x15 DW_TAG_namespace
	.int32	.Linfo_string3                  # DW_AT_name
	.int8	4                               # Abbrev [4] 0x35:0xf DW_TAG_class_type
	.int32	.Linfo_string4                  # DW_AT_name
                                        # DW_AT_declaration
	.int8	5                               # Abbrev [5] 0x3a:0x9 DW_TAG_member
	.int32	.Linfo_string5                  # DW_AT_name
	.int32	69                              # DW_AT_type
                                        # DW_AT_external
                                        # DW_AT_declaration
                                        # DW_AT_artificial
	.int8	0                               # End Of Children Mark
	.int8	0                               # End Of Children Mark
	.int8	6                               # Abbrev [6] 0x45:0x1 DW_TAG_pointer_type
	.int8	7                               # Abbrev [7] 0x46:0x6 DW_TAG_subprogram
	.int32	.Linfo_string7                  # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0x4c:0x6 DW_TAG_subprogram
	.int32	.Linfo_string8                  # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0x52:0x6 DW_TAG_subprogram
	.int32	.Linfo_string9                  # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0x58:0x6 DW_TAG_subprogram
	.int32	.Linfo_string10                 # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0x5e:0x6 DW_TAG_subprogram
	.int32	.Linfo_string11                 # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0x64:0x6 DW_TAG_subprogram
	.int32	.Linfo_string12                 # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0x6a:0x6 DW_TAG_subprogram
	.int32	.Linfo_string13                 # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0x70:0x6 DW_TAG_subprogram
	.int32	.Linfo_string14                 # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0x76:0x6 DW_TAG_subprogram
	.int32	.Linfo_string15                 # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0x7c:0x6 DW_TAG_subprogram
	.int32	.Linfo_string16                 # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0x82:0x6 DW_TAG_subprogram
	.int32	.Linfo_string17                 # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0x88:0x6 DW_TAG_subprogram
	.int32	.Linfo_string18                 # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0x8e:0x6 DW_TAG_subprogram
	.int32	.Linfo_string19                 # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0x94:0x6 DW_TAG_subprogram
	.int32	.Linfo_string20                 # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0x9a:0x6 DW_TAG_subprogram
	.int32	.Linfo_string20                 # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0xa0:0x6 DW_TAG_subprogram
	.int32	.Linfo_string21                 # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	7                               # Abbrev [7] 0xa6:0x6 DW_TAG_subprogram
	.int32	.Linfo_string22                 # DW_AT_name
	.int8	1                               # DW_AT_inline
	.int8	8                               # Abbrev [8] 0xac:0x1a7 DW_TAG_subprogram
	.int32	.Lfunc_begin0                   # DW_AT_low_pc
	.int32	.Lfunc_end0-.Lfunc_begin0       # DW_AT_high_pc
                                        # DW_AT_GNU_all_call_sites
	.int32	.Linfo_string25                 # DW_AT_name
	.int8	9                               # Abbrev [9] 0xb9:0xd2 DW_TAG_inlined_subroutine
	.int32	100                             # DW_AT_abstract_origin
	.int32	.Ltmp5                          # DW_AT_low_pc
	.int32	.Ltmp8-.Ltmp5                   # DW_AT_high_pc
	.int8	1                               # DW_AT_call_file
	.int8	7                               # DW_AT_call_line
	.int8	24                              # DW_AT_call_column
	.int8	10                              # Abbrev [10] 0xc9:0xc1 DW_TAG_inlined_subroutine
	.int32	94                              # DW_AT_abstract_origin
	.int32	.Ltmp5                          # DW_AT_low_pc
	.int32	.Ltmp8-.Ltmp5                   # DW_AT_high_pc
	.int8	4                               # DW_AT_call_file
	.int16	277                             # DW_AT_call_line
	.int8	5                               # DW_AT_call_column
	.int8	10                              # Abbrev [10] 0xda:0x45 DW_TAG_inlined_subroutine
	.int32	88                              # DW_AT_abstract_origin
	.int32	.Ltmp5                          # DW_AT_low_pc
	.int32	.Ltmp7-.Ltmp5                   # DW_AT_high_pc
	.int8	4                               # DW_AT_call_file
	.int16	592                             # DW_AT_call_line
	.int8	7                               # DW_AT_call_column
	.int8	10                              # Abbrev [10] 0xeb:0x33 DW_TAG_inlined_subroutine
	.int32	82                              # DW_AT_abstract_origin
	.int32	.Ltmp5                          # DW_AT_low_pc
	.int32	.Ltmp7-.Ltmp5                   # DW_AT_high_pc
	.int8	4                               # DW_AT_call_file
	.int16	574                             # DW_AT_call_line
	.int8	25                              # DW_AT_call_column
	.int8	9                               # Abbrev [9] 0xfc:0x21 DW_TAG_inlined_subroutine
	.int32	76                              # DW_AT_abstract_origin
	.int32	.Ltmp5                          # DW_AT_low_pc
	.int32	.Ltmp7-.Ltmp5                   # DW_AT_high_pc
	.int8	5                               # DW_AT_call_file
	.int8	41                              # DW_AT_call_line
	.int8	19                              # DW_AT_call_column
	.int8	11                              # Abbrev [11] 0x10c:0x10 DW_TAG_inlined_subroutine
	.int32	70                              # DW_AT_abstract_origin
	.int32	.Ltmp5                          # DW_AT_low_pc
	.int32	.Ltmp7-.Ltmp5                   # DW_AT_high_pc
	.int8	6                               # DW_AT_call_file
	.int8	105                             # DW_AT_call_line
	.int8	14                              # DW_AT_call_column
	.int8	0                               # End Of Children Mark
	.int8	0                               # End Of Children Mark
	.int8	0                               # End Of Children Mark
	.int8	10                              # Abbrev [10] 0x11f:0x6a DW_TAG_inlined_subroutine
	.int32	136                             # DW_AT_abstract_origin
	.int32	.Ltmp7                          # DW_AT_low_pc
	.int32	.Ltmp8-.Ltmp7                   # DW_AT_high_pc
	.int8	4                               # DW_AT_call_file
	.int16	593                             # DW_AT_call_line
	.int8	7                               # DW_AT_call_column
	.int8	10                              # Abbrev [10] 0x130:0x58 DW_TAG_inlined_subroutine
	.int32	130                             # DW_AT_abstract_origin
	.int32	.Ltmp7                          # DW_AT_low_pc
	.int32	.Ltmp8-.Ltmp7                   # DW_AT_high_pc
	.int8	4                               # DW_AT_call_file
	.int16	945                             # DW_AT_call_line
	.int8	17                              # DW_AT_call_column
	.int8	10                              # Abbrev [10] 0x141:0x46 DW_TAG_inlined_subroutine
	.int32	124                             # DW_AT_abstract_origin
	.int32	.Ltmp7                          # DW_AT_low_pc
	.int32	.Ltmp8-.Ltmp7                   # DW_AT_high_pc
	.int8	7                               # DW_AT_call_file
	.int16	582                             # DW_AT_call_line
	.int8	28                              # DW_AT_call_column
	.int8	10                              # Abbrev [10] 0x152:0x34 DW_TAG_inlined_subroutine
	.int32	118                             # DW_AT_abstract_origin
	.int32	.Ltmp7                          # DW_AT_low_pc
	.int32	.Ltmp8-.Ltmp7                   # DW_AT_high_pc
	.int8	7                               # DW_AT_call_file
	.int16	543                             # DW_AT_call_line
	.int8	5                               # DW_AT_call_column
	.int8	10                              # Abbrev [10] 0x163:0x22 DW_TAG_inlined_subroutine
	.int32	112                             # DW_AT_abstract_origin
	.int32	.Ltmp7                          # DW_AT_low_pc
	.int32	.Ltmp8-.Ltmp7                   # DW_AT_high_pc
	.int8	8                               # DW_AT_call_file
	.int16	302                             # DW_AT_call_line
	.int8	5                               # DW_AT_call_column
	.int8	11                              # Abbrev [11] 0x174:0x10 DW_TAG_inlined_subroutine
	.int32	106                             # DW_AT_abstract_origin
	.int32	.Ltmp7                          # DW_AT_low_pc
	.int32	.Ltmp8-.Ltmp7                   # DW_AT_high_pc
	.int8	3                               # DW_AT_call_file
	.int8	46                              # DW_AT_call_line
	.int8	10                              # DW_AT_call_column
	.int8	0                               # End Of Children Mark
	.int8	0                               # End Of Children Mark
	.int8	0                               # End Of Children Mark
	.int8	0                               # End Of Children Mark
	.int8	0                               # End Of Children Mark
	.int8	0                               # End Of Children Mark
	.int8	0                               # End Of Children Mark
	.int8	9                               # Abbrev [9] 0x18b:0x56 DW_TAG_inlined_subroutine
	.int32	166                             # DW_AT_abstract_origin
	.int32	.Ltmp12                         # DW_AT_low_pc
	.int32	.Ltmp13-.Ltmp12                 # DW_AT_high_pc
	.int8	1                               # DW_AT_call_file
	.int8	11                              # DW_AT_call_line
	.int8	1                               # DW_AT_call_column
	.int8	10                              # Abbrev [10] 0x19b:0x45 DW_TAG_inlined_subroutine
	.int32	160                             # DW_AT_abstract_origin
	.int32	.Ltmp12                         # DW_AT_low_pc
	.int32	.Ltmp13-.Ltmp12                 # DW_AT_high_pc
	.int8	4                               # DW_AT_call_file
	.int16	262                             # DW_AT_call_line
	.int8	67                              # DW_AT_call_column
	.int8	9                               # Abbrev [9] 0x1ac:0x33 DW_TAG_inlined_subroutine
	.int32	154                             # DW_AT_abstract_origin
	.int32	.Ltmp12                         # DW_AT_low_pc
	.int32	.Ltmp13-.Ltmp12                 # DW_AT_high_pc
	.int8	4                               # DW_AT_call_file
	.int8	253                             # DW_AT_call_line
	.int8	9                               # DW_AT_call_column
	.int8	10                              # Abbrev [10] 0x1bc:0x22 DW_TAG_inlined_subroutine
	.int32	148                             # DW_AT_abstract_origin
	.int32	.Ltmp12                         # DW_AT_low_pc
	.int32	.Ltmp13-.Ltmp12                 # DW_AT_high_pc
	.int8	8                               # DW_AT_call_file
	.int16	289                             # DW_AT_call_line
	.int8	9                               # DW_AT_call_column
	.int8	11                              # Abbrev [11] 0x1cd:0x10 DW_TAG_inlined_subroutine
	.int32	142                             # DW_AT_abstract_origin
	.int32	.Ltmp12                         # DW_AT_low_pc
	.int32	.Ltmp13-.Ltmp12                 # DW_AT_high_pc
	.int8	6                               # DW_AT_call_file
	.int8	120                             # DW_AT_call_line
	.int8	7                               # DW_AT_call_column
	.int8	0                               # End Of Children Mark
	.int8	0                               # End Of Children Mark
	.int8	0                               # End Of Children Mark
	.int8	0                               # End Of Children Mark
	.int8	9                               # Abbrev [9] 0x1e1:0x56 DW_TAG_inlined_subroutine
	.int32	166                             # DW_AT_abstract_origin
	.int32	.Ltmp15                         # DW_AT_low_pc
	.int32	.Ltmp16-.Ltmp15                 # DW_AT_high_pc
	.int8	1                               # DW_AT_call_file
	.int8	11                              # DW_AT_call_line
	.int8	1                               # DW_AT_call_column
	.int8	10                              # Abbrev [10] 0x1f1:0x45 DW_TAG_inlined_subroutine
	.int32	160                             # DW_AT_abstract_origin
	.int32	.Ltmp15                         # DW_AT_low_pc
	.int32	.Ltmp16-.Ltmp15                 # DW_AT_high_pc
	.int8	4                               # DW_AT_call_file
	.int16	262                             # DW_AT_call_line
	.int8	67                              # DW_AT_call_column
	.int8	9                               # Abbrev [9] 0x202:0x33 DW_TAG_inlined_subroutine
	.int32	154                             # DW_AT_abstract_origin
	.int32	.Ltmp15                         # DW_AT_low_pc
	.int32	.Ltmp16-.Ltmp15                 # DW_AT_high_pc
	.int8	4                               # DW_AT_call_file
	.int8	253                             # DW_AT_call_line
	.int8	9                               # DW_AT_call_column
	.int8	10                              # Abbrev [10] 0x212:0x22 DW_TAG_inlined_subroutine
	.int32	148                             # DW_AT_abstract_origin
	.int32	.Ltmp15                         # DW_AT_low_pc
	.int32	.Ltmp16-.Ltmp15                 # DW_AT_high_pc
	.int8	8                               # DW_AT_call_file
	.int16	289                             # DW_AT_call_line
	.int8	9                               # DW_AT_call_column
	.int8	11                              # Abbrev [11] 0x223:0x10 DW_TAG_inlined_subroutine
	.int32	142                             # DW_AT_abstract_origin
	.int32	.Ltmp15                         # DW_AT_low_pc
	.int32	.Ltmp16-.Ltmp15                 # DW_AT_high_pc
	.int8	6                               # DW_AT_call_file
	.int8	120                             # DW_AT_call_line
	.int8	7                               # DW_AT_call_column
	.int8	0                               # End Of Children Mark
	.int8	0                               # End Of Children Mark
	.int8	0                               # End Of Children Mark
	.int8	0                               # End Of Children Mark
	.int8	12                              # Abbrev [12] 0x237:0x9 DW_TAG_GNU_call_site
	.int32	595                             # DW_AT_abstract_origin
	.int32	.Ltmp9                          # DW_AT_low_pc
	.int8	12                              # Abbrev [12] 0x240:0x9 DW_TAG_GNU_call_site
	.int32	602                             # DW_AT_abstract_origin
	.int32	.Ltmp10                         # DW_AT_low_pc
	.int8	12                              # Abbrev [12] 0x249:0x9 DW_TAG_GNU_call_site
	.int32	602                             # DW_AT_abstract_origin
	.int32	.Ltmp14                         # DW_AT_low_pc
	.int8	0                               # End Of Children Mark
	.int8	13                              # Abbrev [13] 0x253:0x7 DW_TAG_subprogram
	.int32	.Linfo_string23                 # DW_AT_name
	.int8	9                               # DW_AT_decl_file
	.int8	13                              # DW_AT_decl_line
                                        # DW_AT_declaration
                                        # DW_AT_external
	.int8	13                              # Abbrev [13] 0x25a:0x7 DW_TAG_subprogram
	.int32	.Linfo_string24                 # DW_AT_name
	.int8	10                              # DW_AT_decl_file
	.int8	126                             # DW_AT_decl_line
                                        # DW_AT_declaration
                                        # DW_AT_external
	.int8	0                               # End Of Children Mark
.Ldebug_info_end0:
	.section	.debug_str,"S",@
.Linfo_string0:
	.asciz	"clang version 21.1.8"          # string offset=0
.Linfo_string1:
	.asciz	"main.cpp"                      # string offset=21
.Linfo_string2:
	.asciz	"/workspace"                    # string offset=30
.Linfo_string3:
	.asciz	"std"                           # string offset=41
.Linfo_string4:
	.asciz	"length_error"                  # string offset=45
.Linfo_string5:
	.asciz	"_vtable$"                      # string offset=58
.Linfo_string6:
	.asciz	"_ZTVSt12length_error"          # string offset=67
.Linfo_string7:
	.asciz	"__libcpp_allocate<Point>"      # string offset=88
.Linfo_string8:
	.asciz	"allocate"                      # string offset=113
.Linfo_string9:
	.asciz	"__allocate_at_least<std::__2::allocator<Point> >" # string offset=122
.Linfo_string10:
	.asciz	"__vallocate"                   # string offset=171
.Linfo_string11:
	.asciz	"__init_with_size<const Point *, const Point *>" # string offset=183
.Linfo_string12:
	.asciz	"vector"                        # string offset=230
.Linfo_string13:
	.asciz	"construct_at<Point, const Point &, Point *>" # string offset=237
.Linfo_string14:
	.asciz	"__construct_at<Point, const Point &, Point *>" # string offset=281
.Linfo_string15:
	.asciz	"construct<Point, const Point &, 0>" # string offset=327
.Linfo_string16:
	.asciz	"__uninitialized_allocator_copy_impl<std::__2::allocator<Point>, const Point *, const Point *, Point *>" # string offset=362
.Linfo_string17:
	.asciz	"__uninitialized_allocator_copy<std::__2::allocator<Point>, const Point *, const Point *, Point *>" # string offset=465
.Linfo_string18:
	.asciz	"__construct_at_end<const Point *, const Point *>" # string offset=563
.Linfo_string19:
	.asciz	"__libcpp_deallocate<Point>"    # string offset=612
.Linfo_string20:
	.asciz	"deallocate"                    # string offset=639
.Linfo_string21:
	.asciz	"operator()"                    # string offset=650
.Linfo_string22:
	.asciz	"~vector"                       # string offset=661
.Linfo_string23:
	.asciz	"distance"                      # string offset=669
.Linfo_string24:
	.asciz	"printf"                        # string offset=678
.Linfo_string25:
	.asciz	"main"                          # string offset=685
	.ident	"clang version 21.1.8"
	.no_dead_strip	__indirect_function_table
	.size	__wasm_lpad_context, 12
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
	.section	.debug_str,"S",@
	.section	.debug_line,"",@
.Lline_table_start0:
