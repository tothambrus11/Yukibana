Scala.js IR for classes the Scala 3 compiler's sources name and Scala.js's
javalib does not have. The compiler is type-checked against the real JDK and
compiler-interface classes; these files only give the linker an
implementation of each one, with the same binary signatures:

  dotty/          the Java interfaces of scala3-interfaces and dotc/sbt
  xsbti/          the two compiler-interface enums the typer records into
  java/lang/ref   weak references on top of JavaScript WeakRef
  java/util       WeakHashMap (WeakRef keys), EnumSet (a hash set)
  java/io, java/nio/file, java/net
                  just enough of a file system API for code paths the
                  in-browser compiler never takes with real files: paths
                  are strings, every file "does not exist", reads and writes
                  throw IOException
  java/security   MessageDigest with MD5, for over-long name compaction
