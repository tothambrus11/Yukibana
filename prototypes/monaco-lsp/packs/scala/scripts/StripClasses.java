// Builds the class-path bundle the in-browser compiler reads: from jars and
// a JDK image, keep what the type checker looks at (class headers, signatures,
// annotations, InnerClasses, Scala pickles, TASTy) and drop what only a JVM
// executes (method bodies, debug info, private members of Java classes).
//
// Usage: java -cp asm.jar StripClasses.java <out.bin> <prefix-filter-file> <source>...
//   <source> is a .jar, or "<jar>@<prefix>" for only the entries of that jar
//   under <prefix>, or "jrt:<java.home>" for that JDK's java.base module
//   (build.sh passes a pinned JDK, not the one running this program),
//   or "closure:<bundle.bin>=<java.home>": the java.base classes, of any
//   package and access, that the Java classes of <bundle.bin> and of this
//   output name (supertypes, member signatures) and that neither has,
//   transitively. The type checker never looks there, but the later phases
//   the runner's compiler runs (erasure, bridges, overriding checks) complete
//   every member of String, StringBuilder, Class, ...: StringBuilder's
//   superclass AbstractStringBuilder is package-private, and Class has a
//   member typed java.security.ProtectionDomain.
//   The filter file lists path prefixes to keep from jrt: (one per line).
// Output: [u32 BE header length][header JSON: [[path, offset, length], ...]][bytes]
import org.objectweb.asm.*;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;

public class StripClasses {
  record Entry(String path, byte[] data) {}

  static byte[] strip(byte[] in, boolean isJava) {
    ClassReader cr = new ClassReader(in);
    ClassWriter cw = new ClassWriter(0);
    cr.accept(new ClassVisitor(Opcodes.ASM9, cw) {
      // A Scala 2 class is read from its pickle (ScalaSig) or not at all
      // (Scala): its members as a JVM sees them are never looked at.
      boolean pickled = false;
      @Override public void visitAttribute(Attribute a) {
        if (a.type.equals("ScalaSig") || a.type.equals("Scala")) pickled = true;
        super.visitAttribute(a);
      }
      // Entries for non-public nested Java classes name class files that are
      // not in the bundle; the class file parser expects every listed
      // member class of the class it reads to exist.
      @Override public void visitInnerClass(String name, String outer, String inner, int acc) {
        if (isJava && (acc & (Opcodes.ACC_PUBLIC | Opcodes.ACC_PROTECTED)) == 0) return;
        super.visitInnerClass(name, outer, inner, acc);
      }
      @Override public FieldVisitor visitField(int acc, String n, String d, String s, Object v) {
        if (pickled) return null;
        if (isJava && (acc & Opcodes.ACC_PRIVATE) != 0) return null;
        return super.visitField(acc, n, d, s, v);
      }
      @Override public MethodVisitor visitMethod(int acc, String n, String d, String s, String[] e) {
        if (pickled) return null;
        if (isJava && (acc & Opcodes.ACC_PRIVATE) != 0) return null;
        if ((acc & Opcodes.ACC_SYNTHETIC) != 0 && n.startsWith("lambda$")) return null;
        return super.visitMethod(acc, n, d, s, e);
      }
    }, ClassReader.SKIP_CODE | ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
    return cw.toByteArray();
  }

  // Classes no signature can name: anonymous classes and lambdas.
  static boolean anonymous(String path) {
    return path.contains("$anon") || path.contains("$$Lambda") || path.matches(".*\\$\\d+\\.class");
  }

  /** Adds to `out` the java.base classes that classes in `bundle` or `out`
   *  name and that neither contains (see the usage note above). */
  static void closure(List<Entry> out, String bundle, String javaHome) throws Exception {
    Map<String, byte[]> have = new HashMap<>();
    byte[] b = Files.readAllBytes(Path.of(bundle));
    int hl = ((b[0] & 0xff) << 24) | ((b[1] & 0xff) << 16) | ((b[2] & 0xff) << 8) | (b[3] & 0xff);
    String header = new String(b, 4, hl, StandardCharsets.UTF_8);
    var m = java.util.regex.Pattern.compile("\\[\"([^\"]+)\",(\\d+),(\\d+)\\]").matcher(header);
    while (m.find()) {
      int off = 4 + hl + Integer.parseInt(m.group(2));
      have.put(m.group(1), Arrays.copyOfRange(b, off, off + Integer.parseInt(m.group(3))));
    }
    for (Entry e : out) have.put(e.path(), e.data());
    FileSystem fs = FileSystems.newFileSystem(URI.create("jrt:/"), java.util.Map.of("java.home", javaHome));
    Path base = fs.getPath("/modules/java.base");
    Deque<byte[]> work = new ArrayDeque<>();
    for (var e : have.entrySet()) if (e.getKey().endsWith(".class")) work.add(e.getValue());
    int added = 0;
    while (!work.isEmpty()) {
      for (String name : referenced(work.pop())) {
        String path = name + ".class";
        if (have.containsKey(path) || anonymous(path)) continue;
        Path p = base.resolve(path);
        if (!Files.isRegularFile(p)) { have.put(path, null); continue; }
        byte[] data = strip(Files.readAllBytes(p), true);
        have.put(path, data);
        out.add(new Entry(path, data));
        work.add(data);
        added++;
      }
    }
    System.err.println("closure over " + bundle + ": added " + added + " java.base classes");
  }

  /** Internal names of the classes a (stripped) class file names in its
   *  header, its InnerClasses, and its fields' and methods' types. */
  static Set<String> referenced(byte[] data) {
    Set<String> names = new HashSet<>();
    var sv = new org.objectweb.asm.signature.SignatureVisitor(Opcodes.ASM9) {
      @Override public void visitClassType(String n) { names.add(n); }
      @Override public void visitInnerClassType(String n) { }
    };
    java.util.function.Consumer<Type> addType = new java.util.function.Consumer<>() {
      public void accept(Type t) {
        if (t.getSort() == Type.ARRAY) accept(t.getElementType());
        else if (t.getSort() == Type.OBJECT) names.add(t.getInternalName());
        else if (t.getSort() == Type.METHOD) { for (Type a : t.getArgumentTypes()) accept(a); accept(t.getReturnType()); }
      }
    };
    new ClassReader(data).accept(new ClassVisitor(Opcodes.ASM9) {
      @Override public void visit(int v, int acc, String name, String sig, String sup, String[] itfs) {
        if (sup != null) names.add(sup);
        if (itfs != null) names.addAll(Arrays.asList(itfs));
        if (sig != null) new org.objectweb.asm.signature.SignatureReader(sig).accept(sv);
      }
      @Override public void visitInnerClass(String name, String outer, String inner, int acc) { names.add(name); }
      @Override public FieldVisitor visitField(int acc, String n, String d, String sig, Object v) {
        addType.accept(Type.getType(d));
        if (sig != null) new org.objectweb.asm.signature.SignatureReader(sig).acceptType(sv);
        return null;
      }
      @Override public MethodVisitor visitMethod(int acc, String n, String d, String sig, String[] e) {
        addType.accept(Type.getMethodType(d));
        if (e != null) names.addAll(Arrays.asList(e));
        if (sig != null) new org.objectweb.asm.signature.SignatureReader(sig).accept(sv);
        return null;
      }
    }, ClassReader.SKIP_CODE | ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
    return names;
  }

  public static void main(String[] args) throws Exception {
    List<String> prefixes = Files.readAllLines(Path.of(args[1])).stream()
        .map(String::trim).filter(l -> !l.isEmpty() && !l.startsWith("#")).toList();
    List<Entry> out = new ArrayList<>();
    List<String> closures = new ArrayList<>();
    for (int i = 2; i < args.length; i++) {
      String src = args[i];
      if (src.startsWith("closure:")) {
        closures.add(src.substring("closure:".length()));
      } else if (src.startsWith("jrt:")) {
        // "jrt:<java.home>": the java.base of that JDK, not of the one running
        // this program, so the class path does not follow the build machine.
        FileSystem fs = FileSystems.newFileSystem(URI.create("jrt:/"), java.util.Map.of("java.home", src.substring(4)));
        Path base = fs.getPath("/modules/java.base");
        try (var walk = Files.walk(base)) {
          for (Path p : (Iterable<Path>) walk::iterator) {
            String rel = base.relativize(p).toString();
            if (!rel.endsWith(".class") || rel.equals("module-info.class") || anonymous(rel)) continue;
            if (prefixes.stream().noneMatch(rel::startsWith)) continue;
            byte[] data = Files.readAllBytes(p);
            if ((new ClassReader(data).getAccess() & Opcodes.ACC_PUBLIC) == 0) continue;
            out.add(new Entry(rel, strip(data, true)));
          }
        }
      } else {
        int at = src.lastIndexOf('@');
        String only = at < 0 ? "" : src.substring(at + 1);
        try (ZipFile z = new ZipFile(at < 0 ? src : src.substring(0, at))) {
          for (var en : Collections.list(z.entries())) {
            String n = en.getName();
            if (!n.startsWith(only)) continue;
            if (n.startsWith("META-INF/") || n.equals("module-info.class") || anonymous(n)) continue;
            // A class with TASTy is read from the .tasty file alone.
            if (n.endsWith(".class") && z.getEntry(n.replaceAll("\\$?\\.class$", ".tasty")) != null) continue;
            byte[] data = z.getInputStream(en).readAllBytes();
            if (n.endsWith(".class")) out.add(new Entry(n, strip(data, false)));
            else if (n.endsWith(".tasty")) out.add(new Entry(n, data));
          }
        }
      }
    }
    for (String c : closures) closure(out, c.substring(0, c.indexOf('=')), c.substring(c.indexOf('=') + 1));
    out.sort(Comparator.comparing(Entry::path));
    StringBuilder h = new StringBuilder("[");
    long off = 0;
    for (Entry e : out) {
      if (h.length() > 1) h.append(',');
      h.append("[\"").append(e.path()).append("\",").append(off).append(',').append(e.data().length).append(']');
      off += e.data().length;
    }
    h.append(']');
    byte[] header = h.toString().getBytes(StandardCharsets.UTF_8);
    try (var os = new BufferedOutputStream(new FileOutputStream(args[0]))) {
      os.write(new byte[] { (byte) (header.length >>> 24), (byte) (header.length >>> 16), (byte) (header.length >>> 8), (byte) header.length });
      os.write(header);
      for (Entry e : out) os.write(e.data());
    }
    System.err.println("wrote " + out.size() + " entries, " + (4 + header.length + off) + " bytes to " + args[0]);
  }
}
