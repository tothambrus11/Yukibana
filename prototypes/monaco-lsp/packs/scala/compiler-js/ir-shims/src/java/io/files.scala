package java.io

import scala.language.unsafeNulls

/** A path name only: there is no file system in the browser, so nothing
 *  exists, nothing is a directory, and opening anything fails. */
class File(path: String) extends Serializable with Comparable[File] {
  private val p: String = if (path.length > 1 && path.endsWith("/")) path.dropRight(1) else path
  def this(parent: String, child: String) = this(if (parent == null || parent.isEmpty) child else parent + "/" + child)
  def this(parent: File, child: String) = this(if (parent == null) null else parent.getPath(), child)
  def getPath(): String = p
  def getName(): String = p.substring(p.lastIndexOf('/') + 1)
  def getParent(): String = { val i = p.lastIndexOf('/'); if (i < 0) null else if (i == 0) "/" else p.substring(0, i) }
  def getParentFile(): File = { val q = getParent(); if (q == null) null else new File(q) }
  def isAbsolute(): Boolean = p.startsWith("/")
  def getAbsolutePath(): String = if (isAbsolute()) p else "/" + p
  def getAbsoluteFile(): File = new File(getAbsolutePath())
  def getCanonicalPath(): String = java.nio.file.Paths.get(getAbsolutePath()).normalize().toString
  def getCanonicalFile(): File = new File(getCanonicalPath())
  def exists(): Boolean = false
  def isDirectory(): Boolean = false
  def isFile(): Boolean = false
  def canRead(): Boolean = false
  def canWrite(): Boolean = false
  def length(): Long = 0L
  def lastModified(): Long = 0L
  def delete(): Boolean = false
  def mkdir(): Boolean = false
  def mkdirs(): Boolean = false
  def createNewFile(): Boolean = throw new IOException("no file system in the browser: " + p)
  def list(): Array[String] = null
  def listFiles(): Array[File] = null
  def toPath(): java.nio.file.Path = java.nio.file.Paths.get(p)
  def toURI(): java.net.URI = new java.net.URI("file", null, getAbsolutePath(), null)
  def compareTo(o: File): Int = p.compareTo(o.getPath())
  override def equals(o: Any): Boolean = o match { case f: File => f.getPath() == p; case _ => false }
  override def hashCode(): Int = p.hashCode ^ 1234321
  override def toString(): String = p
}

object File {
  final val separatorChar: Char = '/'
  final val separator: String = "/"
  final val pathSeparatorChar: Char = ':'
  final val pathSeparator: String = ":"
}

class FileInputStream(file: File) extends InputStream {
  def this(name: String) = this(new File(name))
  throw new FileNotFoundException(String.valueOf(file) + " (no file system in the browser)")
  def read(): Int = -1
}

class FileOutputStream(file: File, append: Boolean) extends OutputStream {
  def this(file: File) = this(file, false)
  def this(name: String) = this(new File(name), false)
  def this(name: String, append: Boolean) = this(new File(name), append)
  throw new FileNotFoundException(String.valueOf(file) + " (no file system in the browser)")
  def write(b: Int): Unit = ()
}

class FileWriter(name: String, append: Boolean) extends Writer {
  def this(name: String) = this(name, false)
  def this(file: File) = this(file.getPath(), false)
  throw new FileNotFoundException(name + " (no file system in the browser)")
  def write(cbuf: Array[Char], off: Int, len: Int): Unit = ()
  def flush(): Unit = ()
  def close(): Unit = ()
}

class BufferedInputStream(in: InputStream, size: Int) extends FilterInputStream(in) {
  def this(in: InputStream) = this(in, 8192)
}

class BufferedWriter(out: Writer, size: Int) extends Writer {
  def this(out: Writer) = this(out, 8192)
  def write(cbuf: Array[Char], off: Int, len: Int): Unit = out.write(cbuf, off, len)
  def newLine(): Unit = out.write("\n")
  def flush(): Unit = out.flush()
  def close(): Unit = out.close()
}
