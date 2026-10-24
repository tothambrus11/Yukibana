package java.security

/** MD5 only: the compiler hashes over-long generated names with it. */
abstract class MessageDigest(algorithm: String) {
  def update(input: Array[Byte]): Unit
  def digest(): Array[Byte]
  def reset(): Unit
  def digest(input: Array[Byte]): Array[Byte] = { update(input); digest() }
  def getAlgorithm(): String = algorithm
}

object MessageDigest {
  def getInstance(algorithm: String): MessageDigest =
    if (algorithm.equalsIgnoreCase("MD5")) new MD5
    else throw new NoSuchAlgorithmException(algorithm + " MessageDigest not available")
}

class NoSuchAlgorithmException(msg: String) extends GeneralSecurityException(msg)
class GeneralSecurityException(msg: String) extends Exception(msg)

private final class MD5 extends MessageDigest("MD5") {
  private val buf = new java.io.ByteArrayOutputStream
  def update(input: Array[Byte]): Unit = buf.write(input, 0, input.length)
  def reset(): Unit = buf.reset()
  def digest(): Array[Byte] = {
    val msg = buf.toByteArray; buf.reset()
    val s = Array(7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21)
    val k = Array.tabulate(64)(i => (Math.abs(Math.sin(i + 1.0)) * 4294967296.0).toLong.toInt)
    val bitLen = msg.length.toLong * 8
    val padded = new Array[Byte](((msg.length + 8) / 64 + 1) * 64)
    System.arraycopy(msg, 0, padded, 0, msg.length)
    padded(msg.length) = 0x80.toByte
    for (i <- 0 until 8) padded(padded.length - 8 + i) = (bitLen >>> (8 * i)).toByte
    var a0 = 0x67452301; var b0 = 0xefcdab89; var c0 = 0x98badcfe; var d0 = 0x10325476
    for (chunk <- 0 until padded.length / 64) {
      val m = Array.tabulate(16)(j => (0 until 4).map(b => (padded(chunk * 64 + j * 4 + b) & 0xff) << (8 * b)).reduce(_ | _))
      var a = a0; var b = b0; var c = c0; var d = d0
      for (i <- 0 until 64) {
        val (f0, g) =
          if (i < 16) ((b & c) | (~b & d), i)
          else if (i < 32) ((d & b) | (~d & c), (5 * i + 1) % 16)
          else if (i < 48) (b ^ c ^ d, (3 * i + 5) % 16)
          else (c ^ (b | ~d), (7 * i) % 16)
        val f = f0 + a + k(i) + m(g)
        a = d; d = c; c = b
        b = b + Integer.rotateLeft(f, s(i))
      }
      a0 += a; b0 += b; c0 += c; d0 += d
    }
    val out = new Array[Byte](16)
    for ((w, j) <- Seq(a0, b0, c0, d0).zipWithIndex; b <- 0 until 4) out(j * 4 + b) = (w >>> (8 * b)).toByte
    out
  }
}
