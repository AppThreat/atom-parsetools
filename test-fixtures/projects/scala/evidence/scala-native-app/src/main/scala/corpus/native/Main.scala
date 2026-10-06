package corpus.native

import scala.scalanative.unsafe._
import scala.scalanative.unsigned._

object Main {
  final val CurlOptUrl = 10002

  def sha256(text: String): Array[Byte] = Zone.acquire { implicit z =>
    val out = alloc[Byte](32)
    val len = alloc[CUnsignedInt](1)
    val in = toCString(text)
    libcrypto.EVP_Digest(in, text.length.toCSize, out, len, libcrypto.EVP_sha256(), null) // @expect crypto alg=SHA-256 kind=native-call
    Array.tabulate(32)(i => out(i))
  }

  def fetch(): Int = Zone.acquire { implicit z =>
    val handle = libcurl.curl_easy_init()
    libcurl.curl_easy_setopt(handle, CurlOptUrl, toCString("https://api.example.com/native/ping")) // @expect outbound url=https://api.example.com/native/ping client=libcurl
    libcurl.curl_easy_perform(handle)
  }

  def main(args: Array[String]): Unit = {
    println(upickle.default.write(sha256(args.mkString).toSeq)) // @expect use lib=com.lihaoyi:upickle
    println(fetch())
  }
}
