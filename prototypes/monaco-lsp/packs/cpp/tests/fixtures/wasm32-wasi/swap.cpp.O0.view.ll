; ModuleID = 'swap.cpp'
source_filename = "swap.cpp"
target datalayout = "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20"
target triple = "wasm32-unknown-wasip1"

$_ZNSt3__24swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_ = comdat any

@__main_void = hidden alias i32 (), ptr @main

; Function Attrs: mustprogress noinline norecurse nounwind optnone
define hidden noundef i32 @main() #0 !dbg !6 {
entry:
  %retval = alloca i32, align 4
  %a = alloca i32, align 4
  %b = alloca i32, align 4
  store i32 0, ptr %retval, align 4
  store i32 1, ptr %a, align 4, !dbg !9
  store i32 2, ptr %b, align 4, !dbg !10
  call void @_ZNSt3__24swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_(ptr noundef nonnull align 4 dereferenceable(4) %a, ptr noundef nonnull align 4 dereferenceable(4) %b) #2, !dbg !11
  %0 = load i32, ptr %a, align 4, !dbg !12
  ret i32 %0, !dbg !13
}

; Function Attrs: mustprogress noinline nounwind optnone
define linkonce_odr hidden void @_ZNSt3__24swapB8fe210108IiEENS_9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS2_EE5valueEvE4typeERS2_S5_(ptr noundef nonnull align 4 dereferenceable(4) %__x, ptr noundef nonnull align 4 dereferenceable(4) %__y) #1 comdat !dbg !14 {
entry:
  %__x.addr = alloca ptr, align 4
  %__y.addr = alloca ptr, align 4
  %__t = alloca i32, align 4
  store ptr %__x, ptr %__x.addr, align 4
  store ptr %__y, ptr %__y.addr, align 4
  %0 = load ptr, ptr %__x.addr, align 4, !dbg !16, !nonnull !8, !align !17
  %1 = load i32, ptr %0, align 4, !dbg !18
  store i32 %1, ptr %__t, align 4, !dbg !19
  %2 = load ptr, ptr %__y.addr, align 4, !dbg !20, !nonnull !8, !align !17
  %3 = load i32, ptr %2, align 4, !dbg !21
  %4 = load ptr, ptr %__x.addr, align 4, !dbg !22, !nonnull !8, !align !17
  store i32 %3, ptr %4, align 4, !dbg !23
  %5 = load i32, ptr %__t, align 4, !dbg !24
  %6 = load ptr, ptr %__y.addr, align 4, !dbg !25, !nonnull !8, !align !17
  store i32 %5, ptr %6, align 4, !dbg !26
  ret void, !dbg !27
}

attributes #0 = { mustprogress noinline norecurse nounwind optnone "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+exception-handling,+multivalue,+mutable-globals,+nontrapping-fptoint,+reference-types,+sign-ext" }
attributes #1 = { mustprogress noinline nounwind optnone "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+exception-handling,+multivalue,+mutable-globals,+nontrapping-fptoint,+reference-types,+sign-ext" }
attributes #2 = { nounwind }

!llvm.dbg.cu = !{!0}
!llvm.module.flags = !{!2, !3, !4}
!llvm.ident = !{!5}

!0 = distinct !DICompileUnit(language: DW_LANG_C_plus_plus_14, file: !1, producer: "clang version 21.1.8", isOptimized: false, runtimeVersion: 0, emissionKind: LineTablesOnly, splitDebugInlining: false, nameTableKind: None)
!1 = !DIFile(filename: "swap.cpp", directory: "/workspace")
!2 = !{i32 7, !"Dwarf Version", i32 4}
!3 = !{i32 2, !"Debug Info Version", i32 3}
!4 = !{i32 1, !"wchar_size", i32 4}
!5 = !{!"clang version 21.1.8"}
!6 = distinct !DISubprogram(name: "main", scope: !1, file: !1, line: 3, type: !7, scopeLine: 3, flags: DIFlagPrototyped, spFlags: DISPFlagDefinition, unit: !0)
!7 = !DISubroutineType(types: !8)
!8 = !{}
!9 = !DILocation(line: 4, column: 9, scope: !6)
!10 = !DILocation(line: 4, column: 16, scope: !6)
!11 = !DILocation(line: 5, column: 5, scope: !6)
!12 = !DILocation(line: 6, column: 12, scope: !6)
!13 = !DILocation(line: 6, column: 5, scope: !6)
!14 = distinct !DISubprogram(name: "swap<int>", scope: !15, file: !15, line: 41, type: !7, scopeLine: 42, flags: DIFlagPrototyped, spFlags: DISPFlagDefinition, unit: !0)
!15 = !DIFile(filename: "/wasi/include/wasm32-wasip1/c++/v1/__utility/swap.h", directory: "")
!16 = !DILocation(line: 43, column: 21, scope: !14)
!17 = !{i64 4}
!18 = !DILocation(line: 43, column: 11, scope: !14)
!19 = !DILocation(line: 43, column: 7, scope: !14)
!20 = !DILocation(line: 44, column: 19, scope: !14)
!21 = !DILocation(line: 44, column: 9, scope: !14)
!22 = !DILocation(line: 44, column: 3, scope: !14)
!23 = !DILocation(line: 44, column: 7, scope: !14)
!24 = !DILocation(line: 45, column: 9, scope: !14)
!25 = !DILocation(line: 45, column: 3, scope: !14)
!26 = !DILocation(line: 45, column: 7, scope: !14)
!27 = !DILocation(line: 46, column: 1, scope: !14)
