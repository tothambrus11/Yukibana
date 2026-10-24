; ModuleID = 'main.cpp'
source_filename = "main.cpp"
target datalayout = "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20"
target triple = "wasm32-unknown-wasip1"

%struct.Point = type { double, double }

@constinit = private unnamed_addr constant [2 x %struct.Point] [%struct.Point zeroinitializer, %struct.Point { double 3.000000e+00, double 4.000000e+00 }], align 8
@.str = private unnamed_addr constant [4 x i8] c"%f\0A\00", align 1

@__main_void = hidden alias i32 (), ptr @main

; Function Attrs: mustprogress norecurse
define hidden noundef i32 @main() #0 personality ptr @__gxx_wasm_personality_v0 {
_ZNSt3__219__allocate_at_leastB8fe210108INS_9allocatorI5PointEEEENS_19__allocation_resultINS_16allocator_traitsIT_E7pointerEEERS6_m.exit.i.i.i:
  %call2.i.i.i.i8.i.i = tail call noalias noundef nonnull dereferenceable(32) ptr @_Znwm(i32 noundef 32) #6
  tail call void @llvm.memcpy.p0.p0.i32(ptr noundef nonnull align 8 dereferenceable(32) %call2.i.i.i.i8.i.i, ptr noundef nonnull align 8 dereferenceable(32) @constinit, i32 32, i1 false)
  %arrayidx.i = getelementptr inbounds nuw i8, ptr %call2.i.i.i.i8.i.i, i32 16
  %call3 = invoke noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull align 8 dereferenceable(16) %call2.i.i.i.i8.i.i, ptr noundef nonnull align 8 dereferenceable(16) %arrayidx.i)
          to label %_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit31 unwind label %_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit41

_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit31: ; preds = %_ZNSt3__219__allocate_at_leastB8fe210108INS_9allocatorI5PointEEEENS_19__allocation_resultINS_16allocator_traitsIT_E7pointerEEERS6_m.exit.i.i.i
  %call5 = tail call i32 (ptr, ...) @printf(ptr noundef nonnull dereferenceable(1) @.str, double noundef %call3)
  %call8 = invoke noundef double @_ZNK5Point4normEv(ptr noundef nonnull align 8 dereferenceable(16) %arrayidx.i)
          to label %_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit unwind label %_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit41

_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit: ; preds = %_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit31
  %call10 = tail call i32 (ptr, ...) @printf(ptr noundef nonnull dereferenceable(1) @.str, double noundef %call8)
  tail call void @_ZdlPvm(ptr noundef nonnull %call2.i.i.i.i8.i.i, i32 noundef 32) #7
  ret i32 0

_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEED2B8fe210108Ev.exit41: ; preds = %_ZNSt3__26vectorI5PointNS_9allocatorIS1_EEEixB8fe210108Em.exit31, %_ZNSt3__219__allocate_at_leastB8fe210108INS_9allocatorI5PointEEEENS_19__allocation_resultINS_16allocator_traitsIT_E7pointerEEERS6_m.exit.i.i.i
  %0 = cleanuppad within none []
  call void @_ZdlPvm(ptr noundef nonnull %call2.i.i.i.i8.i.i, i32 noundef 32) #7 [ "funclet"(token %0) ]
  cleanupret from %0 unwind to caller
}

; Function Attrs: mustprogress nocallback nofree nounwind willreturn memory(argmem: readwrite)
declare void @llvm.memcpy.p0.p0.i32(ptr noalias writeonly captures(none), ptr noalias readonly captures(none), i32, i1 immarg) #1

; Function Attrs: nofree nounwind
declare noundef i32 @printf(ptr noundef readonly captures(none), ...) local_unnamed_addr #2

declare noundef double @_Z8distanceRK5PointS1_(ptr noundef nonnull align 8 dereferenceable(16), ptr noundef nonnull align 8 dereferenceable(16)) local_unnamed_addr #3

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

!llvm.module.flags = !{!0}
!llvm.ident = !{!1}

!0 = !{i32 1, !"wchar_size", i32 4}
!1 = !{!"clang version 21.1.8"}
