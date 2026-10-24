package java.net

import scala.language.unsafeNulls

/** A URL as a string; nothing opens connections. */
final class URL(spec: String) extends java.io.Serializable {
  def toURI(): URI = new URI(spec)
  def getProtocol(): String = { val i = spec.indexOf(':'); if (i < 0) "" else spec.substring(0, i) }
  def getPath(): String = toURI().getPath
  def toExternalForm(): String = spec
  override def toString(): String = spec
  override def equals(o: Any): Boolean = o match { case u: URL => u.toString == spec; case _ => false }
  override def hashCode(): Int = spec.hashCode
}
