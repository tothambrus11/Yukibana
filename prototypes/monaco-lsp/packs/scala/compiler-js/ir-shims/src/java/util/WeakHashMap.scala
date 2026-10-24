package java.util

import scala.language.unsafeNulls

/** A hash map whose keys are held through WeakRef (equality and hash are the
 *  key's own, as in the JDK). Entries whose key was collected are dropped on
 *  size(), entrySet() and every 256th put. entrySet() is a snapshot. */
class WeakHashMap[K, V] extends AbstractMap[K, V] {
  private abstract class Key { def key: Any; val hash: Int
    override def hashCode(): Int = hash
    override def equals(o: Any): Boolean = o match {
      case o: Key => (o eq this) || { val a = key; a != null && a == o.key }
      case _ => false
    }
  }
  private final class Probe(val key: Any) extends Key { val hash = if (key == null) 0 else key.hashCode() }
  private final class Held(k: Any) extends Key {
    val hash = if (k == null) 0 else k.hashCode()
    private val ref = new java.lang.ref.WeakReference[Any](k)
    def key: Any = ref.get()
  }
  private val m = new HashMap[Key, V]
  private var puts = 0
  private def expunge(): Unit = {
    val it = m.keySet().iterator()
    while (it.hasNext) if (it.next().key == null) it.remove()
  }
  override def get(k: Any): V = m.get(new Probe(k))
  override def containsKey(k: Any): Boolean = m.containsKey(new Probe(k))
  override def put(k: K, v: V): V = {
    puts += 1
    if ((puts & 255) == 0) expunge()
    val old = m.remove(new Probe(k))
    m.put(new Held(k), v)
    old
  }
  override def remove(k: Any): V = m.remove(new Probe(k))
  override def size(): Int = { expunge(); m.size() }
  override def isEmpty(): Boolean = size() == 0
  override def clear(): Unit = m.clear()
  def entrySet(): Set[Map.Entry[K, V]] = {
    expunge()
    val out = new HashSet[Map.Entry[K, V]]
    val it = m.entrySet().iterator()
    while (it.hasNext) {
      val e = it.next()
      val k = e.getKey.key
      if (k != null) out.add(new AbstractMap.SimpleEntry[K, V](k.asInstanceOf[K], e.getValue))
    }
    out
  }
}
