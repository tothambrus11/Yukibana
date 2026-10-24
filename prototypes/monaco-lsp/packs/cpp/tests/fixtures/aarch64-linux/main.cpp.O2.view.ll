; ModuleID = 'main.cpp'
source_filename = "main.cpp"
target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i8:8:32-i16:16:32-i64:64-i128:128-n32:64-S128-Fn32"
target triple = "aarch64-unknown-linux-musl"

%struct.Point = type { double, double }

@constinit = private unnamed_addr constant [2 x %struct.Point] [%struct.Point zeroinitializer, %struct.Point { double 3.000000e+00, double 4.000000e+00 }], align 8
@.str = private unnamed_addr constant [4 x i8] c"%f\0A\00", align 1

; Function Attrs: mustprogress norecurse uwtable
define dso_local noundef i32 @main() local_unnamed_addr #0 personality ptr @__gxx_personality_v0 !dbg !18 {
entry:
  %call2.i.i.i.i6.i.i = tail call noalias noundef nonnull dereferenceable(32) ptr @_Znwm(i64 noundef 32) #6, !dbg !21
  tail call void @llvm.memcpy.p0.p0.i64(ptr noundef nonnull align 8 dereferenceable(32) %call2.i.i.i.i6.i.i, ptr noundef nonnull align 8 dereferenceable(32) @constinit, i64 32, i1 false), !dbg !38
  %arrayidx.i = getelementptr inbounds nuw i8, ptr %call2.i.i.i.i6.i.i, i64 16, !dbg !54
  %call2 = invoke noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull align 8 dereferenceable(16) %call2.i.i.i.i6.i.i, ptr noundef nonnull align 8 dereferenceable(16) %arrayidx.i)
          to label %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit27 unwind label %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit34, !dbg !57

_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit27: ; preds = %entry
  %call4 = tail call i32 (ptr, ...) @printf(ptr noundef nonnull dereferenceable(1) @.str, double noundef %call2), !dbg !58
  %call7 = invoke noundef double @_ZNK5Point4normEv(ptr noundef nonnull align 8 dereferenceable(16) %arrayidx.i)
          to label %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit unwind label %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit34, !dbg !59

_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit: ; preds = %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit27
  %call9 = tail call i32 (ptr, ...) @printf(ptr noundef nonnull dereferenceable(1) @.str, double noundef %call7), !dbg !60
  tail call void @_ZdlPvm(ptr noundef nonnull %call2.i.i.i.i6.i.i, i64 noundef 32) #7, !dbg !61
  ret i32 0, !dbg !72

_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit34: ; preds = %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit27, %entry
  %0 = landingpad { ptr, i32 }
          cleanup, !dbg !72
  tail call void @_ZdlPvm(ptr noundef nonnull %call2.i.i.i.i6.i.i, i64 noundef 32) #7, !dbg !73
  resume { ptr, i32 } %0, !dbg !79
}

; Function Attrs: mustprogress nocallback nofree nounwind willreturn memory(argmem: readwrite)
declare void @llvm.memcpy.p0.p0.i64(ptr noalias writeonly captures(none), ptr noalias readonly captures(none), i64, i1 immarg) #1

; Function Attrs: nofree nounwind
declare !dbg !80 noundef i32 @printf(ptr noundef readonly captures(none), ...) local_unnamed_addr #2

declare !dbg !82 noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull align 8 dereferenceable(16), ptr noundef nonnull align 8 dereferenceable(16)) local_unnamed_addr #3

declare i32 @__gxx_personality_v0(...)

declare noundef double @_ZNK5Point4normEv(ptr noundef nonnull align 8 dereferenceable(16)) local_unnamed_addr #3

; Function Attrs: nobuiltin allocsize(0)
declare noundef nonnull ptr @_Znwm(i64 noundef) local_unnamed_addr #4

; Function Attrs: nobuiltin nounwind
declare void @_ZdlPvm(ptr noundef, i64 noundef) local_unnamed_addr #5

attributes #0 = { mustprogress norecurse uwtable "frame-pointer"="non-leaf" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+fp-armv8,+neon,+outline-atomics,+v8a" }
attributes #1 = { mustprogress nocallback nofree nounwind willreturn memory(argmem: readwrite) }
attributes #2 = { nofree nounwind "frame-pointer"="non-leaf" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+fp-armv8,+neon,+outline-atomics,+v8a" }
attributes #3 = { "frame-pointer"="non-leaf" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+fp-armv8,+neon,+outline-atomics,+v8a" }
attributes #4 = { nobuiltin allocsize(0) "frame-pointer"="non-leaf" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+fp-armv8,+neon,+outline-atomics,+v8a" }
attributes #5 = { nobuiltin nounwind "frame-pointer"="non-leaf" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+fp-armv8,+neon,+outline-atomics,+v8a" }
attributes #6 = { builtin allocsize(0) }
attributes #7 = { builtin nounwind }

!llvm.dbg.cu = !{!0}
!llvm.module.flags = !{!10, !11, !12, !13, !14, !15, !16}
!llvm.ident = !{!17}

!0 = distinct !DICompileUnit(language: DW_LANG_C_plus_plus_14, file: !1, producer: "clang version 21.1.8", isOptimized: true, runtimeVersion: 0, emissionKind: LineTablesOnly, globals: !2, splitDebugInlining: false, nameTableKind: None)
!1 = !DIFile(filename: "main.cpp", directory: "/workspace", checksumkind: CSK_MD5, checksum: "d9f185577675b18f88ae34b0777d2aff")
!2 = !{!3}
!3 = !DIGlobalVariableExpression(var: !4, expr: !DIExpression())
!4 = distinct !DIGlobalVariable(name: "_vtable$", linkageName: "_ZTVSt12length_error", scope: !0, file: !1, type: !5, isLocal: false, isDefinition: true, declaration: !6, align: 64)
!5 = !DIDerivedType(tag: DW_TAG_pointer_type, baseType: null, size: 64)
!6 = !DIDerivedType(tag: DW_TAG_variable, name: "_vtable$", scope: !7, file: !1, baseType: !5, flags: DIFlagArtificial | DIFlagStaticMember)
!7 = !DICompositeType(tag: DW_TAG_class_type, name: "length_error", scope: !9, file: !8, line: 151, size: 128, flags: DIFlagFwdDecl | DIFlagNonTrivial)
!8 = !DIFile(filename: "/usr/include/c++/v1/stdexcept", directory: "")
!9 = !DINamespace(name: "std", scope: null)
!10 = !{i32 7, !"Dwarf Version", i32 5}
!11 = !{i32 2, !"Debug Info Version", i32 3}
!12 = !{i32 1, !"wchar_size", i32 4}
!13 = !{i32 8, !"PIC Level", i32 2}
!14 = !{i32 7, !"PIE Level", i32 2}
!15 = !{i32 7, !"uwtable", i32 2}
!16 = !{i32 7, !"frame-pointer", i32 1}
!17 = !{!"clang version 21.1.8"}
!18 = distinct !DISubprogram(name: "main", scope: !1, file: !1, line: 6, type: !19, scopeLine: 6, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!19 = !DISubroutineType(types: !20)
!20 = !{}
!21 = !DILocation(line: 43, column: 28, scope: !22, inlinedAt: !24)
!22 = distinct !DISubprogram(name: "__libcpp_allocate<Point>", scope: !23, file: !23, line: 36, type: !19, scopeLine: 36, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!23 = !DIFile(filename: "/usr/include/c++/v1/__new/allocate.h", directory: "")
!24 = distinct !DILocation(line: 105, column: 14, scope: !25, inlinedAt: !27)
!25 = distinct !DISubprogram(name: "allocate", scope: !26, file: !26, line: 98, type: !19, scopeLine: 98, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!26 = !DIFile(filename: "/usr/include/c++/v1/__memory/allocator.h", directory: "")
!27 = distinct !DILocation(line: 41, column: 19, scope: !28, inlinedAt: !30)
!28 = distinct !DISubprogram(name: "__allocate_at_least<std::__1::allocator<Point> >", scope: !29, file: !29, line: 40, type: !19, scopeLine: 40, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!29 = !DIFile(filename: "/usr/include/c++/v1/__memory/allocate_at_least.h", directory: "")
!30 = distinct !DILocation(line: 574, column: 25, scope: !31, inlinedAt: !33)
!31 = distinct !DISubprogram(name: "__vallocate", scope: !32, file: !32, line: 571, type: !19, scopeLine: 571, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!32 = !DIFile(filename: "/usr/include/c++/v1/__vector/vector.h", directory: "")
!33 = distinct !DILocation(line: 592, column: 7, scope: !34, inlinedAt: !35)
!34 = distinct !DISubprogram(name: "__init_with_size<const Point *, const Point *>", scope: !32, file: !32, line: 588, type: !19, scopeLine: 588, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!35 = distinct !DILocation(line: 277, column: 5, scope: !36, inlinedAt: !37)
!36 = distinct !DISubprogram(name: "vector", scope: !32, file: !32, line: 276, type: !19, scopeLine: 276, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!37 = distinct !DILocation(line: 7, column: 24, scope: !18)
!38 = !DILocation(line: 38, column: 49, scope: !39, inlinedAt: !41)
!39 = distinct !DISubprogram(name: "construct_at<Point, const Point &, Point *>", scope: !40, file: !40, line: 36, type: !19, scopeLine: 36, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!40 = !DIFile(filename: "/usr/include/c++/v1/__memory/construct_at.h", directory: "")
!41 = distinct !DILocation(line: 46, column: 10, scope: !42, inlinedAt: !43)
!42 = distinct !DISubprogram(name: "__construct_at<Point, const Point &, Point *>", scope: !40, file: !40, line: 44, type: !19, scopeLine: 44, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!43 = distinct !DILocation(line: 302, column: 5, scope: !44, inlinedAt: !46)
!44 = distinct !DISubprogram(name: "construct<Point, const Point &, 0>", scope: !45, file: !45, line: 301, type: !19, scopeLine: 301, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!45 = !DIFile(filename: "/usr/include/c++/v1/__memory/allocator_traits.h", directory: "")
!46 = distinct !DILocation(line: 543, column: 5, scope: !47, inlinedAt: !49)
!47 = distinct !DISubprogram(name: "__uninitialized_allocator_copy_impl<std::__1::allocator<Point>, const Point *, const Point *, Point *>", scope: !48, file: !48, line: 538, type: !19, scopeLine: 538, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!48 = !DIFile(filename: "/usr/include/c++/v1/__memory/uninitialized_algorithms.h", directory: "")
!49 = distinct !DILocation(line: 582, column: 28, scope: !50, inlinedAt: !51)
!50 = distinct !DISubprogram(name: "__uninitialized_allocator_copy<std::__1::allocator<Point>, const Point *, const Point *, Point *>", scope: !48, file: !48, line: 580, type: !19, scopeLine: 580, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!51 = distinct !DILocation(line: 945, column: 17, scope: !52, inlinedAt: !53)
!52 = distinct !DISubprogram(name: "__construct_at_end<const Point *, const Point *>", scope: !32, file: !32, line: 943, type: !19, scopeLine: 943, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!53 = distinct !DILocation(line: 593, column: 7, scope: !34, inlinedAt: !35)
!54 = !DILocation(line: 407, column: 12, scope: !55, inlinedAt: !56)
!55 = distinct !DISubprogram(name: "operator[]", scope: !32, file: !32, line: 405, type: !19, scopeLine: 405, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!56 = distinct !DILocation(line: 8, column: 45, scope: !18)
!57 = !DILocation(line: 8, column: 25, scope: !18)
!58 = !DILocation(line: 8, column: 5, scope: !18)
!59 = !DILocation(line: 9, column: 35, scope: !18)
!60 = !DILocation(line: 9, column: 5, scope: !18)
!61 = !DILocation(line: 63, column: 10, scope: !62, inlinedAt: !63)
!62 = distinct !DISubprogram(name: "__libcpp_deallocate<Point>", scope: !23, file: !23, line: 54, type: !19, scopeLine: 56, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!63 = distinct !DILocation(line: 120, column: 7, scope: !64, inlinedAt: !65)
!64 = distinct !DISubprogram(name: "deallocate", scope: !26, file: !26, line: 116, type: !19, scopeLine: 116, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!65 = distinct !DILocation(line: 289, column: 9, scope: !66, inlinedAt: !67)
!66 = distinct !DISubprogram(name: "deallocate", scope: !45, file: !45, line: 288, type: !19, scopeLine: 288, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!67 = distinct !DILocation(line: 253, column: 9, scope: !68, inlinedAt: !69)
!68 = distinct !DISubprogram(name: "operator()", scope: !32, file: !32, line: 249, type: !19, scopeLine: 249, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!69 = distinct !DILocation(line: 262, column: 67, scope: !70, inlinedAt: !71)
!70 = distinct !DISubprogram(name: "~vector", scope: !32, file: !32, line: 262, type: !19, scopeLine: 262, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!71 = distinct !DILocation(line: 11, column: 1, scope: !18)
!72 = !DILocation(line: 11, column: 1, scope: !18)
!73 = !DILocation(line: 63, column: 10, scope: !62, inlinedAt: !74)
!74 = distinct !DILocation(line: 120, column: 7, scope: !64, inlinedAt: !75)
!75 = distinct !DILocation(line: 289, column: 9, scope: !66, inlinedAt: !76)
!76 = distinct !DILocation(line: 253, column: 9, scope: !68, inlinedAt: !77)
!77 = distinct !DILocation(line: 262, column: 67, scope: !70, inlinedAt: !78)
!78 = distinct !DILocation(line: 11, column: 1, scope: !18)
!79 = !DILocation(line: 0, scope: !18)
!80 = !DISubprogram(name: "printf", scope: !81, file: !81, line: 109, type: !19, flags: DIFlagPrototyped, spFlags: DISPFlagOptimized)
!81 = !DIFile(filename: "/usr/include/stdio.h", directory: "", checksumkind: CSK_MD5, checksum: "3bba50398f7422b708b9de97b4ee8bfb")
!82 = !DISubprogram(name: "distance", scope: !83, file: !83, line: 13, type: !19, flags: DIFlagPrototyped, spFlags: DISPFlagOptimized)
!83 = !DIFile(filename: "./geometry.h", directory: "/workspace", checksumkind: CSK_MD5, checksum: "ab6e9775eef780b676f94bd3bd771b5e")
