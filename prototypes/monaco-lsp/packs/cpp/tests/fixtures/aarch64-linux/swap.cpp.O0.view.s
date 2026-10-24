	.file	"swap.cpp"
	.text
	.globl	main                            // -- Begin function main
	.p2align	2
	.type	main,@function
main:                                   // @main
.Lfunc_begin0:
	.file	0 "/workspace" "swap.cpp" md5 0xe43dc361acd84e8841a260fde1dc29f8
	.loc	0 3 0                           // swap.cpp:3:0
	.cfi_startproc
// %bb.0:                               // %entry
	sub	sp, sp, #32
	.cfi_def_cfa_offset 32
	stp	x29, x30, [sp, #16]             // 16-byte Folded Spill
	add	x29, sp, #16
	.cfi_def_cfa w29, 16
	.cfi_offset w30, -8
	.cfi_offset w29, -16
	stur	wzr, [x29, #-4]
	add	x0, sp, #8
.Ltmp0:
	.loc	0 4 9 prologue_end              // swap.cpp:4:9
	mov	w8, #1                          // =0x1
	str	w8, [sp, #8]
	add	x1, sp, #4
	.loc	0 4 16 is_stmt 0                // swap.cpp:4:16
	mov	w8, #2                          // =0x2
	str	w8, [sp, #4]
	.loc	0 5 5 is_stmt 1                 // swap.cpp:5:5
	bl	_ZNSt3__14swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_
	.loc	0 6 12                          // swap.cpp:6:12
	ldr	w0, [sp, #8]
	.cfi_def_cfa wsp, 32
	.loc	0 6 5 epilogue_begin is_stmt 0  // swap.cpp:6:5
	ldp	x29, x30, [sp, #16]             // 16-byte Folded Reload
	add	sp, sp, #32
	.cfi_def_cfa_offset 0
	.cfi_restore w30
	.cfi_restore w29
	ret
.Ltmp1:
.Lfunc_end0:
	.size	main, .Lfunc_end0-main
	.cfi_endproc
                                        // -- End function
	.section	.text._ZNSt3__14swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_,"axG",@progbits,_ZNSt3__14swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_,comdat
	.hidden	_ZNSt3__14swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_ // -- Begin function _ZNSt3__14swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_
	.weak	_ZNSt3__14swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_
	.p2align	2
	.type	_ZNSt3__14swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_,@function
_ZNSt3__14swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_: // @_ZNSt3__14swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_
.Lfunc_begin1:
	.file	1 "/usr/include/c++/v1/__utility" "swap.h"
	.loc	1 42 0 is_stmt 1                // /usr/include/c++/v1/__utility/swap.h:42:0
	.cfi_startproc
// %bb.0:                               // %entry
	sub	sp, sp, #32
	.cfi_def_cfa_offset 32
	str	x0, [sp, #24]
	str	x1, [sp, #16]
.Ltmp3:
	.loc	1 43 21 prologue_end            // /usr/include/c++/v1/__utility/swap.h:43:21
	ldr	x8, [sp, #24]
	.loc	1 43 11 is_stmt 0               // /usr/include/c++/v1/__utility/swap.h:43:11
	ldr	w8, [x8]
	.loc	1 43 7                          // /usr/include/c++/v1/__utility/swap.h:43:7
	str	w8, [sp, #12]
	.loc	1 44 19 is_stmt 1               // /usr/include/c++/v1/__utility/swap.h:44:19
	ldr	x8, [sp, #16]
	.loc	1 44 9 is_stmt 0                // /usr/include/c++/v1/__utility/swap.h:44:9
	ldr	w8, [x8]
	.loc	1 44 3                          // /usr/include/c++/v1/__utility/swap.h:44:3
	ldr	x9, [sp, #24]
	.loc	1 44 7                          // /usr/include/c++/v1/__utility/swap.h:44:7
	str	w8, [x9]
	.loc	1 45 9 is_stmt 1                // /usr/include/c++/v1/__utility/swap.h:45:9
	ldr	w8, [sp, #12]
	.loc	1 45 3 is_stmt 0                // /usr/include/c++/v1/__utility/swap.h:45:3
	ldr	x9, [sp, #16]
	.loc	1 45 7                          // /usr/include/c++/v1/__utility/swap.h:45:7
	str	w8, [x9]
	.loc	1 46 1 epilogue_begin is_stmt 1 // /usr/include/c++/v1/__utility/swap.h:46:1
	add	sp, sp, #32
	.cfi_def_cfa_offset 0
	ret
.Ltmp4:
.Lfunc_end1:
	.size	_ZNSt3__14swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_, .Lfunc_end1-_ZNSt3__14swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_
	.cfi_endproc
                                        // -- End function
	.section	.debug_abbrev,"",@progbits
	.byte	1                               // Abbreviation Code
	.byte	17                              // DW_TAG_compile_unit
	.byte	0                               // DW_CHILDREN_no
	.byte	37                              // DW_AT_producer
	.byte	37                              // DW_FORM_strx1
	.byte	19                              // DW_AT_language
	.byte	5                               // DW_FORM_data2
	.byte	3                               // DW_AT_name
	.byte	37                              // DW_FORM_strx1
	.byte	114                             // DW_AT_str_offsets_base
	.byte	23                              // DW_FORM_sec_offset
	.byte	16                              // DW_AT_stmt_list
	.byte	23                              // DW_FORM_sec_offset
	.byte	27                              // DW_AT_comp_dir
	.byte	37                              // DW_FORM_strx1
	.byte	17                              // DW_AT_low_pc
	.byte	1                               // DW_FORM_addr
	.byte	85                              // DW_AT_ranges
	.byte	35                              // DW_FORM_rnglistx
	.byte	115                             // DW_AT_addr_base
	.byte	23                              // DW_FORM_sec_offset
	.byte	116                             // DW_AT_rnglists_base
	.byte	23                              // DW_FORM_sec_offset
	.byte	0                               // EOM(1)
	.byte	0                               // EOM(2)
	.byte	0                               // EOM(3)
	.section	.debug_info,"",@progbits
.Lcu_begin0:
	.word	.Ldebug_info_end0-.Ldebug_info_start0 // Length of Unit
.Ldebug_info_start0:
	.hword	5                               // DWARF version number
	.byte	1                               // DWARF Unit Type
	.byte	8                               // Address Size (in bytes)
	.word	.debug_abbrev                   // Offset Into Abbrev. Section
	.byte	1                               // Abbrev [1] 0xc:0x1f DW_TAG_compile_unit
	.byte	0                               // DW_AT_producer
	.hword	33                              // DW_AT_language
	.byte	1                               // DW_AT_name
	.word	.Lstr_offsets_base0             // DW_AT_str_offsets_base
	.word	.Lline_table_start0             // DW_AT_stmt_list
	.byte	2                               // DW_AT_comp_dir
	.xword	0                               // DW_AT_low_pc
	.byte	0                               // DW_AT_ranges
	.word	.Laddr_table_base0              // DW_AT_addr_base
	.word	.Lrnglists_table_base0          // DW_AT_rnglists_base
.Ldebug_info_end0:
	.section	.debug_rnglists,"",@progbits
	.word	.Ldebug_list_header_end0-.Ldebug_list_header_start0 // Length
.Ldebug_list_header_start0:
	.hword	5                               // Version
	.byte	8                               // Address size
	.byte	0                               // Segment selector size
	.word	1                               // Offset entry count
.Lrnglists_table_base0:
	.word	.Ldebug_ranges0-.Lrnglists_table_base0
.Ldebug_ranges0:
	.byte	3                               // DW_RLE_startx_length
	.byte	0                               //   start index
	.uleb128 .Lfunc_end0-.Lfunc_begin0      //   length
	.byte	3                               // DW_RLE_startx_length
	.byte	1                               //   start index
	.uleb128 .Lfunc_end1-.Lfunc_begin1      //   length
	.byte	0                               // DW_RLE_end_of_list
.Ldebug_list_header_end0:
	.section	.debug_str_offsets,"",@progbits
	.word	16                              // Length of String Offsets Set
	.hword	5
	.hword	0
.Lstr_offsets_base0:
	.section	.debug_str,"MS",@progbits,1
.Linfo_string0:
	.asciz	"clang version 21.1.8"          // string offset=0
.Linfo_string1:
	.asciz	"swap.cpp"                      // string offset=21
.Linfo_string2:
	.asciz	"/workspace"                    // string offset=30
	.section	.debug_str_offsets,"",@progbits
	.word	.Linfo_string0
	.word	.Linfo_string1
	.word	.Linfo_string2
	.section	.debug_addr,"",@progbits
	.word	.Ldebug_addr_end0-.Ldebug_addr_start0 // Length of contribution
.Ldebug_addr_start0:
	.hword	5                               // DWARF version number
	.byte	8                               // Address size
	.byte	0                               // Segment selector size
.Laddr_table_base0:
	.xword	.Lfunc_begin0
	.xword	.Lfunc_begin1
.Ldebug_addr_end0:
	.ident	"clang version 21.1.8"
	.section	".note.GNU-stack","",@progbits
	.addrsig
	.addrsig_sym _ZNSt3__14swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_
	.section	.debug_line,"",@progbits
.Lline_table_start0:
