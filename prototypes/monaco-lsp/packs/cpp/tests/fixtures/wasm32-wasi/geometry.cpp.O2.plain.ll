; ModuleID = 'geometry.cpp'
source_filename = "geometry.cpp"
target datalayout = "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20"
target triple = "wasm32-unknown-wasip1"

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: read)
define hidden noundef double @_ZNK5Point4normEv(ptr noundef nonnull readonly align 8 captures(none) dereferenceable(16) %this) local_unnamed_addr #0 {
entry:
  %0 = load double, ptr %this, align 8, !tbaa !2
  %y = getelementptr inbounds nuw i8, ptr %this, i32 8
  %1 = load double, ptr %y, align 8, !tbaa !7
  %call = tail call double @hypot(double noundef %0, double noundef %1) #2
  ret double %call
}

; Function Attrs: mustprogress nocallback nofree nosync nounwind willreturn memory(none)
declare double @hypot(double noundef, double noundef) local_unnamed_addr #1

; Function Attrs: mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: read)
define hidden noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull readonly align 8 captures(none) dereferenceable(16) %a, ptr noundef nonnull readonly align 8 captures(none) dereferenceable(16) %b) local_unnamed_addr #0 {
entry:
  %0 = load double, ptr %a, align 8, !tbaa !2
  %1 = load double, ptr %b, align 8, !tbaa !2
  %sub = fsub double %0, %1
  %y = getelementptr inbounds nuw i8, ptr %a, i32 8
  %2 = load double, ptr %y, align 8, !tbaa !7
  %y2 = getelementptr inbounds nuw i8, ptr %b, i32 8
  %3 = load double, ptr %y2, align 8, !tbaa !7
  %sub3 = fsub double %2, %3
  %call = tail call double @hypot(double noundef %sub, double noundef %sub3) #2
  ret double %call
}

attributes #0 = { mustprogress nofree norecurse nosync nounwind willreturn memory(argmem: read) "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+exception-handling,+multivalue,+mutable-globals,+nontrapping-fptoint,+reference-types,+sign-ext" }
attributes #1 = { mustprogress nocallback nofree nosync nounwind willreturn memory(none) "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+exception-handling,+multivalue,+mutable-globals,+nontrapping-fptoint,+reference-types,+sign-ext" }
attributes #2 = { nounwind willreturn memory(none) }

!llvm.module.flags = !{!0}
!llvm.ident = !{!1}

!0 = !{i32 1, !"wchar_size", i32 4}
!1 = !{!"clang version 21.1.8"}
!2 = !{!3, !4, i64 0}
!3 = !{!"_ZTS5Point", !4, i64 0, !4, i64 8}
!4 = !{!"double", !5, i64 0}
!5 = !{!"omnipotent char", !6, i64 0}
!6 = !{!"Simple C++ TBAA"}
!7 = !{!3, !4, i64 8}
