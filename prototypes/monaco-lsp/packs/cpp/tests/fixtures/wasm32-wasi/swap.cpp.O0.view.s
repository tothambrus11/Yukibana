	.file	"swap.cpp"
	.globaltype	__stack_pointer, i32
	.functype	__original_main () -> (i32)
	.functype	_ZNSt3__24swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_ (i32, i32) -> ()
	.functype	main (i32, i32) -> (i32)
	.section	.text.__original_main,"",@
	.hidden	__original_main                 # -- Begin function __original_main
	.globl	__original_main
	.type	__original_main,@function
__original_main:                        # @__original_main
.Lfunc_begin0:
	.file	1 "/workspace" "swap.cpp"
	.loc	1 3 0                           # swap.cpp:3:0
	.functype	__original_main () -> (i32)
	.local  	i32, i32
# %bb.0:                                # %entry
	global.get	__stack_pointer
	i32.const	16
	i32.sub 
	local.set	0
	local.get	0
	global.set	__stack_pointer
	local.get	0
	i32.const	0
	i32.store	12
.Ltmp0:
	.loc	1 4 9 prologue_end              # swap.cpp:4:9
	local.get	0
	i32.const	1
	i32.store	8
	.loc	1 4 16 is_stmt 0                # swap.cpp:4:16
	local.get	0
	i32.const	2
	i32.store	4
	.loc	1 5 5 is_stmt 1                 # swap.cpp:5:5
	local.get	0
	i32.const	8
	i32.add 
	local.get	0
	i32.const	4
	i32.add 
	call	_ZNSt3__24swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_
	.loc	1 6 12                          # swap.cpp:6:12
	local.get	0
	i32.load	8
	local.set	1
	.loc	1 6 5 is_stmt 0                 # swap.cpp:6:5
	local.get	0
	i32.const	16
	i32.add 
	global.set	__stack_pointer
	local.get	1
	return
	end_function
.Ltmp1:
.Lfunc_end0:
                                        # -- End function
	.section	.text._ZNSt3__24swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_,"G",@,_ZNSt3__24swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_,comdat
	.hidden	_ZNSt3__24swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_ # -- Begin function _ZNSt3__24swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_
	.weak	_ZNSt3__24swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_
	.type	_ZNSt3__24swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_,@function
_ZNSt3__24swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_: # @_ZNSt3__24swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_
.Lfunc_begin1:
	.file	2 "/wasi/include/wasm32-wasip1/c++/v1/__utility" "swap.h"
	.loc	2 42 0 is_stmt 1                # /wasi/include/wasm32-wasip1/c++/v1/__utility/swap.h:42:0
	.functype	_ZNSt3__24swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_ (i32, i32) -> ()
	.local  	i32, i32, i32
# %bb.0:                                # %entry
	global.get	__stack_pointer
	i32.const	16
	i32.sub 
	local.set	2
	local.get	2
	local.get	0
	i32.store	12
	local.get	2
	local.get	1
	i32.store	8
.Ltmp2:
	.loc	2 43 21 prologue_end            # /wasi/include/wasm32-wasip1/c++/v1/__utility/swap.h:43:21
	local.get	2
	local.get	2
	i32.load	12
	.loc	2 43 11 is_stmt 0               # /wasi/include/wasm32-wasip1/c++/v1/__utility/swap.h:43:11
	i32.load	0
	.loc	2 43 7                          # /wasi/include/wasm32-wasip1/c++/v1/__utility/swap.h:43:7
	i32.store	4
	.loc	2 44 19 is_stmt 1               # /wasi/include/wasm32-wasip1/c++/v1/__utility/swap.h:44:19
	local.get	2
	i32.load	8
	.loc	2 44 9 is_stmt 0                # /wasi/include/wasm32-wasip1/c++/v1/__utility/swap.h:44:9
	i32.load	0
	local.set	3
	.loc	2 44 3                          # /wasi/include/wasm32-wasip1/c++/v1/__utility/swap.h:44:3
	local.get	2
	i32.load	12
	.loc	2 44 7                          # /wasi/include/wasm32-wasip1/c++/v1/__utility/swap.h:44:7
	local.get	3
	i32.store	0
	.loc	2 45 9 is_stmt 1                # /wasi/include/wasm32-wasip1/c++/v1/__utility/swap.h:45:9
	local.get	2
	i32.load	4
	local.set	4
	.loc	2 45 3 is_stmt 0                # /wasi/include/wasm32-wasip1/c++/v1/__utility/swap.h:45:3
	local.get	2
	i32.load	8
	.loc	2 45 7                          # /wasi/include/wasm32-wasip1/c++/v1/__utility/swap.h:45:7
	local.get	4
	i32.store	0
	.loc	2 46 1 is_stmt 1                # /wasi/include/wasm32-wasip1/c++/v1/__utility/swap.h:46:1
	return
	end_function
.Ltmp3:
.Lfunc_end1:
                                        # -- End function
	.section	.text.main,"",@
	.hidden	main                            # -- Begin function main
	.globl	main
	.type	main,@function
main:                                   # @main
.Lfunc_begin2:
	.functype	main (i32, i32) -> (i32)
# %bb.0:                                # %body
	call	__original_main
	return
	end_function
.Lfunc_end2:
                                        # -- End function
	.globl	__main_void
	.type	__main_void,@function
	.hidden	__main_void
__main_void = __original_main
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
	.asciz	"swap.cpp"                      # string offset=21
.Linfo_string2:
	.asciz	"/workspace"                    # string offset=30
	.ident	"clang version 21.1.8"
	.no_dead_strip	__indirect_function_table
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
