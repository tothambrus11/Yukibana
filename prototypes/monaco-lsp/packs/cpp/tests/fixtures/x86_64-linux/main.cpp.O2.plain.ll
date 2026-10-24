; ModuleID = 'main.cpp'
source_filename = "main.cpp"
target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128"
target triple = "x86_64-unknown-linux-musl"

%struct.Point = type { double, double }

@constinit = private unnamed_addr constant [2 x %struct.Point] [%struct.Point zeroinitializer, %struct.Point { double 3.000000e+00, double 4.000000e+00 }], align 8
@.str = private unnamed_addr constant [4 x i8] c"%f\0A\00", align 1

; Function Attrs: mustprogress norecurse uwtable
define dso_local noundef i32 @main() local_unnamed_addr #0 personality ptr @__gxx_personality_v0 {
entry:
  %call2.i.i.i.i6.i.i = tail call noalias noundef nonnull dereferenceable(32) ptr @_Znwm(i64 noundef 32) #6
  tail call void @llvm.memcpy.p0.p0.i64(ptr noundef nonnull align 8 dereferenceable(32) %call2.i.i.i.i6.i.i, ptr noundef nonnull align 8 dereferenceable(32) @constinit, i64 32, i1 false)
  %arrayidx.i = getelementptr inbounds nuw i8, ptr %call2.i.i.i.i6.i.i, i64 16
  %call2 = invoke noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull align 8 dereferenceable(16) %call2.i.i.i.i6.i.i, ptr noundef nonnull align 8 dereferenceable(16) %arrayidx.i)
          to label %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit27 unwind label %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit34

_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit27: ; preds = %entry
  %call4 = tail call i32 (ptr, ...) @printf(ptr noundef nonnull dereferenceable(1) @.str, double noundef %call2)
  %call7 = invoke noundef double @_ZNK5Point4normEv(ptr noundef nonnull align 8 dereferenceable(16) %arrayidx.i)
          to label %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit unwind label %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit34

_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit: ; preds = %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit27
  %call9 = tail call i32 (ptr, ...) @printf(ptr noundef nonnull dereferenceable(1) @.str, double noundef %call7)
  tail call void @_ZdlPvm(ptr noundef nonnull %call2.i.i.i.i6.i.i, i64 noundef 32) #7
  ret i32 0

_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit34: ; preds = %_ZNSt3__16vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit27, %entry
  %0 = landingpad { ptr, i32 }
          cleanup
  tail call void @_ZdlPvm(ptr noundef nonnull %call2.i.i.i.i6.i.i, i64 noundef 32) #7
  resume { ptr, i32 } %0
}

; Function Attrs: mustprogress nocallback nofree nounwind willreturn memory(argmem: readwrite)
declare void @llvm.memcpy.p0.p0.i64(ptr noalias writeonly captures(none), ptr noalias readonly captures(none), i64, i1 immarg) #1

; Function Attrs: nofree nounwind
declare noundef i32 @printf(ptr noundef readonly captures(none), ...) local_unnamed_addr #2

declare noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull align 8 dereferenceable(16), ptr noundef nonnull align 8 dereferenceable(16)) local_unnamed_addr #3

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

!llvm.module.flags = !{!0, !1, !2, !3}
!llvm.ident = !{!4}

!0 = !{i32 1, !"wchar_size", i32 4}
!1 = !{i32 8, !"PIC Level", i32 2}
!2 = !{i32 7, !"PIE Level", i32 2}
!3 = !{i32 7, !"uwtable", i32 2}
!4 = !{!"clang version 21.1.8"}
