package java.util.stream

/** Only the shape: Files.list, the one source of streams here, throws. */
trait Stream[T] extends AutoCloseable {
  def toArray(generator: java.util.function.IntFunction[?]): Array[AnyRef]
  def close(): Unit
}
