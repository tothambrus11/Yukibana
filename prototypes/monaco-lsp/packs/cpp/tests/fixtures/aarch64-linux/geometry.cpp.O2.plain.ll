; ModuleID = 'geometry.cpp'
source_filename = "geometry.cpp"
target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i8:8:32-i16:16:32-i64:64-i128:128-n32:64-S128-Fn32"
target triple = "aarch64-unknown-linux-musl"

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: read) uwtable
define dso_local noundef double @_ZNK5Point4normEv(ptr noundef nonnull readonly align 8 captures(none) dereferenceable(16) %this) local_unnamed_addr #0 {
entry:
  %0 = load double, ptr %this, align 8, !tbaa !6
  %y = getelementptr inbounds nuw i8, ptr %this, i64 8
  %1 = load double, ptr %y, align 8, !tbaa !11
  %call = tail call double @hypot(double noundef %0, double noundef %1) #2
  ret double %call
}

; Function Attrs: mustprogress nocallback nofree nosync nounwind willreturn memory(none)
declare double @hypot(double noundef, double noundef) local_unnamed_addr #1

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: read) uwtable
define dso_local noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull readonly align 8 captures(none) dereferenceable(16) %a, ptr noundef nonnull readonly align 8 captures(none) dereferenceable(16) %b) local_unnamed_addr #0 {
entry:
  %0 = load double, ptr %a, align 8, !tbaa !6
  %1 = load double, ptr %b, align 8, !tbaa !6
  %sub = fsub double %0, %1
  %y = getelementptr inbounds nuw i8, ptr %a, i64 8
  %2 = load double, ptr %y, align 8, !tbaa !11
  %y2 = getelementptr inbounds nuw i8, ptr %b, i64 8
  %3 = load double, ptr %y2, align 8, !tbaa !11
  %sub3 = fsub double %2, %3
  %call = tail call double @hypot(double noundef %sub, double noundef %sub3) #2
  ret double %call
}

attributes #0 = { mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: read) uwtable "frame-pointer"="non-leaf" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+fp-armv8,+neon,+outline-atomics,+v8a" }
attributes #1 = { mustprogress nocallback nofree nosync nounwind willreturn memory(none) "frame-pointer"="non-leaf" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+fp-armv8,+neon,+outline-atomics,+v8a" }
attributes #2 = { nounwind willreturn memory(none) }

!llvm.module.flags = !{!0, !1, !2, !3, !4}
!llvm.ident = !{!5}

!0 = !{i32 1, !"wchar_size", i32 4}
!1 = !{i32 8, !"PIC Level", i32 2}
!2 = !{i32 7, !"PIE Level", i32 2}
!3 = !{i32 7, !"uwtable", i32 2}
!4 = !{i32 7, !"frame-pointer", i32 1}
!5 = !{!"clang version 21.1.8"}
!6 = !{!7, !8, i64 0}
!7 = !{!"_ZTS5Point", !8, i64 0, !8, i64 8}
!8 = !{!"double", !9, i64 0}
!9 = !{!"omnipotent char", !10, i64 0}
!10 = !{!"Simple C++ TBAA"}
!11 = !{!7, !8, i64 8}
