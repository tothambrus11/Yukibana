package java.util

import scala.language.unsafeNulls

/** A set of enum values backed by a HashSet (the JDK's is a bit vector). */
class EnumSet[E <: java.lang.Enum[E]] private[util] () extends AbstractSet[E] with Cloneable with java.io.Serializable {
  private val s = new HashSet[E]
  override def add(e: E): Boolean = s.add(e)
  override def remove(o: Any): Boolean = s.remove(o)
  override def contains(o: Any): Boolean = s.contains(o)
  def iterator(): Iterator[E] = s.iterator()
  def size(): Int = s.size()
  override def clone(): EnumSet[E] = { val c = new EnumSet[E]; c.addAll(this); c }
}

object EnumSet {
  def noneOf[E <: java.lang.Enum[E]](elementType: Class[E]): EnumSet[E] = new EnumSet[E]
  def of[E <: java.lang.Enum[E]](e: E): EnumSet[E] = { val s = new EnumSet[E]; s.add(e); s }
  def of[E <: java.lang.Enum[E]](e1: E, e2: E): EnumSet[E] = { val s = of(e1); s.add(e2); s }
  def of[E <: java.lang.Enum[E]](e1: E, e2: E, e3: E): EnumSet[E] = { val s = of(e1, e2); s.add(e3); s }
  def copyOf[E <: java.lang.Enum[E]](s: EnumSet[E]): EnumSet[E] = s.clone()
}
