; ModuleID = 'geometry.cpp'
source_filename = "geometry.cpp"
target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i8:8:32-i16:16:32-i64:64-i128:128-n32:64-S128-Fn32"
target triple = "aarch64-unknown-linux-musl"

%struct.Point = type { double, double }

; Function Attrs: mustprogress noinline nounwind optnone uwtable
define dso_local noundef double @_ZNK5Point4normEv(ptr noundef nonnull align 8 dereferenceable(16) %this) #0 {
entry:
  %this.addr = alloca ptr, align 8
  store ptr %this, ptr %this.addr, align 8
  %this1 = load ptr, ptr %this.addr, align 8
  %x = getelementptr inbounds nuw %struct.Point, ptr %this1, i32 0, i32 0
  %0 = load double, ptr %x, align 8
  %y = getelementptr inbounds nuw %struct.Point, ptr %this1, i32 0, i32 1
  %1 = load double, ptr %y, align 8
  %call = call double @hypot(double noundef %0, double noundef %1) #2
  ret double %call
}

; Function Attrs: nounwind willreturn memory(none)
declare double @hypot(double noundef, double noundef) #1

; Function Attrs: mustprogress noinline nounwind optnone uwtable
define dso_local noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull align 8 dereferenceable(16) %a, ptr noundef nonnull align 8 dereferenceable(16) %b) #0 {
entry:
  %a.addr = alloca ptr, align 8
  %b.addr = alloca ptr, align 8
  store ptr %a, ptr %a.addr, align 8
  store ptr %b, ptr %b.addr, align 8
  %0 = load ptr, ptr %a.addr, align 8, !nonnull !6, !align !7
  %x = getelementptr inbounds nuw %struct.Point, ptr %0, i32 0, i32 0
  %1 = load double, ptr %x, align 8
  %2 = load ptr, ptr %b.addr, align 8, !nonnull !6, !align !7
  %x1 = getelementptr inbounds nuw %struct.Point, ptr %2, i32 0, i32 0
  %3 = load double, ptr %x1, align 8
  %sub = fsub double %1, %3
  %4 = load ptr, ptr %a.addr, align 8, !nonnull !6, !align !7
  %y = getelementptr inbounds nuw %struct.Point, ptr %4, i32 0, i32 1
  %5 = load double, ptr %y, align 8
  %6 = load ptr, ptr %b.addr, align 8, !nonnull !6, !align !7
  %y2 = getelementptr inbounds nuw %struct.Point, ptr %6, i32 0, i32 1
  %7 = load double, ptr %y2, align 8
  %sub3 = fsub double %5, %7
  %call = call double @hypot(double noundef %sub, double noundef %sub3) #2
  ret double %call
}

attributes #0 = { mustprogress noinline nounwind optnone uwtable "frame-pointer"="non-leaf" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+fp-armv8,+neon,+outline-atomics,+v8a" }
attributes #1 = { nounwind willreturn memory(none) "frame-pointer"="non-leaf" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="generic" "target-features"="+fp-armv8,+neon,+outline-atomics,+v8a" }
attributes #2 = { nounwind willreturn memory(none) }

!llvm.module.flags = !{!0, !1, !2, !3, !4}
!llvm.ident = !{!5}

!0 = !{i32 1, !"wchar_size", i32 4}
!1 = !{i32 8, !"PIC Level", i32 2}
!2 = !{i32 7, !"PIE Level", i32 2}
!3 = !{i32 7, !"uwtable", i32 2}
!4 = !{i32 7, !"frame-pointer", i32 1}
!5 = !{!"clang version 21.1.8"}
!6 = !{}
!7 = !{i64 8}
