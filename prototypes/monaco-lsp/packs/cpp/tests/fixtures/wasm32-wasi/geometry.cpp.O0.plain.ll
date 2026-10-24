; ModuleID = 'geometry.cpp'
source_filename = "geometry.cpp"
target datalayout = "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20"
target triple = "wasm32-unknown-wasip1"

%struct.Point = type { double, double }

; Function Attrs: mustprogress noinline nounwind optnone
define hidden noundef double @_ZNK5Point4normEv(ptr noundef nonnull align 8 dereferenceable(16) %this) #0 {
entry:
  %this.addr = alloca ptr, align 4
  store ptr %this, ptr %this.addr, align 4
  %this1 = load ptr, ptr %this.addr, align 4
  %x = getelementptr inbounds nuw %struct.Point, ptr %this1, i32 0, i32 0
  %0 = load double, ptr %x, align 8
  %y = getelementptr inbounds nuw %struct.Point, ptr %this1, i32 0, i32 1
  %1 = load double, ptr %y, align 8
  %call = call double @hypot(double noundef %0, double noundef %1) #2
  ret double %call
}

; Function Attrs: nounwind willreturn memory(none)
declare double @hypot(double noundef, double noundef) #1

; Function Attrs: mustprogress noinline nounwind optnone
define hidden noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull align 8 dereferenceable(16) %a, ptr noundef nonnull align 8 dereferenceable(16) %b) #0 {
entry:
  %a.addr = alloca ptr, align 4
  %b.addr = alloca ptr, align 4
  store ptr %a, ptr %a.addr, align 4
  store ptr %b, ptr %b.addr, align 4
  %0 = load ptr, ptr %a.addr, align 4, !nonnull !2, !align !3
  %x = getelementptr inbounds nuw %struct.Point, ptr %0, i32 0, i32 0
  %1 = load double, ptr %x, align 8
  %2 = load ptr, ptr %b.addr, align 4, !nonnull !2, !align !3
  %x1 = getelementptr inbounds nuw %struct.Point, ptr %2, i32 0, i32 0
  %3 = load double, ptr %x1, align 8
  %sub = fsub double %1, %3
  %4 = load ptr, ptr %a.addr, align 4, !nonnull !2, !align !3
  %y = getelementptr inbounds nuw %struct.Point, ptr %4, i32 0, i32 1
  %5 = load double, ptr %y, align 8
  %6 = load ptr, ptr %b.addr, align 4, !nonnull !2, !align !3
  %y2 = getelementptr inbounds nuw %struct.Point, ptr %6, i32 0, i32 1
  %7 = load double, ptr %y2, align 8
  %sub3 = fsub double %5, %7
  %call = call double @hypot(double noundef %sub, double noundef %sub3) #2
  ret double %call
}

attributes #0 = { mustprogress noinline nounwind optnone "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+exception-handling,+multivalue,+mutable-globals,+nontrapping-fptoint,+reference-types,+sign-ext" }
attributes #1 = { nounwind willreturn memory(none) "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+bulk-memory,+bulk-memory-opt,+call-indirect-overlong,+exception-handling,+multivalue,+mutable-globals,+nontrapping-fptoint,+reference-types,+sign-ext" }
attributes #2 = { nounwind willreturn memory(none) }

!llvm.module.flags = !{!0}
!llvm.ident = !{!1}

!0 = !{i32 1, !"wchar_size", i32 4}
!1 = !{!"clang version 21.1.8"}
!2 = !{}
!3 = !{i64 8}
