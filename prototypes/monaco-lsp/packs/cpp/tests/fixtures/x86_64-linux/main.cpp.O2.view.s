	.file	"main.cpp"
	.file	0 "/workspace" "main.cpp" md5 0xd9f185577675b18f88ae34b0777d2aff
	.text
	.globl	main                            # -- Begin function main
	.p2align	4
	.type	main,@function
main:                                   # @main
.Lfunc_begin0:
	.loc	0 6 0                           # main.cpp:6:0
	.cfi_startproc
	.cfi_personality 155, DW.ref.__gxx_personality_v0
	.cfi_lsda 27, .Lexception0
# %bb.0:                                # %entry
	pushq	%r14
	.cfi_def_cfa_offset 16
	pushq	%rbx
	.cfi_def_cfa_offset 24
	pushq	%rax
	.cfi_def_cfa_offset 32
	.cfi_offset %rbx, -24
	.cfi_offset %r14, -16
	.file	1 "/usr/include/c++/v1/__new" "allocate.h"
	.loc	1 43 28 prologue_end            # /usr/include/c++/v1/__new/allocate.h:43:28 @[ /usr/include/c++/v1/__memory/allocator.h:105:14 @[ /usr/include/c++/v1/__memory/allocate_at_least.h:41:19 @[ /usr/include/c++/v1/__vector/vector.h:574:25 @[ /usr/include/c++/v1/__vector/vector.h:592:7 @[ /usr/include/c++/v1/__vector/vector.h:277:5 @[ main.cpp:7:24 ] ] ] ] ] ]
	movl	$32, %edi
	callq	_Znwm@PLT
.Ltmp5:
	movq	%rax, %rbx
.Ltmp6:
	.file	2 "/usr/include/c++/v1/__memory" "construct_at.h"
	.loc	2 38 49                         # /usr/include/c++/v1/__memory/construct_at.h:38:49 @[ /usr/include/c++/v1/__memory/construct_at.h:46:10 @[ /usr/include/c++/v1/__memory/allocator_traits.h:302:5 @[ /usr/include/c++/v1/__memory/uninitialized_algorithms.h:543:5 @[ /usr/include/c++/v1/__memory/uninitialized_algorithms.h:582:28 @[ /usr/include/c++/v1/__vector/vector.h:945:17 @[ /usr/include/c++/v1/__vector/vector.h:593:7 @[ /usr/include/c++/v1/__vector/vector.h:277:5 @[ main.cpp:7:24 ] ] ] ] ] ] ] ]
	movups	.Lconstinit(%rip), %xmm0
	movups	%xmm0, (%rax)
	movups	.Lconstinit+16(%rip), %xmm0
	movups	%xmm0, 16(%rax)
	leaq	16(%rax), %r14
.Ltmp7:
.Ltmp0:
	.loc	0 8 25                          # main.cpp:8:25
	movq	%rax, %rdi
	movq	%r14, %rsi
	callq	_Z8distanceRK5PointS1_@PLT
.Ltmp8:
.Ltmp1:
# %bb.1:                                # %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit27
	.loc	0 8 5 is_stmt 0                 # main.cpp:8:5
	leaq	.L.str(%rip), %rdi
	movb	$1, %al
	callq	printf@PLT
.Ltmp9:
.Ltmp2:
	.loc	0 9 35 is_stmt 1                # main.cpp:9:35
	movq	%r14, %rdi
	callq	_ZNK5Point4normEv@PLT
.Ltmp10:
.Ltmp3:
# %bb.2:                                # %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit
	.loc	0 9 5 is_stmt 0                 # main.cpp:9:5
	leaq	.L.str(%rip), %rdi
	movb	$1, %al
	callq	printf@PLT
.Ltmp11:
	.loc	1 63 10 is_stmt 1               # /usr/include/c++/v1/__new/allocate.h:63:10 @[ /usr/include/c++/v1/__memory/allocator.h:120:7 @[ /usr/include/c++/v1/__memory/allocator_traits.h:289:9 @[ /usr/include/c++/v1/__vector/vector.h:253:9 @[ /usr/include/c++/v1/__vector/vector.h:262:67 @[ main.cpp:11:1 ] ] ] ] ]
	movl	$32, %esi
	movq	%rbx, %rdi
	callq	_ZdlPvm@PLT
.Ltmp12:
	.loc	0 11 1                          # main.cpp:11:1
	xorl	%eax, %eax
	.loc	0 11 1 epilogue_begin is_stmt 0 # main.cpp:11:1
	addq	$8, %rsp
	.cfi_def_cfa_offset 24
	popq	%rbx
	.cfi_def_cfa_offset 16
	popq	%r14
	.cfi_def_cfa_offset 8
	retq
.LBB0_3:                                # %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit34
	.cfi_def_cfa_offset 32
.Ltmp4:
	.loc	0 0 1                           # main.cpp:0:1
	movq	%rax, %r14
.Ltmp13:
	.loc	1 63 10 is_stmt 1               # /usr/include/c++/v1/__new/allocate.h:63:10 @[ /usr/include/c++/v1/__memory/allocator.h:120:7 @[ /usr/include/c++/v1/__memory/allocator_traits.h:289:9 @[ /usr/include/c++/v1/__vector/vector.h:253:9 @[ /usr/include/c++/v1/__vector/vector.h:262:67 @[ main.cpp:11:1 ] ] ] ] ]
	movl	$32, %esi
	movq	%rbx, %rdi
	callq	_ZdlPvm@PLT
.Ltmp14:
	.loc	1 0 10 is_stmt 0                # /usr/include/c++/v1/__new/allocate.h:0:10
	movq	%r14, %rdi
	callq	_Unwind_Resume@PLT
.Ltmp15:
.Lfunc_end0:
	.size	main, .Lfunc_end0-main
	.cfi_endproc
	.file	3 "/usr/include/c++/v1/__vector" "vector.h"
	.file	4 "/usr/include/c++/v1/__memory" "allocate_at_least.h"
	.file	5 "/usr/include/c++/v1/__memory" "allocator.h"
	.file	6 "/usr/include/c++/v1/__memory" "uninitialized_algorithms.h"
	.file	7 "/usr/include/c++/v1/__memory" "allocator_traits.h"
	.file	8 "." "geometry.h" md5 0xab6e9775eef780b676f94bd3bd771b5e
	.file	9 "/usr/include" "stdio.h" md5 0x3bba50398f7422b708b9de97b4ee8bfb
	.section	.gcc_except_table,"a",@progbits
	.p2align	2, 0x0
GCC_except_table0:
.Lexception0:
	.byte	255                             # @LPStart Encoding = omit
	.byte	255                             # @TType Encoding = omit
	.byte	1                               # Call site Encoding = uleb128
	.uleb128 .Lcst_end0-.Lcst_begin0
.Lcst_begin0:
	.uleb128 .Lfunc_begin0-.Lfunc_begin0    # >> Call Site 1 <<
	.uleb128 .Ltmp0-.Lfunc_begin0           #   Call between .Lfunc_begin0 and .Ltmp0
	.byte	0                               #     has no landing pad
	.byte	0                               #   On action: cleanup
	.uleb128 .Ltmp0-.Lfunc_begin0           # >> Call Site 2 <<
	.uleb128 .Ltmp3-.Ltmp0                  #   Call between .Ltmp0 and .Ltmp3
	.uleb128 .Ltmp4-.Lfunc_begin0           #     jumps to .Ltmp4
	.byte	0                               #   On action: cleanup
	.uleb128 .Ltmp3-.Lfunc_begin0           # >> Call Site 3 <<
	.uleb128 .Lfunc_end0-.Ltmp3             #   Call between .Ltmp3 and .Lfunc_end0
	.byte	0                               #     has no landing pad
	.byte	0                               #   On action: cleanup
.Lcst_end0:
	.p2align	2, 0x0
                                        # -- End function
	.type	.Lconstinit,@object             # @constinit
	.section	.rodata.cst32,"aM",@progbits,32
	.p2align	3, 0x0
.Lconstinit:
	.zero	16
	.quad	0x4008000000000000              # double 3
	.quad	0x4010000000000000              # double 4
	.size	.Lconstinit, 32

	.type	.L.str,@object                  # @.str
	.section	.rodata.str1.1,"aMS",@progbits,1
.L.str:
	.asciz	"%f\n"
	.size	.L.str, 4

	.section	.debug_abbrev,"",@progbits
	.byte	1                               # Abbreviation Code
	.byte	17                              # DW_TAG_compile_unit
	.byte	1                               # DW_CHILDREN_yes
	.byte	37                              # DW_AT_producer
	.byte	37                              # DW_FORM_strx1
	.byte	19                              # DW_AT_language
	.byte	5                               # DW_FORM_data2
	.byte	3                               # DW_AT_name
	.byte	37                              # DW_FORM_strx1
	.byte	114                             # DW_AT_str_offsets_base
	.byte	23                              # DW_FORM_sec_offset
	.byte	16                              # DW_AT_stmt_list
	.byte	23                              # DW_FORM_sec_offset
	.byte	27                              # DW_AT_comp_dir
	.byte	37                              # DW_FORM_strx1
	.byte	17                              # DW_AT_low_pc
	.byte	27                              # DW_FORM_addrx
	.byte	18                              # DW_AT_high_pc
	.byte	6                               # DW_FORM_data4
	.byte	115                             # DW_AT_addr_base
	.byte	23                              # DW_FORM_sec_offset
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	2                               # Abbreviation Code
	.byte	52                              # DW_TAG_variable
	.byte	0                               # DW_CHILDREN_no
	.byte	71                              # DW_AT_specification
	.byte	19                              # DW_FORM_ref4
	.ascii	"\210\001"                      # DW_AT_alignment
	.byte	15                              # DW_FORM_udata
	.byte	110                             # DW_AT_linkage_name
	.byte	37                              # DW_FORM_strx1
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	3                               # Abbreviation Code
	.byte	57                              # DW_TAG_namespace
	.byte	1                               # DW_CHILDREN_yes
	.byte	3                               # DW_AT_name
	.byte	37                              # DW_FORM_strx1
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	4                               # Abbreviation Code
	.byte	2                               # DW_TAG_class_type
	.byte	1                               # DW_CHILDREN_yes
	.byte	3                               # DW_AT_name
	.byte	37                              # DW_FORM_strx1
	.byte	60                              # DW_AT_declaration
	.byte	25                              # DW_FORM_flag_present
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	5                               # Abbreviation Code
	.byte	52                              # DW_TAG_variable
	.byte	0                               # DW_CHILDREN_no
	.byte	3                               # DW_AT_name
	.byte	37                              # DW_FORM_strx1
	.byte	73                              # DW_AT_type
	.byte	19                              # DW_FORM_ref4
	.byte	63                              # DW_AT_external
	.byte	25                              # DW_FORM_flag_present
	.byte	60                              # DW_AT_declaration
	.byte	25                              # DW_FORM_flag_present
	.byte	52                              # DW_AT_artificial
	.byte	25                              # DW_FORM_flag_present
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	6                               # Abbreviation Code
	.byte	15                              # DW_TAG_pointer_type
	.byte	0                               # DW_CHILDREN_no
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	7                               # Abbreviation Code
	.byte	46                              # DW_TAG_subprogram
	.byte	0                               # DW_CHILDREN_no
	.byte	3                               # DW_AT_name
	.byte	37                              # DW_FORM_strx1
	.byte	32                              # DW_AT_inline
	.byte	33                              # DW_FORM_implicit_const
	.byte	1
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	8                               # Abbreviation Code
	.byte	46                              # DW_TAG_subprogram
	.byte	1                               # DW_CHILDREN_yes
	.byte	17                              # DW_AT_low_pc
	.byte	27                              # DW_FORM_addrx
	.byte	18                              # DW_AT_high_pc
	.byte	6                               # DW_FORM_data4
	.byte	122                             # DW_AT_call_all_calls
	.byte	25                              # DW_FORM_flag_present
	.byte	3                               # DW_AT_name
	.byte	37                              # DW_FORM_strx1
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	9                               # Abbreviation Code
	.byte	29                              # DW_TAG_inlined_subroutine
	.byte	1                               # DW_CHILDREN_yes
	.byte	49                              # DW_AT_abstract_origin
	.byte	19                              # DW_FORM_ref4
	.byte	17                              # DW_AT_low_pc
	.byte	27                              # DW_FORM_addrx
	.byte	18                              # DW_AT_high_pc
	.byte	6                               # DW_FORM_data4
	.byte	88                              # DW_AT_call_file
	.byte	11                              # DW_FORM_data1
	.byte	89                              # DW_AT_call_line
	.byte	11                              # DW_FORM_data1
	.byte	87                              # DW_AT_call_column
	.byte	11                              # DW_FORM_data1
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	10                              # Abbreviation Code
	.byte	29                              # DW_TAG_inlined_subroutine
	.byte	1                               # DW_CHILDREN_yes
	.byte	49                              # DW_AT_abstract_origin
	.byte	19                              # DW_FORM_ref4
	.byte	17                              # DW_AT_low_pc
	.byte	27                              # DW_FORM_addrx
	.byte	18                              # DW_AT_high_pc
	.byte	6                               # DW_FORM_data4
	.byte	88                              # DW_AT_call_file
	.byte	11                              # DW_FORM_data1
	.byte	89                              # DW_AT_call_line
	.byte	5                               # DW_FORM_data2
	.byte	87                              # DW_AT_call_column
	.byte	11                              # DW_FORM_data1
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	11                              # Abbreviation Code
	.byte	29                              # DW_TAG_inlined_subroutine
	.byte	0                               # DW_CHILDREN_no
	.byte	49                              # DW_AT_abstract_origin
	.byte	19                              # DW_FORM_ref4
	.byte	17                              # DW_AT_low_pc
	.byte	27                              # DW_FORM_addrx
	.byte	18                              # DW_AT_high_pc
	.byte	6                               # DW_FORM_data4
	.byte	88                              # DW_AT_call_file
	.byte	11                              # DW_FORM_data1
	.byte	89                              # DW_AT_call_line
	.byte	11                              # DW_FORM_data1
	.byte	87                              # DW_AT_call_column
	.byte	11                              # DW_FORM_data1
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	12                              # Abbreviation Code
	.byte	72                              # DW_TAG_call_site
	.byte	0                               # DW_CHILDREN_no
	.byte	127                             # DW_AT_call_origin
	.byte	19                              # DW_FORM_ref4
	.byte	125                             # DW_AT_call_return_pc
	.byte	27                              # DW_FORM_addrx
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	13                              # Abbreviation Code
	.byte	46                              # DW_TAG_subprogram
	.byte	0                               # DW_CHILDREN_no
	.byte	3                               # DW_AT_name
	.byte	37                              # DW_FORM_strx1
	.byte	58                              # DW_AT_decl_file
	.byte	11                              # DW_FORM_data1
	.byte	59                              # DW_AT_decl_line
	.byte	11                              # DW_FORM_data1
	.byte	60                              # DW_AT_declaration
	.byte	25                              # DW_FORM_flag_present
	.byte	63                              # DW_AT_external
	.byte	25                              # DW_FORM_flag_present
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	0                               # EOM(3)
	.section	.debug_info,"",@progbits
.Lcu_begin0:
	.long	.Ldebug_info_end0-.Ldebug_info_start0 # Length of Unit
.Ldebug_info_start0:
	.short	5                               # DWARF version number
	.byte	1                               # DWARF Unit Type
	.byte	8                               # Address Size (in bytes)
	.long	.debug_abbrev                   # Offset Into Abbrev. Section
	.byte	1                               # Abbrev [1] 0xc:0x1ac DW_TAG_compile_unit
	.byte	0                               # DW_AT_producer
	.short	33                              # DW_AT_language
	.byte	1                               # DW_AT_name
	.long	.Lstr_offsets_base0             # DW_AT_str_offsets_base
	.long	.Lline_table_start0             # DW_AT_stmt_list
	.byte	2                               # DW_AT_comp_dir
	.byte	0                               # DW_AT_low_pc
	.long	.Lfunc_end0-.Lfunc_begin0       # DW_AT_high_pc
	.long	.Laddr_table_base0              # DW_AT_addr_base
	.byte	2                               # Abbrev [2] 0x23:0x7 DW_TAG_variable
	.long	46                              # DW_AT_specification
	.byte	8                               # DW_AT_alignment
	.byte	6                               # DW_AT_linkage_name
	.byte	3                               # Abbrev [3] 0x2a:0xc DW_TAG_namespace
	.byte	3                               # DW_AT_name
	.byte	4                               # Abbrev [4] 0x2c:0x9 DW_TAG_class_type
	.byte	4                               # DW_AT_name
                                        # DW_AT_declaration
	.byte	5                               # Abbrev [5] 0x2e:0x6 DW_TAG_variable
	.byte	5                               # DW_AT_name
	.long	54                              # DW_AT_type
                                        # DW_AT_external
                                        # DW_AT_declaration
                                        # DW_AT_artificial
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	6                               # Abbrev [6] 0x36:0x1 DW_TAG_pointer_type
	.byte	7                               # Abbrev [7] 0x37:0x2 DW_TAG_subprogram
	.byte	7                               # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x39:0x2 DW_TAG_subprogram
	.byte	8                               # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x3b:0x2 DW_TAG_subprogram
	.byte	9                               # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x3d:0x2 DW_TAG_subprogram
	.byte	10                              # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x3f:0x2 DW_TAG_subprogram
	.byte	11                              # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x41:0x2 DW_TAG_subprogram
	.byte	12                              # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x43:0x2 DW_TAG_subprogram
	.byte	13                              # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x45:0x2 DW_TAG_subprogram
	.byte	14                              # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x47:0x2 DW_TAG_subprogram
	.byte	15                              # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x49:0x2 DW_TAG_subprogram
	.byte	16                              # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x4b:0x2 DW_TAG_subprogram
	.byte	17                              # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x4d:0x2 DW_TAG_subprogram
	.byte	18                              # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x4f:0x2 DW_TAG_subprogram
	.byte	19                              # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x51:0x2 DW_TAG_subprogram
	.byte	20                              # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x53:0x2 DW_TAG_subprogram
	.byte	20                              # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x55:0x2 DW_TAG_subprogram
	.byte	21                              # DW_AT_name
                                        # DW_AT_inline
	.byte	7                               # Abbrev [7] 0x57:0x2 DW_TAG_subprogram
	.byte	22                              # DW_AT_name
                                        # DW_AT_inline
	.byte	8                               # Abbrev [8] 0x59:0x156 DW_TAG_subprogram
	.byte	0                               # DW_AT_low_pc
	.long	.Lfunc_end0-.Lfunc_begin0       # DW_AT_high_pc
                                        # DW_AT_call_all_calls
	.byte	25                              # DW_AT_name
	.byte	9                               # Abbrev [9] 0x60:0xae DW_TAG_inlined_subroutine
	.long	65                              # DW_AT_abstract_origin
	.byte	0                               # DW_AT_low_pc
	.long	.Ltmp7-.Lfunc_begin0            # DW_AT_high_pc
	.byte	0                               # DW_AT_call_file
	.byte	7                               # DW_AT_call_line
	.byte	24                              # DW_AT_call_column
	.byte	10                              # Abbrev [10] 0x6d:0xa0 DW_TAG_inlined_subroutine
	.long	63                              # DW_AT_abstract_origin
	.byte	0                               # DW_AT_low_pc
	.long	.Ltmp7-.Lfunc_begin0            # DW_AT_high_pc
	.byte	3                               # DW_AT_call_file
	.short	277                             # DW_AT_call_line
	.byte	5                               # DW_AT_call_column
	.byte	10                              # Abbrev [10] 0x7b:0x39 DW_TAG_inlined_subroutine
	.long	61                              # DW_AT_abstract_origin
	.byte	0                               # DW_AT_low_pc
	.long	.Ltmp6-.Lfunc_begin0            # DW_AT_high_pc
	.byte	3                               # DW_AT_call_file
	.short	592                             # DW_AT_call_line
	.byte	7                               # DW_AT_call_column
	.byte	10                              # Abbrev [10] 0x89:0x2a DW_TAG_inlined_subroutine
	.long	59                              # DW_AT_abstract_origin
	.byte	0                               # DW_AT_low_pc
	.long	.Ltmp6-.Lfunc_begin0            # DW_AT_high_pc
	.byte	3                               # DW_AT_call_file
	.short	574                             # DW_AT_call_line
	.byte	25                              # DW_AT_call_column
	.byte	9                               # Abbrev [9] 0x97:0x1b DW_TAG_inlined_subroutine
	.long	57                              # DW_AT_abstract_origin
	.byte	0                               # DW_AT_low_pc
	.long	.Ltmp6-.Lfunc_begin0            # DW_AT_high_pc
	.byte	4                               # DW_AT_call_file
	.byte	41                              # DW_AT_call_line
	.byte	19                              # DW_AT_call_column
	.byte	11                              # Abbrev [11] 0xa4:0xd DW_TAG_inlined_subroutine
	.long	55                              # DW_AT_abstract_origin
	.byte	0                               # DW_AT_low_pc
	.long	.Ltmp6-.Lfunc_begin0            # DW_AT_high_pc
	.byte	5                               # DW_AT_call_file
	.byte	105                             # DW_AT_call_line
	.byte	14                              # DW_AT_call_column
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	10                              # Abbrev [10] 0xb4:0x58 DW_TAG_inlined_subroutine
	.long	77                              # DW_AT_abstract_origin
	.byte	1                               # DW_AT_low_pc
	.long	.Ltmp7-.Ltmp6                   # DW_AT_high_pc
	.byte	3                               # DW_AT_call_file
	.short	593                             # DW_AT_call_line
	.byte	7                               # DW_AT_call_column
	.byte	10                              # Abbrev [10] 0xc2:0x49 DW_TAG_inlined_subroutine
	.long	75                              # DW_AT_abstract_origin
	.byte	1                               # DW_AT_low_pc
	.long	.Ltmp7-.Ltmp6                   # DW_AT_high_pc
	.byte	3                               # DW_AT_call_file
	.short	945                             # DW_AT_call_line
	.byte	17                              # DW_AT_call_column
	.byte	10                              # Abbrev [10] 0xd0:0x3a DW_TAG_inlined_subroutine
	.long	73                              # DW_AT_abstract_origin
	.byte	1                               # DW_AT_low_pc
	.long	.Ltmp7-.Ltmp6                   # DW_AT_high_pc
	.byte	6                               # DW_AT_call_file
	.short	582                             # DW_AT_call_line
	.byte	28                              # DW_AT_call_column
	.byte	10                              # Abbrev [10] 0xde:0x2b DW_TAG_inlined_subroutine
	.long	71                              # DW_AT_abstract_origin
	.byte	1                               # DW_AT_low_pc
	.long	.Ltmp7-.Ltmp6                   # DW_AT_high_pc
	.byte	6                               # DW_AT_call_file
	.short	543                             # DW_AT_call_line
	.byte	5                               # DW_AT_call_column
	.byte	10                              # Abbrev [10] 0xec:0x1c DW_TAG_inlined_subroutine
	.long	69                              # DW_AT_abstract_origin
	.byte	1                               # DW_AT_low_pc
	.long	.Ltmp7-.Ltmp6                   # DW_AT_high_pc
	.byte	7                               # DW_AT_call_file
	.short	302                             # DW_AT_call_line
	.byte	5                               # DW_AT_call_column
	.byte	11                              # Abbrev [11] 0xfa:0xd DW_TAG_inlined_subroutine
	.long	67                              # DW_AT_abstract_origin
	.byte	1                               # DW_AT_low_pc
	.long	.Ltmp7-.Ltmp6                   # DW_AT_high_pc
	.byte	2                               # DW_AT_call_file
	.byte	46                              # DW_AT_call_line
	.byte	10                              # DW_AT_call_column
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	9                               # Abbrev [9] 0x10e:0x47 DW_TAG_inlined_subroutine
	.long	87                              # DW_AT_abstract_origin
	.byte	2                               # DW_AT_low_pc
	.long	.Ltmp12-.Ltmp11                 # DW_AT_high_pc
	.byte	0                               # DW_AT_call_file
	.byte	11                              # DW_AT_call_line
	.byte	1                               # DW_AT_call_column
	.byte	10                              # Abbrev [10] 0x11b:0x39 DW_TAG_inlined_subroutine
	.long	85                              # DW_AT_abstract_origin
	.byte	2                               # DW_AT_low_pc
	.long	.Ltmp12-.Ltmp11                 # DW_AT_high_pc
	.byte	3                               # DW_AT_call_file
	.short	262                             # DW_AT_call_line
	.byte	67                              # DW_AT_call_column
	.byte	9                               # Abbrev [9] 0x129:0x2a DW_TAG_inlined_subroutine
	.long	83                              # DW_AT_abstract_origin
	.byte	2                               # DW_AT_low_pc
	.long	.Ltmp12-.Ltmp11                 # DW_AT_high_pc
	.byte	3                               # DW_AT_call_file
	.byte	253                             # DW_AT_call_line
	.byte	9                               # DW_AT_call_column
	.byte	10                              # Abbrev [10] 0x136:0x1c DW_TAG_inlined_subroutine
	.long	81                              # DW_AT_abstract_origin
	.byte	2                               # DW_AT_low_pc
	.long	.Ltmp12-.Ltmp11                 # DW_AT_high_pc
	.byte	7                               # DW_AT_call_file
	.short	289                             # DW_AT_call_line
	.byte	9                               # DW_AT_call_column
	.byte	11                              # Abbrev [11] 0x144:0xd DW_TAG_inlined_subroutine
	.long	79                              # DW_AT_abstract_origin
	.byte	2                               # DW_AT_low_pc
	.long	.Ltmp12-.Ltmp11                 # DW_AT_high_pc
	.byte	5                               # DW_AT_call_file
	.byte	120                             # DW_AT_call_line
	.byte	7                               # DW_AT_call_column
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	9                               # Abbrev [9] 0x155:0x47 DW_TAG_inlined_subroutine
	.long	87                              # DW_AT_abstract_origin
	.byte	3                               # DW_AT_low_pc
	.long	.Ltmp15-.Ltmp13                 # DW_AT_high_pc
	.byte	0                               # DW_AT_call_file
	.byte	11                              # DW_AT_call_line
	.byte	1                               # DW_AT_call_column
	.byte	10                              # Abbrev [10] 0x162:0x39 DW_TAG_inlined_subroutine
	.long	85                              # DW_AT_abstract_origin
	.byte	3                               # DW_AT_low_pc
	.long	.Ltmp15-.Ltmp13                 # DW_AT_high_pc
	.byte	3                               # DW_AT_call_file
	.short	262                             # DW_AT_call_line
	.byte	67                              # DW_AT_call_column
	.byte	9                               # Abbrev [9] 0x170:0x2a DW_TAG_inlined_subroutine
	.long	83                              # DW_AT_abstract_origin
	.byte	3                               # DW_AT_low_pc
	.long	.Ltmp15-.Ltmp13                 # DW_AT_high_pc
	.byte	3                               # DW_AT_call_file
	.byte	253                             # DW_AT_call_line
	.byte	9                               # DW_AT_call_column
	.byte	10                              # Abbrev [10] 0x17d:0x1c DW_TAG_inlined_subroutine
	.long	81                              # DW_AT_abstract_origin
	.byte	3                               # DW_AT_low_pc
	.long	.Ltmp15-.Ltmp13                 # DW_AT_high_pc
	.byte	7                               # DW_AT_call_file
	.short	289                             # DW_AT_call_line
	.byte	9                               # DW_AT_call_column
	.byte	11                              # Abbrev [11] 0x18b:0xd DW_TAG_inlined_subroutine
	.long	79                              # DW_AT_abstract_origin
	.byte	3                               # DW_AT_low_pc
	.long	.Ltmp15-.Ltmp13                 # DW_AT_high_pc
	.byte	5                               # DW_AT_call_file
	.byte	120                             # DW_AT_call_line
	.byte	7                               # DW_AT_call_column
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	12                              # Abbrev [12] 0x19c:0x6 DW_TAG_call_site
	.long	431                             # DW_AT_call_origin
	.byte	4                               # DW_AT_call_return_pc
	.byte	12                              # Abbrev [12] 0x1a2:0x6 DW_TAG_call_site
	.long	435                             # DW_AT_call_origin
	.byte	5                               # DW_AT_call_return_pc
	.byte	12                              # Abbrev [12] 0x1a8:0x6 DW_TAG_call_site
	.long	435                             # DW_AT_call_origin
	.byte	2                               # DW_AT_call_return_pc
	.byte	0                               # End Of Children Mark
	.byte	13                              # Abbrev [13] 0x1af:0x4 DW_TAG_subprogram
	.byte	23                              # DW_AT_name
	.byte	8                               # DW_AT_decl_file
	.byte	13                              # DW_AT_decl_line
                                        # DW_AT_declaration
                                        # DW_AT_external
	.byte	13                              # Abbrev [13] 0x1b3:0x4 DW_TAG_subprogram
	.byte	24                              # DW_AT_name
	.byte	9                               # DW_AT_decl_file
	.byte	109                             # DW_AT_decl_line
                                        # DW_AT_declaration
                                        # DW_AT_external
	.byte	0                               # End Of Children Mark
.Ldebug_info_end0:
	.section	.debug_str_offsets,"",@progbits
	.long	108                             # Length of String Offsets Set
	.short	5
	.short	0
.Lstr_offsets_base0:
	.section	.debug_str,"MS",@progbits,1
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
	.asciz	"__allocate_at_least<std::__1::allocator<Point> >" # string offset=122
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
	.asciz	"__uninitialized_allocator_copy_impl<std::__1::allocator<Point>, const Point *, const Point *, Point *>" # string offset=362
.Linfo_string17:
	.asciz	"__uninitialized_allocator_copy<std::__1::allocator<Point>, const Point *, const Point *, Point *>" # string offset=465
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
	.section	.debug_str_offsets,"",@progbits
	.long	.Linfo_string0
	.long	.Linfo_string1
	.long	.Linfo_string2
	.long	.Linfo_string3
	.long	.Linfo_string4
	.long	.Linfo_string5
	.long	.Linfo_string6
	.long	.Linfo_string7
	.long	.Linfo_string8
	.long	.Linfo_string9
	.long	.Linfo_string10
	.long	.Linfo_string11
	.long	.Linfo_string12
	.long	.Linfo_string13
	.long	.Linfo_string14
	.long	.Linfo_string15
	.long	.Linfo_string16
	.long	.Linfo_string17
	.long	.Linfo_string18
	.long	.Linfo_string19
	.long	.Linfo_string20
	.long	.Linfo_string21
	.long	.Linfo_string22
	.long	.Linfo_string23
	.long	.Linfo_string24
	.long	.Linfo_string25
	.section	.debug_addr,"",@progbits
	.long	.Ldebug_addr_end0-.Ldebug_addr_start0 # Length of contribution
.Ldebug_addr_start0:
	.short	5                               # DWARF version number
	.byte	8                               # Address size
	.byte	0                               # Segment selector size
.Laddr_table_base0:
	.quad	.Lfunc_begin0
	.quad	.Ltmp6
	.quad	.Ltmp11
	.quad	.Ltmp13
	.quad	.Ltmp8
	.quad	.Ltmp9
.Ldebug_addr_end0:
	.hidden	DW.ref.__gxx_personality_v0
	.weak	DW.ref.__gxx_personality_v0
	.section	.data.DW.ref.__gxx_personality_v0,"awG",@progbits,DW.ref.__gxx_personality_v0,comdat
	.p2align	3, 0x0
	.type	DW.ref.__gxx_personality_v0,@object
	.size	DW.ref.__gxx_personality_v0, 8
DW.ref.__gxx_personality_v0:
	.quad	__gxx_personality_v0
	.ident	"clang version 21.1.8"
	.section	".note.GNU-stack","",@progbits
	.addrsig
	.addrsig_sym __gxx_personality_v0
	.addrsig_sym _Unwind_Resume
	.section	.debug_line,"",@progbits
.Lline_table_start0:
