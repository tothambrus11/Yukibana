; ModuleID = 'geometry.cpp'
source_filename = "geometry.cpp"
target datalayout = "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20"
target triple = "wasm32-unknown-wasip1"

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: read)
define hidden noundef double @_ZNK5Point4normEv(ptr noundef nonnull readonly align 8 captures(none) dereferenceable(16) %this) local_unnamed_addr #0 !dbg !6 {
entry:
  %0 = load double, ptr %this, align 8, !dbg !9, !tbaa !10
  %y = getelementptr inbounds nuw i8, ptr %this, i32 8, !dbg !15
  %1 = load double, ptr %y, align 8, !dbg !15, !tbaa !16
  %call = tail call double @hypot(double noundef %0, double noundef %1) #2, !dbg !17
  ret double %call, !dbg !18
}

; Function Attrs: mustprogress nocallback nofree nosync nounwind willreturn memory(none)
declare !dbg !19 double @hypot(double noundef, double noundef) local_unnamed_addr #1

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: read)
define hidden noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull readonly align 8 captures(none) dereferenceable(16) %a, ptr noundef nonnull readonly align 8 captures(none) dereferenceable(16) %b) local_unnamed_addr #0 !dbg !21 {
entry:
  %0 = load double, ptr %a, align 8, !dbg !22, !tbaa !10
  %1 = load double, ptr %b, align 8, !dbg !23, !tbaa !10
  %sub = fsub double %0, %1, !dbg !24
  %y = getelementptr inbounds nuw i8, ptr %a, i32 8, !dbg !25
  %2 = load double, ptr %y, align 8, !dbg !25, !tbaa !16
  %y2 = getelementptr inbounds nuw i8, ptr %b, i32 8, !dbg !26
  %3 = load double, ptr %y2, align 8, !dbg !26, !tbaa !16
  %sub3 = fsub double %2, %3, !dbg !27
  %call = tail call double @hypot(double noundef %sub, double noundef %sub3) #2, !dbg !28
  ret double %call, !dbg !29
}

attributes #0 = { mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: read) "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+exception-handling,+multivalue,+mutable-globals,+nontrapping-fptoint,+reference-types,+sign-ext" }
attributes #1 = { mustprogress nocallback nofree nosync nounwind willreturn memory(none) "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+exception-handling,+multivalue,+mutable-globals,+nontrapping-fptoint,+reference-types,+sign-ext" }
attributes #2 = { nounwind willreturn memory(none) }

!llvm.dbg.cu = !{!0}
!llvm.module.flags = !{!2, !3, !4}
!llvm.ident = !{!5}

!0 = distinct !DICompileUnit(language: DW_LANG_C_plus_plus_14, file: !1, producer: "clang version 21.1.8", isOptimized: true, runtimeVersion: 0, emissionKind: LineTablesOnly, splitDebugInlining: false, nameTableKind: None)
!1 = !DIFile(filename: "geometry.cpp", directory: "/workspace")
!2 = !{i32 7, !"Dwarf Version", i32 4}
!3 = !{i32 2, !"Debug Info Version", i32 3}
!4 = !{i32 1, !"wchar_size", i32 4}
!5 = !{!"clang version 21.1.8"}
!6 = distinct !DISubprogram(name: "norm", scope: !1, file: !1, line: 5, type: !7, scopeLine: 5, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!7 = !DISubroutineType(types: !8)
!8 = !{}
!9 = !DILocation(line: 5, column: 48, scope: !6)
!10 = !{!11, !12, i64 0}
!11 = !{!"_ZTS5Point", !12, i64 0, !12, i64 8}
!12 = !{!"double", !13, i64 0}
!13 = !{!"omnipotent char", !14, i64 0}
!14 = !{!"Simple C++ TBAA"}
!15 = !DILocation(line: 5, column: 51, scope: !6)
!16 = !{!11, !12, i64 8}
!17 = !DILocation(line: 5, column: 37, scope: !6)
!18 = !DILocation(line: 5, column: 30, scope: !6)
!19 = !DISubprogram(name: "hypot", scope: !20, file: !20, line: 252, type: !7, flags: DIFlagPrototyped, spFlags: DISPFlagOptimized)
!20 = !DIFile(filename: "/wasi/include/wasm32-wasip1/math.h", directory: "")
!21 = distinct !DISubprogram(name: "distance", scope: !1, file: !1, line: 7, type: !7, scopeLine: 7, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!22 = !DILocation(line: 8, column: 25, scope: !21)
!23 = !DILocation(line: 8, column: 31, scope: !21)
!24 = !DILocation(line: 8, column: 27, scope: !21)
!25 = !DILocation(line: 8, column: 36, scope: !21)
!26 = !DILocation(line: 8, column: 42, scope: !21)
!27 = !DILocation(line: 8, column: 38, scope: !21)
!28 = !DILocation(line: 8, column: 12, scope: !21)
!29 = !DILocation(line: 8, column: 5, scope: !21)
