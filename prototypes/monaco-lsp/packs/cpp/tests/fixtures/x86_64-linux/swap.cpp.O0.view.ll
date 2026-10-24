; ModuleID = 'swap.cpp'
source_filename = "swap.cpp"
target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128"
target triple = "x86_64-unknown-linux-musl"

$_ZNSt3__14swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_ = comdat any

; Function Attrs: mustprogress noinline norecurse nounwind optnone uwtable
define dso_local noundef i32 @main() #0 !dbg !10 {
entry:
  %retval = alloca i32, align 4
  %a = alloca i32, align 4
  %b = alloca i32, align 4
  store i32 0, ptr %retval, align 4
  store i32 1, ptr %a, align 4, !dbg !13
  store i32 2, ptr %b, align 4, !dbg !14
  call void @_ZNSt3__14swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_(ptr noundef nonnull align 4 dereferenceable(4) %a, ptr noundef nonnull align 4 dereferenceable(4) %b) #2, !dbg !15
  %0 = load i32, ptr %a, align 4, !dbg !16
  ret i32 %0, !dbg !17
}

; Function Attrs: mustprogress noinline nounwind optnone uwtable
define linkonce_odr hidden void @_ZNSt3__14swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_(ptr noundef nonnull align 4 dereferenceable(4) %__x, ptr noundef nonnull align 4 dereferenceable(4) %__y) #1 comdat !dbg !18 {
entry:
  %__x.addr = alloca ptr, align 8
  %__y.addr = alloca ptr, align 8
  %__t = alloca i32, align 4
  store ptr %__x, ptr %__x.addr, align 8
  store ptr %__y, ptr %__y.addr, align 8
  %0 = load ptr, ptr %__x.addr, align 8, !dbg !20, !nonnull !12, !align !21
  %1 = load i32, ptr %0, align 4, !dbg !22
  store i32 %1, ptr %__t, align 4, !dbg !23
  %2 = load ptr, ptr %__y.addr, align 8, !dbg !24, !nonnull !12, !align !21
  %3 = load i32, ptr %2, align 4, !dbg !25
  %4 = load ptr, ptr %__x.addr, align 8, !dbg !26, !nonnull !12, !align !21
  store i32 %3, ptr %4, align 4, !dbg !27
  %5 = load i32, ptr %__t, align 4, !dbg !28
  %6 = load ptr, ptr %__y.addr, align 8, !dbg !29, !nonnull !12, !align !21
  store i32 %5, ptr %6, align 4, !dbg !30
  ret void, !dbg !31
}

attributes #0 = { mustprogress noinline norecurse nounwind optnone uwtable "frame-pointer"="all" "min-legal-vector-width"="0" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #1 = { mustprogress noinline nounwind optnone uwtable "frame-pointer"="all" "min-legal-vector-width"="0" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #2 = { nounwind }

!llvm.dbg.cu = !{!0}
!llvm.module.flags = !{!2, !3, !4, !5, !6, !7, !8}
!llvm.ident = !{!9}

!0 = distinct !DICompileUnit(language: DW_LANG_C_plus_plus_14, file: !1, producer: "clang version 21.1.8", isOptimized: false, runtimeVersion: 0, emissionKind: LineTablesOnly, splitDebugInlining: false, nameTableKind: None)
!1 = !DIFile(filename: "swap.cpp", directory: "/workspace", checksumkind: CSK_MD5, checksum: "e43dc361acd84e8841a260fde1dc29f8")
!2 = !{i32 7, !"Dwarf Version", i32 5}
!3 = !{i32 2, !"Debug Info Version", i32 3}
!4 = !{i32 1, !"wchar_size", i32 4}
!5 = !{i32 8, !"PIC Level", i32 2}
!6 = !{i32 7, !"PIE Level", i32 2}
!7 = !{i32 7, !"uwtable", i32 2}
!8 = !{i32 7, !"frame-pointer", i32 2}
!9 = !{!"clang version 21.1.8"}
!10 = distinct !DISubprogram(name: "main", scope: !1, file: !1, line: 3, type: !11, scopeLine: 3, flags: DIFlagPrototyped, spFlags: DISPFlagDefinition, unit: !0)
!11 = !DISubroutineType(types: !12)
!12 = !{}
!13 = !DILocation(line: 4, column: 9, scope: !10)
!14 = !DILocation(line: 4, column: 16, scope: !10)
!15 = !DILocation(line: 5, column: 5, scope: !10)
!16 = !DILocation(line: 6, column: 12, scope: !10)
!17 = !DILocation(line: 6, column: 5, scope: !10)
!18 = distinct !DISubprogram(name: "swap<int>", scope: !19, file: !19, line: 41, type: !11, scopeLine: 42, flags: DIFlagPrototyped, spFlags: DISPFlagDefinition, unit: !0)
!19 = !DIFile(filename: "/usr/include/c++/v1/__utility/swap.h", directory: "")
!20 = !DILocation(line: 43, column: 21, scope: !18)
!21 = !{i64 4}
!22 = !DILocation(line: 43, column: 11, scope: !18)
!23 = !DILocation(line: 43, column: 7, scope: !18)
!24 = !DILocation(line: 44, column: 19, scope: !18)
!25 = !DILocation(line: 44, column: 9, scope: !18)
!26 = !DILocation(line: 44, column: 3, scope: !18)
!27 = !DILocation(line: 44, column: 7, scope: !18)
!28 = !DILocation(line: 45, column: 9, scope: !18)
!29 = !DILocation(line: 45, column: 3, scope: !18)
!30 = !DILocation(line: 45, column: 7, scope: !18)
!31 = !DILocation(line: 46, column: 1, scope: !18)
