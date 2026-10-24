; ModuleID = 'main.cpp'
source_filename = "main.cpp"
target datalayout = "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20"
target triple = "wasm32-unknown-wasip1"

%struct.Point = type { double, double }

@constinit = private unnamed_addr constant [2 x %struct.Point] [%struct.Point zeroinitializer, %struct.Point { double 3.000000e+00, double 4.000000e+00 }], align 8
@.str = private unnamed_addr constant [4 x i8] c"%f\0A\00", align 1

@__main_void = hidden alias i32 (), ptr @main

; Function Attrs: mustprogress norecurse
define hidden noundef i32 @main() #0 personality ptr @__gxx_wasm_personality_v0 !dbg !14 {
_ZNSt3__219__allocate_at_leastB8fe210108INS_9allocatorI5PointEEEENS_19__allocation_resultINS_16allocator_traitsIT_E7pointerEEERS6_m.exit.i.i.i:
  %call2.i.i.i.i8.i.i = tail call noalias noundef nonnull dereferenceable(32) ptr @_Znwm(i32 noundef 32) #6, !dbg !17
  tail call void @llvm.memcpy.p0.p0.i32(ptr noundef nonnull align 8 dereferenceable(32) %call2.i.i.i.i8.i.i, ptr noundef nonnull align 8 dereferenceable(32) @constinit, i32 32, i1 false), !dbg !34
  %arrayidx.i = getelementptr inbounds nuw i8, ptr %call2.i.i.i.i8.i.i, i32 16, !dbg !50
  %call3 = invoke noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull align 8 dereferenceable(16) %call2.i.i.i.i8.i.i, ptr noundef nonnull align 8 dereferenceable(16) %arrayidx.i)
          to label %_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit31 unwind label %_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit41, !dbg !53

_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit31: ; preds = %_ZNSt3__219__allocate_at_leastB8fe210108INS_9allocatorI5PointEEEENS_19__allocation_resultINS_16allocator_traitsIT_E7pointerEEERS6_m.exit.i.i.i
  %call5 = tail call i32 (ptr, ...) @printf(ptr noundef nonnull dereferenceable(1) @.str, double noundef %call3), !dbg !54
  %call8 = invoke noundef double @_ZNK5Point4normEv(ptr noundef nonnull align 8 dereferenceable(16) %arrayidx.i)
          to label %_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit unwind label %_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit41, !dbg !55

_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit: ; preds = %_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit31
  %call10 = tail call i32 (ptr, ...) @printf(ptr noundef nonnull dereferenceable(1) @.str, double noundef %call8), !dbg !56
  tail call void @_ZdlPvm(ptr noundef nonnull %call2.i.i.i.i8.i.i, i32 noundef 32) #7, !dbg !57
  ret i32 0, !dbg !68

_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit41: ; preds = %_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit31, %_ZNSt3__219__allocate_at_leastB8fe210108INS_9allocatorI5PointEEEENS_19__allocation_resultINS_16allocator_traitsIT_E7pointerEEERS6_m.exit.i.i.i
  %0 = cleanuppad within none [], !dbg !68
  call void @_ZdlPvm(ptr noundef nonnull %call2.i.i.i.i8.i.i, i32 noundef 32) #7 [ "funclet"(token %0) ], !dbg !69
  cleanupret from %0 unwind to caller, !dbg !68
}

; Function Attrs: mustprogress nocallback nofree nounwind willreturn memory(argmem: readwrite)
declare void @llvm.memcpy.p0.p0.i32(ptr noalias writeonly captures(none), ptr noalias readonly captures(none), i32, i1 immarg) #1

; Function Attrs: nofree nounwind
declare !dbg !75 noundef i32 @printf(ptr noundef readonly captures(none), ...) local_unnamed_addr #2

declare !dbg !77 noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull align 8 dereferenceable(16), ptr noundef nonnull align 8 dereferenceable(16)) local_unnamed_addr #3

declare i32 @__gxx_wasm_personality_v0(...)

declare noundef double @_ZNK5Point4normEv(ptr noundef nonnull align 8 dereferenceable(16)) local_unnamed_addr #3

; Function Attrs: nobuiltin allocsize(0)
declare noundef nonnull ptr @_Znwm(i32 noundef) local_unnamed_addr #4

; Function Attrs: nobuiltin nounwind
declare void @_ZdlPvm(ptr noundef, i32 noundef) local_unnamed_addr #5

attributes #0 = { mustprogress norecurse "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+exception-handling,+multivalue,+mutable-globals,+nontrapping-fptoint,+reference-types,+sign-ext" }
attributes #1 = { mustprogress nocallback nofree nounwind willreturn memory(argmem: readwrite) }
attributes #2 = { nofree nounwind "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+exception-handling,+multivalue,+mutable-globals,+nontrapping-fptoint,+reference-types,+sign-ext" }
attributes #3 = { "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+exception-handling,+multivalue,+mutable-globals,+nontrapping-fptoint,+reference-types,+sign-ext" }
attributes #4 = { nobuiltin allocsize(0) "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+exception-handling,+multivalue,+mutable-globals,+nontrapping-fptoint,+reference-types,+sign-ext" }
attributes #5 = { nobuiltin nounwind "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+exception-handling,+multivalue,+mutable-globals,+nontrapping-fptoint,+reference-types,+sign-ext" }
attributes #6 = { builtin allocsize(0) }
attributes #7 = { builtin nounwind }

!llvm.dbg.cu = !{!0}
!llvm.module.flags = !{!10, !11, !12}
!llvm.ident = !{!13}

!0 = distinct !DICompileUnit(language: DW_LANG_C_plus_plus_14, file: !1, producer: "clang version 21.1.8", isOptimized: true, runtimeVersion: 0, emissionKind: LineTablesOnly, globals: !2, splitDebugInlining: false, nameTableKind: None)
!1 = !DIFile(filename: "main.cpp", directory: "/workspace")
!2 = !{!3}
!3 = !DIGlobalVariableExpression(var: !4, expr: !DIExpression())
!4 = distinct !DIGlobalVariable(name: "_vtable$", linkageName: "_ZTVSt12length_error", scope: !0, file: !1, type: !5, isLocal: false, isDefinition: true, declaration: !6, align: 32)
!5 = !DIDerivedType(tag: DW_TAG_pointer_type, baseType: null, size: 32)
!6 = !DIDerivedType(tag: DW_TAG_member, name: "_vtable$", scope: !7, file: !1, baseType: !5, flags: DIFlagArtificial | DIFlagStaticMember)
!7 = !DICompositeType(tag: DW_TAG_class_type, name: "length_error", scope: !9, file: !8, line: 151, size: 64, flags: DIFlagFwdDecl | DIFlagNonTrivial)
!8 = !DIFile(filename: "/wasi/include/wasm32-wasip1/c++/v1/stdexcept", directory: "")
!9 = !DINamespace(name: "std", scope: null)
!10 = !{i32 7, !"Dwarf Version", i32 4}
!11 = !{i32 2, !"Debug Info Version", i32 3}
!12 = !{i32 1, !"wchar_size", i32 4}
!13 = !{!"clang version 21.1.8"}
!14 = distinct !DISubprogram(name: "main", scope: !1, file: !1, line: 6, type: !15, scopeLine: 6, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!15 = !DISubroutineType(types: !16)
!16 = !{}
!17 = !DILocation(line: 43, column: 28, scope: !18, inlinedAt: !20)
!18 = distinct !DISubprogram(name: "__libcpp_allocate<Point>", scope: !19, file: !19, line: 36, type: !15, scopeLine: 36, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!19 = !DIFile(filename: "/wasi/include/wasm32-wasip1/c++/v1/__new/allocate.h", directory: "")
!20 = distinct !DILocation(line: 105, column: 14, scope: !21, inlinedAt: !23)
!21 = distinct !DISubprogram(name: "allocate", scope: !22, file: !22, line: 98, type: !15, scopeLine: 98, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!22 = !DIFile(filename: "/wasi/include/wasm32-wasip1/c++/v1/__memory/allocator.h", directory: "")
!23 = distinct !DILocation(line: 41, column: 19, scope: !24, inlinedAt: !26)
!24 = distinct !DISubprogram(name: "__allocate_at_least<std::__2::allocator<Point> >", scope: !25, file: !25, line: 40, type: !15, scopeLine: 40, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!25 = !DIFile(filename: "/wasi/include/wasm32-wasip1/c++/v1/__memory/allocate_at_least.h", directory: "")
!26 = distinct !DILocation(line: 574, column: 25, scope: !27, inlinedAt: !29)
!27 = distinct !DISubprogram(name: "__vallocate", scope: !28, file: !28, line: 571, type: !15, scopeLine: 571, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!28 = !DIFile(filename: "/wasi/include/wasm32-wasip1/c++/v1/__vector/vector.h", directory: "")
!29 = distinct !DILocation(line: 592, column: 7, scope: !30, inlinedAt: !31)
!30 = distinct !DISubprogram(name: "__init_with_size<const Point *, const Point *>", scope: !28, file: !28, line: 588, type: !15, scopeLine: 588, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!31 = distinct !DILocation(line: 277, column: 5, scope: !32, inlinedAt: !33)
!32 = distinct !DISubprogram(name: "vector", scope: !28, file: !28, line: 276, type: !15, scopeLine: 276, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!33 = distinct !DILocation(line: 7, column: 24, scope: !14)
!34 = !DILocation(line: 38, column: 49, scope: !35, inlinedAt: !37)
!35 = distinct !DISubprogram(name: "construct_at<Point, const Point &, Point *>", scope: !36, file: !36, line: 36, type: !15, scopeLine: 36, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!36 = !DIFile(filename: "/wasi/include/wasm32-wasip1/c++/v1/__memory/construct_at.h", directory: "")
!37 = distinct !DILocation(line: 46, column: 10, scope: !38, inlinedAt: !39)
!38 = distinct !DISubprogram(name: "__construct_at<Point, const Point &, Point *>", scope: !36, file: !36, line: 44, type: !15, scopeLine: 44, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!39 = distinct !DILocation(line: 302, column: 5, scope: !40, inlinedAt: !42)
!40 = distinct !DISubprogram(name: "construct<Point, const Point &, 0>", scope: !41, file: !41, line: 301, type: !15, scopeLine: 301, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!41 = !DIFile(filename: "/wasi/include/wasm32-wasip1/c++/v1/__memory/allocator_traits.h", directory: "")
!42 = distinct !DILocation(line: 543, column: 5, scope: !43, inlinedAt: !45)
!43 = distinct !DISubprogram(name: "__uninitialized_allocator_copy_impl<std::__2::allocator<Point>, const Point *, const Point *, Point *>", scope: !44, file: !44, line: 538, type: !15, scopeLine: 538, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!44 = !DIFile(filename: "/wasi/include/wasm32-wasip1/c++/v1/__memory/uninitialized_algorithms.h", directory: "")
!45 = distinct !DILocation(line: 582, column: 28, scope: !46, inlinedAt: !47)
!46 = distinct !DISubprogram(name: "__uninitialized_allocator_copy<std::__2::allocator<Point>, const Point *, const Point *, Point *>", scope: !44, file: !44, line: 580, type: !15, scopeLine: 580, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!47 = distinct !DILocation(line: 945, column: 17, scope: !48, inlinedAt: !49)
!48 = distinct !DISubprogram(name: "__construct_at_end<const Point *, const Point *>", scope: !28, file: !28, line: 943, type: !15, scopeLine: 943, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!49 = distinct !DILocation(line: 593, column: 7, scope: !30, inlinedAt: !31)
!50 = !DILocation(line: 407, column: 12, scope: !51, inlinedAt: !52)
!51 = distinct !DISubprogram(name: "operator[]", scope: !28, file: !28, line: 405, type: !15, scopeLine: 405, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!52 = distinct !DILocation(line: 8, column: 45, scope: !14)
!53 = !DILocation(line: 8, column: 25, scope: !14)
!54 = !DILocation(line: 8, column: 5, scope: !14)
!55 = !DILocation(line: 9, column: 35, scope: !14)
!56 = !DILocation(line: 9, column: 5, scope: !14)
!57 = !DILocation(line: 63, column: 10, scope: !58, inlinedAt: !59)
!58 = distinct !DISubprogram(name: "__libcpp_deallocate<Point>", scope: !19, file: !19, line: 54, type: !15, scopeLine: 56, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!59 = distinct !DILocation(line: 120, column: 7, scope: !60, inlinedAt: !61)
!60 = distinct !DISubprogram(name: "deallocate", scope: !22, file: !22, line: 116, type: !15, scopeLine: 116, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!61 = distinct !DILocation(line: 289, column: 9, scope: !62, inlinedAt: !63)
!62 = distinct !DISubprogram(name: "deallocate", scope: !41, file: !41, line: 288, type: !15, scopeLine: 288, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!63 = distinct !DILocation(line: 253, column: 9, scope: !64, inlinedAt: !65)
!64 = distinct !DISubprogram(name: "operator()", scope: !28, file: !28, line: 249, type: !15, scopeLine: 249, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!65 = distinct !DILocation(line: 262, column: 67, scope: !66, inlinedAt: !67)
!66 = distinct !DISubprogram(name: "~vector", scope: !28, file: !28, line: 262, type: !15, scopeLine: 262, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!67 = distinct !DILocation(line: 11, column: 1, scope: !14)
!68 = !DILocation(line: 11, column: 1, scope: !14)
!69 = !DILocation(line: 63, column: 10, scope: !58, inlinedAt: !70)
!70 = distinct !DILocation(line: 120, column: 7, scope: !60, inlinedAt: !71)
!71 = distinct !DILocation(line: 289, column: 9, scope: !62, inlinedAt: !72)
!72 = distinct !DILocation(line: 253, column: 9, scope: !64, inlinedAt: !73)
!73 = distinct !DILocation(line: 262, column: 67, scope: !66, inlinedAt: !74)
!74 = distinct !DILocation(line: 11, column: 1, scope: !14)
!75 = !DISubprogram(name: "printf", scope: !76, file: !76, line: 126, type: !15, flags: DIFlagPrototyped, spFlags: DISPFlagOptimized)
!76 = !DIFile(filename: "/wasi/include/wasm32-wasip1/stdio.h", directory: "")
!77 = !DISubprogram(name: "distance", scope: !78, file: !78, line: 13, type: !15, flags: DIFlagPrototyped, spFlags: DISPFlagOptimized)
!78 = !DIFile(filename: "./geometry.h", directory: "/workspace")
