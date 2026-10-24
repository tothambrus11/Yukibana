package java.nio.file.attribute

trait FileAttribute[T] {
  def name(): String
  def value(): T
}

final class FileTime private (millis: Long) extends Comparable[FileTime] {
  def toMillis(): Long = millis
  def compareTo(o: FileTime): Int = java.lang.Long.compare(millis, o.toMillis())
}
object FileTime {
  def fromMillis(millis: Long): FileTime = new FileTime(millis)
}

trait BasicFileAttributes {
  def isDirectory(): Boolean
  def isRegularFile(): Boolean
  def size(): Long
  def lastModifiedTime(): FileTime
}
