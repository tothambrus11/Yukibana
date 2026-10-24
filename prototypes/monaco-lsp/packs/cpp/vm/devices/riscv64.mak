# Only the virt board and what it selects; virtio-serial for the program channels.
CONFIG_RISCV_VIRT=y
CONFIG_VIRTIO_SERIAL=y
# target/riscv calls the semihosting code unconditionally under TCG (QEMU 8.2), so it must link.
CONFIG_SEMIHOSTING=y
CONFIG_ARM_COMPATIBLE_SEMIHOSTING=y
