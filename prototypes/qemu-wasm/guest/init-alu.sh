#!/bin/busybox sh
/bin/busybox --install -s /bin
mount -t proc proc /proc
for i in 1 2 3; do echo "=== alutest run $i"; /bin/alutest 20000; done
echo "=== DONE"
exec sh
