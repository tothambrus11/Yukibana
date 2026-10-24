; ModuleID = 'geometry.cpp'
source_filename = "geometry.cpp"
target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i8:8:32-i16:16:32-i64:64-i128:128-n32:64-S128-Fn32"
target triple = "aarch64-unknown-linux-musl"

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: read) uwtable
define dso_local noundef double @_ZNK5Point4normEv(ptr noundef nonnull readonly align 8 captures(none) dereferenceable(16) %this) local_unnamed_addr #0 !dbg !10 {
entry:
  %0 = load double, ptr %this, align 8, !dbg !13, !tbaa !14
  %y = getelementptr inbounds nuw i8, ptr %this, i64 8, !dbg !19
  %1 = load double, ptr %y, align 8, !dbg !19, !tbaa !20
  %call = tail call double @hypot(double noundef %0, double noundef %1) #2, !dbg !21
  ret double %call, !dbg !22
}

; Function Attrs: mustprogress nocallback nofree nosync nounwind willreturn memory(none)
declare !dbg !23 double @hypot(double noundef, double noundef) local_unnamed_addr #1

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: read) uwtable
define dso_local noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull readonly align 8 captures(none) dereferenceable(16) %a, ptr noundef nonnull readonly align 8 captures(none) dereferenceable(16) %b) local_unnamed_addr #0 !dbg !25 {
entry:
  %0 = load double, ptr %a, align 8, !dbg !26, !tbaa !14
  %1 = load double, ptr %b, align 8, !dbg !27, !tbaa !14
  %sub = fsub double %0, %1, !dbg !28
  %y = getelementptr inbounds nuw i8, ptr %a, i64 8, !dbg !29
  %2 = load double, ptr %y, align 8, !dbg !29, !tbaa !20
  %y2 = getelementptr inbounds nuw i8, ptr %b, i64 8, !dbg !30
  %3 = load double, ptr %y2, align 8, !dbg !30, !tbaa !20
  %sub3 = fsub double %2, %3, !dbg !31
  %call = tail call double @hypot(double noundef %sub, double noundef %sub3) #2, !dbg !32
  ret double %call, !dbg !33
}

attributes #0 = { mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: read) uwtable "frame-pointer"="non-leaf" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+fp-armv8,+neon,+outline-atomics,+v8a" }
attributes #1 = { mustprogress nocallback nofree nosync nounwind willreturn memory(none) "frame-pointer"="non-leaf" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+fp-armv8,+neon,+outline-atomics,+v8a" }
attributes #2 = { nounwind willreturn memory(none) }

!llvm.dbg.cu = !{!0}
!llvm.module.flags = !{!2, !3, !4, !5, !6, !7, !8}
!llvm.ident = !{!9}

!0 = distinct !DICompileUnit(language: DW_LANG_C_plus_plus_14, file: !1, producer: "clang version 21.1.8", isOptimized: true, runtimeVersion: 0, emissionKind: LineTablesOnly, splitDebugInlining: false, nameTableKind: None)
!1 = !DIFile(filename: "geometry.cpp", directory: "/workspace", checksumkind: CSK_MD5, checksum: "4ccac6c7ef22f19ec4699ab46905af57")
!2 = !{i32 7, !"Dwarf Version", i32 5}
!3 = !{i32 2, !"Debug Info Version", i32 3}
!4 = !{i32 1, !"wchar_size", i32 4}
!5 = !{i32 8, !"PIC Level", i32 2}
!6 = !{i32 7, !"PIE Level", i32 2}
!7 = !{i32 7, !"uwtable", i32 2}
!8 = !{i32 7, !"frame-pointer", i32 1}
!9 = !{!"clang version 21.1.8"}
!10 = distinct !DISubprogram(name: "norm", scope: !1, file: !1, line: 5, type: !11, scopeLine: 5, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!11 = !DISubroutineType(types: !12)
!12 = !{}
!13 = !DILocation(line: 5, column: 48, scope: !10)
!14 = !{!15, !16, i64 0}
!15 = !{!"_ZTS5Point", !16, i64 0, !16, i64 8}
!16 = !{!"double", !17, i64 0}
!17 = !{!"omnipotent char", !18, i64 0}
!18 = !{!"Simple C++ TBAA"}
!19 = !DILocation(line: 5, column: 51, scope: !10)
!20 = !{!15, !16, i64 8}
!21 = !DILocation(line: 5, column: 37, scope: !10)
!22 = !DILocation(line: 5, column: 30, scope: !10)
!23 = !DISubprogram(name: "hypot", scope: !24, file: !24, line: 235, type: !11, flags: DIFlagPrototyped, spFlags: DISPFlagOptimized)
!24 = !DIFile(filename: "/usr/include/math.h", directory: "", checksumkind: CSK_MD5, checksum: "95f1091aa5c39bead584db7c48e5913d")
!25 = distinct !DISubprogram(name: "distance", scope: !1, file: !1, line: 7, type: !11, scopeLine: 7, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!26 = !DILocation(line: 8, column: 25, scope: !25)
!27 = !DILocation(line: 8, column: 31, scope: !25)
!28 = !DILocation(line: 8, column: 27, scope: !25)
!29 = !DILocation(line: 8, column: 36, scope: !25)
!30 = !DILocation(line: 8, column: 42, scope: !25)
!31 = !DILocation(line: 8, column: 38, scope: !25)
!32 = !DILocation(line: 8, column: 12, scope: !25)
!33 = !DILocation(line: 8, column: 5, scope: !25)
