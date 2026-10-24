# licences.py <out dir> <JDK legal dir> <junit-jupiter-api jar> <opentest4j jar> <asm sources jar>
# Writes the licence texts of what the pack ships, as LICENSE-*.txt, from the
# pinned, checksummed inputs build.sh already has: nothing is typed in here.
# Reads the jars as data: nothing in them runs.
import os
import sys
import zipfile

out, legal, junit, opentest4j, asm_sources = sys.argv[1:]


def write(name, preface, *parts):
    with open(os.path.join(out, name), "w", encoding="utf-8") as f:
        f.write(preface.strip() + "\n\n")
        f.write("\n\n".join(part.strip() for part in parts) + "\n")


def member(jar, name):
    with zipfile.ZipFile(jar) as z:
        return z.read(name).decode("utf-8")


def legal_file(name):
    with open(os.path.join(legal, "jdk.compiler", name), encoding="utf-8") as f:
        return f.read()


write(
    "LICENSE-openjdk.txt",
    "compiler.wasm contains javac (OpenJDK 25u's jdk.compiler and java.compiler),\n"
    "and classlib-javac.bin the API it compiles against, under the GNU General\n"
    "Public License, version 2, with the Classpath Exception:",
    legal_file("LICENSE"),
    legal_file("ASSEMBLY_EXCEPTION"),
    legal_file("ADDITIONAL_LICENSE_INFO"),
)
write(
    "LICENSE-apache-2.0.txt",
    "TeaVM 0.16.0 (compiler.wasm, teavm-runtime.js, classlib-javac.bin,\n"
    "classlib-teavm.bin and every program Run builds), teavm-javac (compiler.wasm),\n"
    "opentest4j 1.3.0 and apiguardian-api 1.1.2 (junit.jar) are licensed under\n"
    "the Apache License, Version 2.0:",
    member(opentest4j, "META-INF/LICENSE"),
)
write(
    "LICENSE-junit.txt",
    "JUnit Jupiter API and JUnit Platform Commons (junit.jar) are licensed under\n"
    "the Eclipse Public License 2.0:",
    member(junit, "META-INF/LICENSE.md"),
    member(junit, "META-INF/LICENSE-notice.md"),
)
# ASM ships its licence only as the header of each source file.
header = []
for line in member(asm_sources, "org/objectweb/asm/ClassReader.java").splitlines():
    if not line.startswith("//"):
        break
    header.append(line[3:] if line.startswith("// ") else line[2:])
write("LICENSE-asm.txt", "ASM 9.8 (in compiler.wasm, read by teavm-javac and our EntryPoints):", "\n".join(header))
