package java.lang.ref

import scala.language.unsafeNulls
import scala.scalajs.js

/** A reference that does not keep its referent alive, using JavaScript's
 *  WeakRef. Primitives (which JS cannot hold weakly) are held strongly.
 *  References are never enqueued: ReferenceQueue.poll() is always null, so
 *  code that cleans up through the queue keeps its (now empty) entries. */
abstract class Reference[T](referent: T, weak: Boolean) {
  private var strong: Any = null
  private var weakRef: js.Dynamic = null
  if (referent != null) {
    val t = js.typeOf(referent.asInstanceOf[js.Any])
    if (weak && (t == "object" || t == "function")) weakRef = js.Dynamic.newInstance(js.Dynamic.global.WeakRef)(referent.asInstanceOf[js.Any])
    else strong = referent
  }
  def get(): T =
    if (weakRef != null) {
      val v = weakRef.deref()
      if (js.isUndefined(v)) null.asInstanceOf[T] else v.asInstanceOf[T]
    } else strong.asInstanceOf[T]
  def clear(): Unit = { strong = null; weakRef = null }
  def isEnqueued(): Boolean = false
  def enqueue(): Boolean = false
  def refersTo(obj: T): Boolean = get().asInstanceOf[AnyRef] eq obj.asInstanceOf[AnyRef]
}

class WeakReference[T](referent: T, queue: ReferenceQueue[? >: T]) extends Reference[T](referent, true) {
  def this(referent: T) = this(referent, null)
}

class SoftReference[T](referent: T, queue: ReferenceQueue[? >: T]) extends Reference[T](referent, false) {
  def this(referent: T) = this(referent, null)
}

class ReferenceQueue[T] {
  def poll(): Reference[? <: T] = null
  def remove(): Reference[? <: T] = null
  def remove(timeout: Long): Reference[? <: T] = null
}
