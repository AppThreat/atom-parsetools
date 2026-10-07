package corpus.flow

import org.apache.commons.text.StringEscapeUtils

trait Decoder[A] {
  def decode(raw: String): A
}

object Decoder {
  implicit val userDecoder: Decoder[User] = new Decoder[User] {
    def decode(raw: String): User = upickle.default.read[User](raw) // @expect sink cs=typeclass lib=com.lihaoyi:upickle-core
  }

  def decode[A](raw: String)(implicit d: Decoder[A]): A = d.decode(raw) // @expect frame cs=typeclass n=2
}

object Syntax {
  implicit class Escaping(val s: String) extends AnyVal {
    def escaped: String = StringEscapeUtils.escapeHtml4(s) // @expect sink cs=extension lib=org.apache.commons:commons-text
  }

  def traced(body: String): String = s"[trace] $body"
}
