#!/bin/busybox sh
/bin/busybox --install -s /bin
mount -t proc proc /proc; mount -t sysfs sys /sys; mount -t devtmpfs dev /dev 2>/dev/null
echo 1 > /proc/sys/kernel/sysrq
echo "=== booted: $(uname -m), $(nproc) CPUs, uptime $(cut -d' ' -f1 /proc/uptime)s"
# Watchdog: if a round makes no progress for 20 s, dump blocked tasks and all CPUs.
( last=""; while sleep 20; do cur=$(cat /tmp/hb 2>/dev/null)
    if [ "$cur" = "$last" ]; then echo "=== WATCHDOG: no progress at $cur"; echo w > /proc/sysrq-trigger; echo l > /proc/sysrq-trigger; fi
    last=$cur; done ) &
i=0
while [ $i -lt @ROUNDS@ ]; do
  i=$((i+1))
  echo "$i-insmod" > /tmp/hb; insmod /hello.ko; cat /proc/yukibana > /dev/null
  echo "$i-rmmod" > /tmp/hb; rmmod hello
  echo "$i-threads" > /tmp/hb; /bin/threads | grep lost
done
echo "=== DONE"
exec sh
