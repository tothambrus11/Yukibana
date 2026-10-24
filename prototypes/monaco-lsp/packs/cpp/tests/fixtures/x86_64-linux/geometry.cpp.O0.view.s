	.file	"geometry.cpp"
	.text
	.globl	_ZNK5Point4normEv               # -- Begin function _ZNK5Point4normEv
	.p2align	4
	.type	_ZNK5Point4normEv,@function
_ZNK5Point4normEv:                      # @_ZNK5Point4normEv
.Lfunc_begin0:
	.file	0 "/workspace" "geometry.cpp" md5 0x4ccac6c7ef22f19ec4699ab46905af57
	.loc	0 5 0                           # geometry.cpp:5:0
	.cfi_startproc
# %bb.0:                                # %entry
	pushq	%rbp
	.cfi_def_cfa_offset 16
	.cfi_offset %rbp, -16
	movq	%rsp, %rbp
	.cfi_def_cfa_register %rbp
	subq	$16, %rsp
	movq	%rdi, -8(%rbp)
	movq	-8(%rbp), %rax
.Ltmp0:
	.loc	0 5 48 prologue_end             # geometry.cpp:5:48
	movsd	(%rax), %xmm0                   # xmm0 = mem[0],zero
	.loc	0 5 51 is_stmt 0                # geometry.cpp:5:51
	movsd	8(%rax), %xmm1                  # xmm1 = mem[0],zero
	.loc	0 5 37                          # geometry.cpp:5:37
	callq	hypot@PLT
	.loc	0 5 30 epilogue_begin           # geometry.cpp:5:30
	addq	$16, %rsp
	popq	%rbp
	.cfi_def_cfa %rsp, 8
	retq
.Ltmp1:
.Lfunc_end0:
	.size	_ZNK5Point4normEv, .Lfunc_end0-_ZNK5Point4normEv
	.cfi_endproc
                                        # -- End function
	.globl	_Z8distanceRK5PointS1_          # -- Begin function _Z8distanceRK5PointS1_
	.p2align	4
	.type	_Z8distanceRK5PointS1_,@function
_Z8distanceRK5PointS1_:                 # @_Z8distanceRK5PointS1_
.Lfunc_begin1:
	.loc	0 7 0 is_stmt 1                 # geometry.cpp:7:0
	.cfi_startproc
# %bb.0:                                # %entry
	pushq	%rbp
	.cfi_def_cfa_offset 16
	.cfi_offset %rbp, -16
	movq	%rsp, %rbp
	.cfi_def_cfa_register %rbp
	subq	$16, %rsp
	movq	%rdi, -8(%rbp)
	movq	%rsi, -16(%rbp)
.Ltmp2:
	.loc	0 8 23 prologue_end             # geometry.cpp:8:23
	movq	-8(%rbp), %rax
	.loc	0 8 25 is_stmt 0                # geometry.cpp:8:25
	movsd	(%rax), %xmm0                   # xmm0 = mem[0],zero
	.loc	0 8 29                          # geometry.cpp:8:29
	movq	-16(%rbp), %rax
	.loc	0 8 27                          # geometry.cpp:8:27
	subsd	(%rax), %xmm0
	.loc	0 8 34                          # geometry.cpp:8:34
	movq	-8(%rbp), %rax
	.loc	0 8 36                          # geometry.cpp:8:36
	movsd	8(%rax), %xmm1                  # xmm1 = mem[0],zero
	.loc	0 8 40                          # geometry.cpp:8:40
	movq	-16(%rbp), %rax
	.loc	0 8 38                          # geometry.cpp:8:38
	subsd	8(%rax), %xmm1
	.loc	0 8 12                          # geometry.cpp:8:12
	callq	hypot@PLT
	.loc	0 8 5 epilogue_begin            # geometry.cpp:8:5
	addq	$16, %rsp
	popq	%rbp
	.cfi_def_cfa %rsp, 8
	retq
.Ltmp3:
.Lfunc_end1:
	.size	_Z8distanceRK5PointS1_, .Lfunc_end1-_Z8distanceRK5PointS1_
	.cfi_endproc
                                        # -- End function
	.section	.debug_abbrev,"",@progbits
	.byte	1                               # Abbreviation Code
	.byte	17                              # DW_TAG_compile_unit
	.byte	0                               # DW_CHILDREN_no
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
	.byte	0                               # EOM(3)
	.section	.debug_info,"",@progbits
.Lcu_begin0:
	.long	.Ldebug_info_end0-.Ldebug_info_start0 # Length of Unit
.Ldebug_info_start0:
	.short	5                               # DWARF version number
	.byte	1                               # DWARF Unit Type
	.byte	8                               # Address Size (in bytes)
	.long	.debug_abbrev                   # Offset Into Abbrev. Section
	.byte	1                               # Abbrev [1] 0xc:0x17 DW_TAG_compile_unit
	.byte	0                               # DW_AT_producer
	.short	33                              # DW_AT_language
	.byte	1                               # DW_AT_name
	.long	.Lstr_offsets_base0             # DW_AT_str_offsets_base
	.long	.Lline_table_start0             # DW_AT_stmt_list
	.byte	2                               # DW_AT_comp_dir
	.byte	0                               # DW_AT_low_pc
	.long	.Lfunc_end1-.Lfunc_begin0       # DW_AT_high_pc
	.long	.Laddr_table_base0              # DW_AT_addr_base
.Ldebug_info_end0:
	.section	.debug_str_offsets,"",@progbits
	.long	16                              # Length of String Offsets Set
	.short	5
	.short	0
.Lstr_offsets_base0:
	.section	.debug_str,"MS",@progbits,1
.Linfo_string0:
	.asciz	"clang version 21.1.8"          # string offset=0
.Linfo_string1:
	.asciz	"geometry.cpp"                  # string offset=21
.Linfo_string2:
	.asciz	"/workspace"                    # string offset=34
	.section	.debug_str_offsets,"",@progbits
	.long	.Linfo_string0
	.long	.Linfo_string1
	.long	.Linfo_string2
	.section	.debug_addr,"",@progbits
	.long	.Ldebug_addr_end0-.Ldebug_addr_start0 # Length of contribution
.Ldebug_addr_start0:
	.short	5                               # DWARF version number
	.byte	8                               # Address size
	.byte	0                               # Segment selector size
.Laddr_table_base0:
	.quad	.Lfunc_begin0
.Ldebug_addr_end0:
	.ident	"clang version 21.1.8"
	.section	".note.GNU-stack","",@progbits
	.addrsig
	.addrsig_sym hypot
	.section	.debug_line,"",@progbits
.Lline_table_start0:
