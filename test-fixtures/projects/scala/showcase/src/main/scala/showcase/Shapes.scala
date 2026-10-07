package showcase

/** Argument shapes the report writer and the evidence rules read. */
object Shapes:
  final val Host = "https://example.com"

  def digestWith(algorithm: String, data: Array[Byte]): Array[Byte] =
    java.security.MessageDigest.getInstance(algorithm).digest(data)

  def callSite(data: Array[Byte]): Array[Byte] =
    digestWith("SHA-1", data)

  def viaLocalVal(data: Array[Byte]): Array[Byte] =
    val algorithm = "SHA-512"
    digestWith(algorithm, data)

  def interpolation(): String =
    s"${Sample.Algorithm} for ${Host}"

  def lambdaBody(items: List[String]): List[Int] =
    items.map(item => item.length)

  def matcher(value: Any): String = value match
    case Envelope(1, payload) => payload
    case other => other.toString

  def describe(algorithm: String): String = s"uses $algorithm"

  def receiver(data: Array[Byte]): Array[Byte] =
    val digest = java.security.MessageDigest.getInstance("MD5")
    digest.digest(data)

  def curried(key: String)(algorithm: String): java.security.MessageDigest =
    java.security.MessageDigest.getInstance(algorithm)

  def curriedSite(): java.security.MessageDigest = curried("not-an-algorithm")("SHA-384")

  def throughLocal(algorithm: String): java.security.MessageDigest =
    val md = java.security.MessageDigest.getInstance(algorithm)
    md

  def withContext(algorithm: String)(using label: String): java.security.MessageDigest =
    java.security.MessageDigest.getInstance(algorithm)

  def contextSite(): java.security.MessageDigest =
    given String = "context-label"
    withContext("SHA-224")

  def fetch(url: String): Int = url.length

  def holes(id: String, name: String): Int =
    fetch(s"https://api.example.com/users/${id.trim}/orders/$name")

  def block(body: => Unit): Unit = body

  def blockSite(n: Int): Unit = block {
    val items = List("first-literal", "second-literal")
    println(s"count $n")
  }

  def evaluated[T](body: => T): T =
    val result = body
    result

class Holder:
  val field = "SHA-256"
  var mutable = "MD5"
