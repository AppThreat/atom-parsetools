package showcase

import scala.annotation.tailrec

case class Envelope(id: Long, payload: String)

object Sample:
  final val Algorithm = "AES/GCM/NoPadding"
  inline val DigestName = "SHA-256"

  def encrypt(data: Array[Byte]): Unit =
    val cipher = javax.crypto.Cipher.getInstance(Algorithm)
    val digest = java.security.MessageDigest.getInstance(DigestName)
    println(s"encrypted ${data.length} bytes")

  def describe(algorithm: String): String = s"algorithm $algorithm"

  @tailrec
  def loop(n: Int, acc: Int): Int =
    if n == 0 then acc else loop(n - 1, acc + n)

  given ordering: Ordering[Envelope] = Ordering.by(_.id)

  extension (e: Envelope)
    def summary: String = s"${e.id}: ${e.payload}"

enum Color:
  case Red, Green
