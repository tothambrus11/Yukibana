# merge-jars.py <out.jar> <jar>...: one jar with the class files of all of them
# (the first one wins on a duplicate), no META-INF, entries sorted and dated
# 1980 so the output depends on the inputs only.
import sys
import zipfile

out, jars = sys.argv[1], sys.argv[2:]
entries = {}
for jar in jars:
    with zipfile.ZipFile(jar) as z:
        for name in z.namelist():
            if name.endswith('.class') and not name.startswith('META-INF/') and name not in entries:
                entries[name] = z.read(name)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name in sorted(entries):
        info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, entries[name])
print(f'junit.jar: {len(entries)} classes from {len(jars)} jars')
