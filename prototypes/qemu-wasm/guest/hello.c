#include <linux/module.h>
#include <linux/proc_fs.h>
#include <linux/seq_file.h>
static int show(struct seq_file *m, void *v) { seq_printf(m, "hello from a kernel module, jiffies=%lu\n", jiffies); return 0; }
static int __init hello_init(void) { proc_create_single("yukibana", 0444, NULL, show); pr_info("yukibana: loaded\n"); return 0; }
static void __exit hello_exit(void) { remove_proc_entry("yukibana", NULL); pr_info("yukibana: unloaded\n"); }
module_init(hello_init); module_exit(hello_exit);
MODULE_LICENSE("GPL");
