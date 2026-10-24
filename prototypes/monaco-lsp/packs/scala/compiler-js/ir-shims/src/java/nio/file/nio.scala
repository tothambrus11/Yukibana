package java.nio.file

import scala.language.unsafeNulls
import scala.annotation.varargs

/** Paths are strings with '/' separators; see java/io/files.scala. */
trait Path extends Comparable[Path] with java.lang.Iterable[Path] {
  def getFileName(): Path
  def getParent(): Path
  def getRoot(): Path
  def isAbsolute(): Boolean
  def getNameCount(): Int
  def getName(index: Int): Path
  def resolve(other: String): Path
  def resolve(other: Path): Path
  def resolveSibling(other: String): Path
  def relativize(other: Path): Path
  def normalize(): Path
  def toAbsolutePath(): Path
  def toRealPath(options: Array[LinkOption]): Path
  def toUri(): java.net.URI
  def toFile(): java.io.File
  def startsWith(other: String): Boolean
  def startsWith(other: Path): Boolean
  def endsWith(other: String): Boolean
  def endsWith(other: Path): Boolean
  def getFileSystem(): FileSystem
}

abstract class FileSystem

private[file] final class StringPath(val p: String) extends Path {
  private def parts: List[String] = p.split('/').toList.filter(_.nonEmpty)
  def getFileName(): Path = if (parts.isEmpty) null else new StringPath(parts.last)
  def getParent(): Path = {
    val i = p.lastIndexOf('/')
    if (i < 0) null else if (i == 0) (if (p.length > 1) new StringPath("/") else null) else new StringPath(p.substring(0, i))
  }
  def getRoot(): Path = if (isAbsolute()) new StringPath("/") else null
  def isAbsolute(): Boolean = p.startsWith("/")
  def getNameCount(): Int = parts.length
  def getName(index: Int): Path = new StringPath(parts(index))
  def resolve(other: String): Path = if (other.startsWith("/")) new StringPath(other) else if (p.isEmpty) new StringPath(other) else new StringPath(p.stripSuffix("/") + "/" + other)
  def resolve(other: Path): Path = resolve(other.toString)
  def resolveSibling(other: String): Path = { val q = getParent(); if (q == null) new StringPath(other) else q.resolve(other) }
  def relativize(other: Path): Path = {
    val a = parts; val b = other.asInstanceOf[StringPath].parts
    val common = a.zip(b).takeWhile(x => x._1 == x._2).length
    new StringPath((List.fill(a.length - common)("..") ++ b.drop(common)).mkString("/"))
  }
  def normalize(): Path = {
    val out = scala.collection.mutable.ListBuffer.empty[String]
    parts.foreach { case "." => case ".." => if (out.nonEmpty && out.last != "..") out.remove(out.length - 1) else if (!isAbsolute()) out += ".."; case x => out += x }
    new StringPath((if (isAbsolute()) "/" else "") + out.mkString("/"))
  }
  def toAbsolutePath(): Path = if (isAbsolute()) this else new StringPath("/" + p)
  def toRealPath(options: Array[LinkOption]): Path = toAbsolutePath().normalize()
  def toUri(): java.net.URI = new java.net.URI("file", null, toAbsolutePath().toString, null)
  def toFile(): java.io.File = new java.io.File(p)
  def startsWith(other: String): Boolean = parts.startsWith(new StringPath(other).parts) && (isAbsolute() == other.startsWith("/"))
  def startsWith(other: Path): Boolean = startsWith(other.toString)
  def endsWith(other: String): Boolean = parts.endsWith(new StringPath(other).parts)
  def endsWith(other: Path): Boolean = endsWith(other.toString)
  def getFileSystem(): FileSystem = null
  def iterator(): java.util.Iterator[Path] = {
    val l = new java.util.ArrayList[Path]
    parts.foreach(x => l.add(new StringPath(x)))
    l.iterator()
  }
  def compareTo(o: Path): Int = p.compareTo(o.toString)
  override def equals(o: Any): Boolean = o match { case s: StringPath => s.p == p; case _ => false }
  override def hashCode(): Int = p.hashCode
  override def toString(): String = p
}

object Paths {
  @varargs def get(first: String, more: String*): Path =
    new StringPath((first +: more).filter(_.nonEmpty).mkString("/"))
  def get(uri: java.net.URI): Path = new StringPath(uri.getPath)
}

trait OpenOption
trait CopyOption

enum LinkOption extends java.lang.Enum[LinkOption] with OpenOption with CopyOption {
  case NOFOLLOW_LINKS
}

enum StandardOpenOption extends java.lang.Enum[StandardOpenOption] with OpenOption {
  case READ, WRITE, APPEND, TRUNCATE_EXISTING, CREATE, CREATE_NEW
}

class InvalidPathException(input: String, reason: String) extends IllegalArgumentException(reason + ": " + input) {
  def getInput(): String = input
  def getReason(): String = reason
}
class FileSystemException(file: String) extends java.io.IOException(file) {
  def getFile(): String = file
}
class FileAlreadyExistsException(file: String) extends FileSystemException(file)
class NoSuchFileException(file: String) extends FileSystemException(file)
class NotDirectoryException(file: String) extends FileSystemException(file)
class AccessDeniedException(file: String) extends FileSystemException(file)

/** Nothing exists; anything that would read or write throws. */
object Files {
  private def none(p: Path): Nothing = throw new NoSuchFileException(String.valueOf(p) + " (no file system in the browser)")
  @varargs def exists(p: Path, options: LinkOption*): Boolean = false
  @varargs def notExists(p: Path, options: LinkOption*): Boolean = true
  @varargs def isDirectory(p: Path, options: LinkOption*): Boolean = false
  @varargs def isRegularFile(p: Path, options: LinkOption*): Boolean = false
  def isReadable(p: Path): Boolean = false
  def isWritable(p: Path): Boolean = false
  def isSymbolicLink(p: Path): Boolean = false
  def size(p: Path): Long = none(p)
  @varargs def getLastModifiedTime(p: Path, options: LinkOption*): attribute.FileTime = none(p)
  @varargs def newInputStream(p: Path, options: OpenOption*): java.io.InputStream = none(p)
  @varargs def newOutputStream(p: Path, options: OpenOption*): java.io.OutputStream = none(p)
  def readAllBytes(p: Path): Array[Byte] = none(p)
  def list(p: Path): java.util.stream.Stream[Path] = none(p)
  @varargs def createFile(p: Path, attrs: attribute.FileAttribute[?]*): Path = none(p)
  @varargs def createDirectory(p: Path, attrs: attribute.FileAttribute[?]*): Path = none(p)
  @varargs def createDirectories(p: Path, attrs: attribute.FileAttribute[?]*): Path = none(p)
  def delete(p: Path): Unit = none(p)
  def deleteIfExists(p: Path): Boolean = false
}
