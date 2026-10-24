; ModuleID = 'geometry.cpp'
source_filename = "geometry.cpp"
target datalayout = "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20"
target triple = "wasm32-unknown-wasip1"

%struct.Point = type { double, double }

; Function Attrs: mustprogress noinline nounwind optnone
define hidden noundef double @_ZNK5Point4normEv(ptr noundef nonnull align 8 dereferenceable(16) %this) #0 !dbg !6 {
entry:
  %this.addr = alloca ptr, align 4
  store ptr %this, ptr %this.addr, align 4
  %this1 = load ptr, ptr %this.addr, align 4
  %x = getelementptr inbounds nuw %struct.Point, ptr %this1, i32 0, i32 0, !dbg !9
  %0 = load double, ptr %x, align 8, !dbg !9
  %y = getelementptr inbounds nuw %struct.Point, ptr %this1, i32 0, i32 1, !dbg !10
  %1 = load double, ptr %y, align 8, !dbg !10
  %call = call double @hypot(double noundef %0, double noundef %1) #2, !dbg !11
  ret double %call, !dbg !12
}

; Function Attrs: nounwind willreturn memory(none)
declare double @hypot(double noundef, double noundef) #1

; Function Attrs: mustprogress noinline nounwind optnone
define hidden noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull align 8 dereferenceable(16) %a, ptr noundef nonnull align 8 dereferenceable(16) %b) #0 !dbg !13 {
entry:
  %a.addr = alloca ptr, align 4
  %b.addr = alloca ptr, align 4
  store ptr %a, ptr %a.addr, align 4
  store ptr %b, ptr %b.addr, align 4
  %0 = load ptr, ptr %a.addr, align 4, !dbg !14, !nonnull !8, !align !15
  %x = getelementptr inbounds nuw %struct.Point, ptr %0, i32 0, i32 0, !dbg !16
  %1 = load double, ptr %x, align 8, !dbg !16
  %2 = load ptr, ptr %b.addr, align 4, !dbg !17, !nonnull !8, !align !15
  %x1 = getelementptr inbounds nuw %struct.Point, ptr %2, i32 0, i32 0, !dbg !18
  %3 = load double, ptr %x1, align 8, !dbg !18
  %sub = fsub double %1, %3, !dbg !19
  %4 = load ptr, ptr %a.addr, align 4, !dbg !20, !nonnull !8, !align !15
  %y = getelementptr inbounds nuw %struct.Point, ptr %4, i32 0, i32 1, !dbg !21
  %5 = load double, ptr %y, align 8, !dbg !21
  %6 = load ptr, ptr %b.addr, align 4, !dbg !22, !nonnull !8, !align !15
  %y2 = getelementptr inbounds nuw %struct.Point, ptr %6, i32 0, i32 1, !dbg !23
  %7 = load double, ptr %y2, align 8, !dbg !23
  %sub3 = fsub double %5, %7, !dbg !24
  %call = call double @hypot(double noundef %sub, double noundef %sub3) #2, !dbg !25
  ret double %call, !dbg !26
}

attributes #0 = { mustprogress noinline nounwind optnone "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+exception-handling,+multivalue,+mutable-globals,+nontrapping-fptoint,+reference-types,+sign-ext" }
attributes #1 = { nounwind willreturn memory(none) "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+exception-handling,+multivalue,+mutable-globals,+nontrapping-fptoint,+reference-types,+sign-ext" }
attributes #2 = { nounwind willreturn memory(none) }

!llvm.dbg.cu = !{!0}
!llvm.module.flags = !{!2, !3, !4}
!llvm.ident = !{!5}

!0 = distinct !DICompileUnit(language: DW_LANG_C_plus_plus_14, file: !1, producer: "clang version 21.1.8", isOptimized: false, runtimeVersion: 0, emissionKind: LineTablesOnly, splitDebugInlining: false, nameTableKind: None)
!1 = !DIFile(filename: "geometry.cpp", directory: "/workspace")
!2 = !{i32 7, !"Dwarf Version", i32 4}
!3 = !{i32 2, !"Debug Info Version", i32 3}
!4 = !{i32 1, !"wchar_size", i32 4}
!5 = !{!"clang version 21.1.8"}
!6 = distinct !DISubprogram(name: "norm", scope: !1, file: !1, line: 5, type: !7, scopeLine: 5, flags: DIFlagPrototyped, spFlags: DISPFlagDefinition, unit: !0)
!7 = !DISubroutineType(types: !8)
!8 = !{}
!9 = !DILocation(line: 5, column: 48, scope: !6)
!10 = !DILocation(line: 5, column: 51, scope: !6)
!11 = !DILocation(line: 5, column: 37, scope: !6)
!12 = !DILocation(line: 5, column: 30, scope: !6)
!13 = distinct !DISubprogram(name: "distance", scope: !1, file: !1, line: 7, type: !7, scopeLine: 7, flags: DIFlagPrototyped, spFlags: DISPFlagDefinition, unit: !0)
!14 = !DILocation(line: 8, column: 23, scope: !13)
!15 = !{i64 8}
!16 = !DILocation(line: 8, column: 25, scope: !13)
!17 = !DILocation(line: 8, column: 29, scope: !13)
!18 = !DILocation(line: 8, column: 31, scope: !13)
!19 = !DILocation(line: 8, column: 27, scope: !13)
!20 = !DILocation(line: 8, column: 34, scope: !13)
!21 = !DILocation(line: 8, column: 36, scope: !13)
!22 = !DILocation(line: 8, column: 40, scope: !13)
!23 = !DILocation(line: 8, column: 42, scope: !13)
!24 = !DILocation(line: 8, column: 38, scope: !13)
!25 = !DILocation(line: 8, column: 12, scope: !13)
!26 = !DILocation(line: 8, column: 5, scope: !13)
