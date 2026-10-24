package yk;

import com.oracle.svm.core.annotate.Substitute;
import com.oracle.svm.core.annotate.TargetClass;

/*
 * Web Image has no per-thread CPU clock, and its ThreadMXBean throws from
 * setThreadCpuTimeEnabled, which kotlinc's PerformanceManager calls before every compilation.
 * The page has one thread, so wall-clock time is that thread's time, near enough for the
 * compiler's own timing report (which nothing here reads).
 */
@TargetClass(className = "com.oracle.svm.core.jdk.management.SubstrateThreadMXBean")
final class Target_SubstrateThreadMXBean {
    @Substitute public boolean isThreadCpuTimeSupported() { return true; }
    @Substitute public boolean isCurrentThreadCpuTimeSupported() { return true; }
    @Substitute public boolean isThreadCpuTimeEnabled() { return true; }
    @Substitute public void setThreadCpuTimeEnabled(boolean enable) { }
    @Substitute public long getCurrentThreadCpuTime() { return System.nanoTime(); }
    @Substitute public long getCurrentThreadUserTime() { return System.nanoTime(); }
    @Substitute public long getThreadCpuTime(long id) { return System.nanoTime(); }
    @Substitute public long getThreadUserTime(long id) { return System.nanoTime(); }
}
