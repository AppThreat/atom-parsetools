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
