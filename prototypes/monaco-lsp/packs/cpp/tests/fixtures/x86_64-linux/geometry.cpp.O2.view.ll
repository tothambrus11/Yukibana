; ModuleID = 'geometry.cpp'
source_filename = "geometry.cpp"
target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128"
target triple = "x86_64-unknown-linux-musl"

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: read) uwtable
define dso_local noundef double @_ZNK5Point4normEv(ptr noundef nonnull readonly align 8 captures(none) dereferenceable(16) %this) local_unnamed_addr #0 align 2 !dbg !9 {
entry:
  %0 = load double, ptr %this, align 8, !dbg !12, !tbaa !13
  %y = getelementptr inbounds nuw i8, ptr %this, i64 8, !dbg !18
  %1 = load double, ptr %y, align 8, !dbg !18, !tbaa !19
  %call = tail call double @hypot(double noundef %0, double noundef %1) #2, !dbg !20
  ret double %call, !dbg !21
}

; Function Attrs: mustprogress nocallback nofree nosync nounwind willreturn memory(none)
declare !dbg !22 double @hypot(double noundef, double noundef) local_unnamed_addr #1

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: read) uwtable
define dso_local noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull readonly align 8 captures(none) dereferenceable(16) %a, ptr noundef nonnull readonly align 8 captures(none) dereferenceable(16) %b) local_unnamed_addr #0 !dbg !24 {
entry:
  %0 = load double, ptr %a, align 8, !dbg !25, !tbaa !13
  %1 = load double, ptr %b, align 8, !dbg !26, !tbaa !13
  %sub = fsub double %0, %1, !dbg !27
  %y = getelementptr inbounds nuw i8, ptr %a, i64 8, !dbg !28
  %2 = load double, ptr %y, align 8, !dbg !28, !tbaa !19
  %y2 = getelementptr inbounds nuw i8, ptr %b, i64 8, !dbg !29
  %3 = load double, ptr %y2, align 8, !dbg !29, !tbaa !19
  %sub3 = fsub double %2, %3, !dbg !30
  %call = tail call double @hypot(double noundef %sub, double noundef %sub3) #2, !dbg !31
  ret double %call, !dbg !32
}

attributes #0 = { mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: read) uwtable "min-legal-vector-width"="0" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #1 = { mustprogress nocallback nofree nosync nounwind willreturn memory(none) "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #2 = { nounwind willreturn memory(none) }

!llvm.dbg.cu = !{!0}
!llvm.module.flags = !{!2, !3, !4, !5, !6, !7}
!llvm.ident = !{!8}

!0 = distinct !DICompileUnit(language: DW_LANG_C_plus_plus_14, file: !1, producer: "clang version 21.1.8", isOptimized: true, runtimeVersion: 0, emissionKind: LineTablesOnly, splitDebugInlining: false, nameTableKind: None)
!1 = !DIFile(filename: "geometry.cpp", directory: "/workspace", checksumkind: CSK_MD5, checksum: "4ccac6c7ef22f19ec4699ab46905af57")
!2 = !{i32 7, !"Dwarf Version", i32 5}
!3 = !{i32 2, !"Debug Info Version", i32 3}
!4 = !{i32 1, !"wchar_size", i32 4}
!5 = !{i32 8, !"PIC Level", i32 2}
!6 = !{i32 7, !"PIE Level", i32 2}
!7 = !{i32 7, !"uwtable", i32 2}
!8 = !{!"clang version 21.1.8"}
!9 = distinct !DISubprogram(name: "norm", scope: !1, file: !1, line: 5, type: !10, scopeLine: 5, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!10 = !DISubroutineType(types: !11)
!11 = !{}
!12 = !DILocation(line: 5, column: 48, scope: !9)
!13 = !{!14, !15, i64 0}
!14 = !{!"_ZTS5Point", !15, i64 0, !15, i64 8}
!15 = !{!"double", !16, i64 0}
!16 = !{!"omnipotent char", !17, i64 0}
!17 = !{!"Simple C++ TBAA"}
!18 = !DILocation(line: 5, column: 51, scope: !9)
!19 = !{!14, !15, i64 8}
!20 = !DILocation(line: 5, column: 37, scope: !9)
!21 = !DILocation(line: 5, column: 30, scope: !9)
!22 = !DISubprogram(name: "hypot", scope: !23, file: !23, line: 235, type: !10, flags: DIFlagPrototyped, spFlags: DISPFlagOptimized)
!23 = !DIFile(filename: "/usr/include/math.h", directory: "", checksumkind: CSK_MD5, checksum: "95f1091aa5c39bead584db7c48e5913d")
!24 = distinct !DISubprogram(name: "distance", scope: !1, file: !1, line: 7, type: !10, scopeLine: 7, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!25 = !DILocation(line: 8, column: 25, scope: !24)
!26 = !DILocation(line: 8, column: 31, scope: !24)
!27 = !DILocation(line: 8, column: 27, scope: !24)
!28 = !DILocation(line: 8, column: 36, scope: !24)
!29 = !DILocation(line: 8, column: 42, scope: !24)
!30 = !DILocation(line: 8, column: 38, scope: !24)
!31 = !DILocation(line: 8, column: 12, scope: !24)
!32 = !DILocation(line: 8, column: 5, scope: !24)
