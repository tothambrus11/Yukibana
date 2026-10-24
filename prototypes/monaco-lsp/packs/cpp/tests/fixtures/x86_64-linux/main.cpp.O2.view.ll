; ModuleID = 'main.cpp'
source_filename = "main.cpp"
target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128"
target triple = "x86_64-unknown-linux-musl"

%struct.Point = type { double, double }

@constinit = private unnamed_addr constant [2 x %struct.Point] [%struct.Point zeroinitializer, %struct.Point { double 3.000000e+00, double 4.000000e+00 }], align 8
@.str = private unnamed_addr constant [4 x i8] c"%f\0A\00", align 1

; Function Attrs: mustprogress norecurse uwtable
define dso_local noundef i32 @main() local_unnamed_addr #0 personality ptr @__gxx_personality_v0 !dbg !17 {
entry:
  %call2.i.i.i.i6.i.i = tail call noalias noundef nonnull dereferenceable(32) ptr @_Znwm(i64 noundef 32) #6, !dbg !20
  tail call void @llvm.memcpy.p0.p0.i64(ptr noundef nonnull align 8 dereferenceable(32) %call2.i.i.i.i6.i.i, ptr noundef nonnull align 8 dereferenceable(32) @constinit, i64 32, i1 false), !dbg !37
  %arrayidx.i = getelementptr inbounds nuw i8, ptr %call2.i.i.i.i6.i.i, i64 16, !dbg !53
  %call2 = invoke noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull align 8 dereferenceable(16) %call2.i.i.i.i6.i.i, ptr noundef nonnull align 8 dereferenceable(16) %arrayidx.i)
          to label %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit27 unwind label %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit34, !dbg !56

_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit27: ; preds = %entry
  %call4 = tail call i32 (ptr, ...) @printf(ptr noundef nonnull dereferenceable(1) @.str, double noundef %call2), !dbg !57
  %call7 = invoke noundef double @_ZNK5Point4normEv(ptr noundef nonnull align 8 dereferenceable(16) %arrayidx.i)
          to label %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit unwind label %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit34, !dbg !58

_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit: ; preds = %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit27
  %call9 = tail call i32 (ptr, ...) @printf(ptr noundef nonnull dereferenceable(1) @.str, double noundef %call7), !dbg !59
  tail call void @_ZdlPvm(ptr noundef nonnull %call2.i.i.i.i6.i.i, i64 noundef 32) #7, !dbg !60
  ret i32 0, !dbg !71

_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit34: ; preds = %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit27, %entry
  %0 = landingpad { ptr, i32 }
          cleanup, !dbg !71
  tail call void @_ZdlPvm(ptr noundef nonnull %call2.i.i.i.i6.i.i, i64 noundef 32) #7, !dbg !72
  resume { ptr, i32 } %0, !dbg !78
}

; Function Attrs: mustprogress nocallback nofree nounwind willreturn memory(argmem: readwrite)
declare void @llvm.memcpy.p0.p0.i64(ptr noalias writeonly captures(none), ptr noalias readonly captures(none), i64, i1 immarg) #1

; Function Attrs: nofree nounwind
declare !dbg !79 noundef i32 @printf(ptr noundef readonly captures(none), ...) local_unnamed_addr #2

declare !dbg !81 noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull align 8 dereferenceable(16), ptr noundef nonnull align 8 dereferenceable(16)) local_unnamed_addr #3

declare i32 @__gxx_personality_v0(...)

declare noundef double @_ZNK5Point4normEv(ptr noundef nonnull align 8 dereferenceable(16)) local_unnamed_addr #3

; Function Attrs: nobuiltin allocsize(0)
declare noundef nonnull ptr @_Znwm(i64 noundef) local_unnamed_addr #4

; Function Attrs: nobuiltin nounwind
declare void @_ZdlPvm(ptr noundef, i64 noundef) local_unnamed_addr #5

attributes #0 = { mustprogress norecurse uwtable "min-legal-vector-width"="0" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #1 = { mustprogress nocallback nofree nounwind willreturn memory(argmem: readwrite) }
attributes #2 = { nofree nounwind "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #3 = { "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #4 = { nobuiltin allocsize(0) "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #5 = { nobuiltin nounwind "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #6 = { builtin allocsize(0) }
attributes #7 = { builtin nounwind }

!llvm.dbg.cu = !{!0}
!llvm.module.flags = !{!10, !11, !12, !13, !14, !15}
!llvm.ident = !{!16}

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
!16 = !{!"clang version 21.1.8"}
!17 = distinct !DISubprogram(name: "main", scope: !1, file: !1, line: 6, type: !18, scopeLine: 6, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!18 = !DISubroutineType(types: !19)
!19 = !{}
!20 = !DILocation(line: 43, column: 28, scope: !21, inlinedAt: !23)
!21 = distinct !DISubprogram(name: "__libcpp_allocate<Point>", scope: !22, file: !22, line: 36, type: !18, scopeLine: 36, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!22 = !DIFile(filename: "/usr/include/c++/v1/__new/allocate.h", directory: "")
!23 = distinct !DILocation(line: 105, column: 14, scope: !24, inlinedAt: !26)
!24 = distinct !DISubprogram(name: "allocate", scope: !25, file: !25, line: 98, type: !18, scopeLine: 98, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!25 = !DIFile(filename: "/usr/include/c++/v1/__memory/allocator.h", directory: "")
!26 = distinct !DILocation(line: 41, column: 19, scope: !27, inlinedAt: !29)
!27 = distinct !DISubprogram(name: "__allocate_at_least<std::__1::allocator<Point> >", scope: !28, file: !28, line: 40, type: !18, scopeLine: 40, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!28 = !DIFile(filename: "/usr/include/c++/v1/__memory/allocate_at_least.h", directory: "")
!29 = distinct !DILocation(line: 574, column: 25, scope: !30, inlinedAt: !32)
!30 = distinct !DISubprogram(name: "__vallocate", scope: !31, file: !31, line: 571, type: !18, scopeLine: 571, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!31 = !DIFile(filename: "/usr/include/c++/v1/__vector/vector.h", directory: "")
!32 = distinct !DILocation(line: 592, column: 7, scope: !33, inlinedAt: !34)
!33 = distinct !DISubprogram(name: "__init_with_size<const Point *, const Point *>", scope: !31, file: !31, line: 588, type: !18, scopeLine: 588, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!34 = distinct !DILocation(line: 277, column: 5, scope: !35, inlinedAt: !36)
!35 = distinct !DISubprogram(name: "vector", scope: !31, file: !31, line: 276, type: !18, scopeLine: 276, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!36 = distinct !DILocation(line: 7, column: 24, scope: !17)
!37 = !DILocation(line: 38, column: 49, scope: !38, inlinedAt: !40)
!38 = distinct !DISubprogram(name: "construct_at<Point, const Point &, Point *>", scope: !39, file: !39, line: 36, type: !18, scopeLine: 36, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!39 = !DIFile(filename: "/usr/include/c++/v1/__memory/construct_at.h", directory: "")
!40 = distinct !DILocation(line: 46, column: 10, scope: !41, inlinedAt: !42)
!41 = distinct !DISubprogram(name: "__construct_at<Point, const Point &, Point *>", scope: !39, file: !39, line: 44, type: !18, scopeLine: 44, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!42 = distinct !DILocation(line: 302, column: 5, scope: !43, inlinedAt: !45)
!43 = distinct !DISubprogram(name: "construct<Point, const Point &, 0>", scope: !44, file: !44, line: 301, type: !18, scopeLine: 301, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!44 = !DIFile(filename: "/usr/include/c++/v1/__memory/allocator_traits.h", directory: "")
!45 = distinct !DILocation(line: 543, column: 5, scope: !46, inlinedAt: !48)
!46 = distinct !DISubprogram(name: "__uninitialized_allocator_copy_impl<std::__1::allocator<Point>, const Point *, const Point *, Point *>", scope: !47, file: !47, line: 538, type: !18, scopeLine: 538, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!47 = !DIFile(filename: "/usr/include/c++/v1/__memory/uninitialized_algorithms.h", directory: "")
!48 = distinct !DILocation(line: 582, column: 28, scope: !49, inlinedAt: !50)
!49 = distinct !DISubprogram(name: "__uninitialized_allocator_copy<std::__1::allocator<Point>, const Point *, const Point *, Point *>", scope: !47, file: !47, line: 580, type: !18, scopeLine: 580, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!50 = distinct !DILocation(line: 945, column: 17, scope: !51, inlinedAt: !52)
!51 = distinct !DISubprogram(name: "__construct_at_end<const Point *, const Point *>", scope: !31, file: !31, line: 943, type: !18, scopeLine: 943, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!52 = distinct !DILocation(line: 593, column: 7, scope: !33, inlinedAt: !34)
!53 = !DILocation(line: 407, column: 12, scope: !54, inlinedAt: !55)
!54 = distinct !DISubprogram(name: "operator[]", scope: !31, file: !31, line: 405, type: !18, scopeLine: 405, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!55 = distinct !DILocation(line: 8, column: 45, scope: !17)
!56 = !DILocation(line: 8, column: 25, scope: !17)
!57 = !DILocation(line: 8, column: 5, scope: !17)
!58 = !DILocation(line: 9, column: 35, scope: !17)
!59 = !DILocation(line: 9, column: 5, scope: !17)
!60 = !DILocation(line: 63, column: 10, scope: !61, inlinedAt: !62)
!61 = distinct !DISubprogram(name: "__libcpp_deallocate<Point>", scope: !22, file: !22, line: 54, type: !18, scopeLine: 56, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!62 = distinct !DILocation(line: 120, column: 7, scope: !63, inlinedAt: !64)
!63 = distinct !DISubprogram(name: "deallocate", scope: !25, file: !25, line: 116, type: !18, scopeLine: 116, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!64 = distinct !DILocation(line: 289, column: 9, scope: !65, inlinedAt: !66)
!65 = distinct !DISubprogram(name: "deallocate", scope: !44, file: !44, line: 288, type: !18, scopeLine: 288, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!66 = distinct !DILocation(line: 253, column: 9, scope: !67, inlinedAt: !68)
!67 = distinct !DISubprogram(name: "operator()", scope: !31, file: !31, line: 249, type: !18, scopeLine: 249, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!68 = distinct !DILocation(line: 262, column: 67, scope: !69, inlinedAt: !70)
!69 = distinct !DISubprogram(name: "~vector", scope: !31, file: !31, line: 262, type: !18, scopeLine: 262, flags: DIFlagPrototyped | DIFlagAllCallsDescribed, spFlags: DISPFlagDefinition | DISPFlagOptimized, unit: !0)
!70 = distinct !DILocation(line: 11, column: 1, scope: !17)
!71 = !DILocation(line: 11, column: 1, scope: !17)
!72 = !DILocation(line: 63, column: 10, scope: !61, inlinedAt: !73)
!73 = distinct !DILocation(line: 120, column: 7, scope: !63, inlinedAt: !74)
!74 = distinct !DILocation(line: 289, column: 9, scope: !65, inlinedAt: !75)
!75 = distinct !DILocation(line: 253, column: 9, scope: !67, inlinedAt: !76)
!76 = distinct !DILocation(line: 262, column: 67, scope: !69, inlinedAt: !77)
!77 = distinct !DILocation(line: 11, column: 1, scope: !17)
!78 = !DILocation(line: 0, scope: !17)
!79 = !DISubprogram(name: "printf", scope: !80, file: !80, line: 109, type: !18, flags: DIFlagPrototyped, spFlags: DISPFlagOptimized)
!80 = !DIFile(filename: "/usr/include/stdio.h", directory: "", checksumkind: CSK_MD5, checksum: "3bba50398f7422b708b9de97b4ee8bfb")
!81 = !DISubprogram(name: "distance", scope: !82, file: !82, line: 13, type: !18, flags: DIFlagPrototyped, spFlags: DISPFlagOptimized)
!82 = !DIFile(filename: "./geometry.h", directory: "/workspace", checksumkind: CSK_MD5, checksum: "ab6e9775eef780b676f94bd3bd771b5e")
