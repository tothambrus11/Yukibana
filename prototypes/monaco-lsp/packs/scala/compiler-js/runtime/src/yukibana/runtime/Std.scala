package yukibana.runtime

import java.io.{BufferedReader, InputStream, InputStreamReader, OutputStream, PrintStream}

import scala.reflect.Selectable.reflectiveSelectable

import scala.scalajs.js
import scala.scalajs.js.typedarray.Int8Array

/** Standard streams of a program run by the Scala pack's runner.js, linked in
 *  as the first module initializer, before the program's `main`.
 *
 *  Scala.js's own `System.out` writes whole lines to `console.log` and cannot
 *  show a prompt without a newline; its `System.in` is null, so
 *  `scala.io.StdIn.readLine()` throws. These replace all three with streams
 *  that call the runner's host object, `globalThis.__yukibana`:
 *
 *   - `write(fd, string)` / `writeBytes(fd, Int8Array)`: output as it is
 *     produced (fd 1 = stdout, 2 = stderr), and `flush(fd)`;
 *   - `readStdin()`: blocks (Atomics.wait in the worker) until the user
 *     enters a line, and returns its UTF-8 bytes, or null at end of file.
 *
 *  They must be installed before `scala.Console` is first touched, because
 *  Console captures `System.out`/`err` when it is initialised; a module
 *  initializer runs before the program's main, so it is. Scala.js's Console
 *  does not capture `System.in`, though: its `in` starts as null (Scala.js has
 *  no standard input), and only `setInDirect`, a protected method, sets it
 *  for good. It is reached with a structural (reflective) call, which
 *  Scala.js links to the method by name. */
object Std {
  private type ConsoleIn = { def setInDirect(in: BufferedReader): Unit }

  def init(): Unit = {
    System.setOut(new HostPrintStream(1))
    System.setErr(new HostPrintStream(2))
    System.setIn(new HostInputStream)
    Console.asInstanceOf[ConsoleIn].setInDirect(new BufferedReader(new InputStreamReader(System.in)))
  }
}

private object Host {
  def obj: js.Dynamic = js.Dynamic.global.__yukibana
}

private final class HostPrintStream(fd: Int) extends PrintStream(new HostPrintStream.Bytes(fd)) {
  private def put(s: String): Unit = Host.obj.write(fd, s)

  override def print(b: Boolean): Unit = put(String.valueOf(b))
  override def print(c: Char): Unit = put(String.valueOf(c))
  override def print(i: Int): Unit = put(String.valueOf(i))
  override def print(l: Long): Unit = put(String.valueOf(l))
  override def print(f: Float): Unit = put(String.valueOf(f))
  override def print(d: Double): Unit = put(String.valueOf(d))
  override def print(s: Array[Char]): Unit = put(String.valueOf(s))
  override def print(s: String): Unit = put(if (s == null) "null" else s)
  override def print(obj: AnyRef): Unit = put(String.valueOf(obj))
  override def println(): Unit = put("\n")
  override def println(obj: AnyRef): Unit = put(String.valueOf(obj) + "\n")
  override def println(s: String): Unit = put((if (s == null) "null" else s) + "\n")
  override def write(b: Int): Unit = Host.obj.writeBytes(fd, Int8Array.of(b.toByte))
  override def write(buf: Array[Byte], off: Int, len: Int): Unit = {
    if (off < 0 || len < 0 || len > buf.length - off) throw new IndexOutOfBoundsException
    val a = new Int8Array(len)
    var i = 0
    while (i < len) { a(i) = buf(off + i); i += 1 }
    Host.obj.writeBytes(fd, a)
  }
  override def flush(): Unit = Host.obj.flush(fd)
  override def close(): Unit = flush()
  override def checkError(): Boolean = false
}

private object HostPrintStream {
  /** Never written to: every write is overridden above. */
  final class Bytes(fd: Int) extends OutputStream {
    def write(b: Int): Unit = Host.obj.writeBytes(fd, Int8Array.of(b.toByte))
  }
}

/** Bytes of the lines the user enters. `read(buf, off, len)` returns what is
 *  buffered and blocks only when nothing is: the default InputStream one
 *  would block until `len` bytes arrived, i.e. never return a line. */
private final class HostInputStream extends InputStream {
  private var buf: Int8Array = null
  private var pos = 0

  /** True when there is at least one byte to read, asking the host if not. */
  private def fill(): Boolean = {
    while (buf == null || pos >= buf.length) {
      val r = Host.obj.readStdin()
      if (r == null || js.isUndefined(r)) { buf = null; pos = 0; return false }
      buf = r.asInstanceOf[Int8Array]
      pos = 0
    }
    true
  }

  override def read(): Int =
    if (!fill()) -1
    else { val b = buf(pos) & 0xff; pos += 1; b }

  override def read(b: Array[Byte], off: Int, len: Int): Int = {
    if (off < 0 || len < 0 || len > b.length - off) throw new IndexOutOfBoundsException
    if (len == 0) 0
    else if (!fill()) -1
    else {
      val n = math.min(len, buf.length - pos)
      var i = 0
      while (i < n) { b(off + i) = buf(pos + i); i += 1 }
      pos += n
      n
    }
  }

  override def available(): Int = if (buf == null) 0 else buf.length - pos
}
