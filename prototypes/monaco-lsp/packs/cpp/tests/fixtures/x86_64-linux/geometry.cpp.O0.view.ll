; ModuleID = 'geometry.cpp'
source_filename = "geometry.cpp"
target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128"
target triple = "x86_64-unknown-linux-musl"

%struct.Point = type { double, double }

; Function Attrs: mustprogress noinline nounwind optnone uwtable
define dso_local noundef double @_ZNK5Point4normEv(ptr noundef nonnull align 8 dereferenceable(16) %this) #0 align 2 !dbg !10 {
entry:
  %this.addr = alloca ptr, align 8
  store ptr %this, ptr %this.addr, align 8
  %this1 = load ptr, ptr %this.addr, align 8
  %x = getelementptr inbounds nuw %struct.Point, ptr %this1, i32 0, i32 0, !dbg !13
  %0 = load double, ptr %x, align 8, !dbg !13
  %y = getelementptr inbounds nuw %struct.Point, ptr %this1, i32 0, i32 1, !dbg !14
  %1 = load double, ptr %y, align 8, !dbg !14
  %call = call double @hypot(double noundef %0, double noundef %1) #2, !dbg !15
  ret double %call, !dbg !16
}

; Function Attrs: nounwind willreturn memory(none)
declare double @hypot(double noundef, double noundef) #1

; Function Attrs: mustprogress noinline nounwind optnone uwtable
define dso_local noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull align 8 dereferenceable(16) %a, ptr noundef nonnull align 8 dereferenceable(16) %b) #0 !dbg !17 {
entry:
  %a.addr = alloca ptr, align 8
  %b.addr = alloca ptr, align 8
  store ptr %a, ptr %a.addr, align 8
  store ptr %b, ptr %b.addr, align 8
  %0 = load ptr, ptr %a.addr, align 8, !dbg !18, !nonnull !12, !align !19
  %x = getelementptr inbounds nuw %struct.Point, ptr %0, i32 0, i32 0, !dbg !20
  %1 = load double, ptr %x, align 8, !dbg !20
  %2 = load ptr, ptr %b.addr, align 8, !dbg !21, !nonnull !12, !align !19
  %x1 = getelementptr inbounds nuw %struct.Point, ptr %2, i32 0, i32 0, !dbg !22
  %3 = load double, ptr %x1, align 8, !dbg !22
  %sub = fsub double %1, %3, !dbg !23
  %4 = load ptr, ptr %a.addr, align 8, !dbg !24, !nonnull !12, !align !19
  %y = getelementptr inbounds nuw %struct.Point, ptr %4, i32 0, i32 1, !dbg !25
  %5 = load double, ptr %y, align 8, !dbg !25
  %6 = load ptr, ptr %b.addr, align 8, !dbg !26, !nonnull !12, !align !19
  %y2 = getelementptr inbounds nuw %struct.Point, ptr %6, i32 0, i32 1, !dbg !27
  %7 = load double, ptr %y2, align 8, !dbg !27
  %sub3 = fsub double %5, %7, !dbg !28
  %call = call double @hypot(double noundef %sub, double noundef %sub3) #2, !dbg !29
  ret double %call, !dbg !30
}

attributes #0 = { mustprogress noinline nounwind optnone uwtable "frame-pointer"="all" "min-legal-vector-width"="0" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #1 = { nounwind willreturn memory(none) "frame-pointer"="all" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #2 = { nounwind willreturn memory(none) }

!llvm.dbg.cu = !{!0}
!llvm.module.flags = !{!2, !3, !4, !5, !6, !7, !8}
!llvm.ident = !{!9}

!0 = distinct !DICompileUnit(language: DW_LANG_C_plus_plus_14, file: !1, producer: "clang version 21.1.8", isOptimized: false, runtimeVersion: 0, emissionKind: LineTablesOnly, splitDebugInlining: false, nameTableKind: None)
!1 = !DIFile(filename: "geometry.cpp", directory: "/workspace", checksumkind: CSK_MD5, checksum: "4ccac6c7ef22f19ec4699ab46905af57")
!2 = !{i32 7, !"Dwarf Version", i32 5}
!3 = !{i32 2, !"Debug Info Version", i32 3}
!4 = !{i32 1, !"wchar_size", i32 4}
!5 = !{i32 8, !"PIC Level", i32 2}
!6 = !{i32 7, !"PIE Level", i32 2}
!7 = !{i32 7, !"uwtable", i32 2}
!8 = !{i32 7, !"frame-pointer", i32 2}
!9 = !{!"clang version 21.1.8"}
!10 = distinct !DISubprogram(name: "norm", scope: !1, file: !1, line: 5, type: !11, scopeLine: 5, flags: DIFlagPrototyped, spFlags: DISPFlagDefinition, unit: !0)
!11 = !DISubroutineType(types: !12)
!12 = !{}
!13 = !DILocation(line: 5, column: 48, scope: !10)
!14 = !DILocation(line: 5, column: 51, scope: !10)
!15 = !DILocation(line: 5, column: 37, scope: !10)
!16 = !DILocation(line: 5, column: 30, scope: !10)
!17 = distinct !DISubprogram(name: "distance", scope: !1, file: !1, line: 7, type: !11, scopeLine: 7, flags: DIFlagPrototyped, spFlags: DISPFlagDefinition, unit: !0)
!18 = !DILocation(line: 8, column: 23, scope: !17)
!19 = !{i64 8}
!20 = !DILocation(line: 8, column: 25, scope: !17)
!21 = !DILocation(line: 8, column: 29, scope: !17)
!22 = !DILocation(line: 8, column: 31, scope: !17)
!23 = !DILocation(line: 8, column: 27, scope: !17)
!24 = !DILocation(line: 8, column: 34, scope: !17)
!25 = !DILocation(line: 8, column: 36, scope: !17)
!26 = !DILocation(line: 8, column: 40, scope: !17)
!27 = !DILocation(line: 8, column: 42, scope: !17)
!28 = !DILocation(line: 8, column: 38, scope: !17)
!29 = !DILocation(line: 8, column: 12, scope: !17)
!30 = !DILocation(line: 8, column: 5, scope: !17)
