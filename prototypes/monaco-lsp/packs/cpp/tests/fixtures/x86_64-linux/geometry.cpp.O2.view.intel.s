	.intel_syntax noprefix
	.file	"geometry.cpp"
	.text
	.globl	_ZNK5Point4normEv               # -- Begin function _ZNK5Point4normEv
	.p2align	4
	.type	_ZNK5Point4normEv,@function
_ZNK5Point4normEv:                      # @_ZNK5Point4normEv
.Lfunc_begin0:
	.file	0 "/workspace" "geometry.cpp" md5 0x4ccac6c7ef22f19ec4699ab46905af57
	.cfi_startproc
# %bb.0:                                # %entry
	.loc	0 5 48 prologue_end             # geometry.cpp:5:48
	movsd	xmm0, qword ptr [rdi]           # xmm0 = mem[0],zero
	.loc	0 5 51 is_stmt 0                # geometry.cpp:5:51
	movsd	xmm1, qword ptr [rdi + 8]       # xmm1 = mem[0],zero
.Ltmp0:
	.loc	0 5 37                          # geometry.cpp:5:37
	jmp	hypot@PLT                       # TAILCALL
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
	.cfi_startproc
# %bb.0:                                # %entry
	.loc	0 8 25 prologue_end is_stmt 1   # geometry.cpp:8:25
	movsd	xmm0, qword ptr [rdi]           # xmm0 = mem[0],zero
	.loc	0 8 36 is_stmt 0                # geometry.cpp:8:36
	movsd	xmm1, qword ptr [rdi + 8]       # xmm1 = mem[0],zero
	.loc	0 8 27                          # geometry.cpp:8:27
	subsd	xmm0, qword ptr [rsi]
	.loc	0 8 38                          # geometry.cpp:8:38
	subsd	xmm1, qword ptr [rsi + 8]
.Ltmp2:
	.loc	0 8 12                          # geometry.cpp:8:12
	jmp	hypot@PLT                       # TAILCALL
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
	.section	.debug_line,"",@progbits
.Lline_table_start0:
