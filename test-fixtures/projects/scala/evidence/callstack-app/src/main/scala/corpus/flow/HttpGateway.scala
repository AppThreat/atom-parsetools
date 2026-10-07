package corpus.flow

import okhttp3.{OkHttpClient, Request}

object HttpGateway {
  private lazy val client = new OkHttpClient()

  def get(url: String): String = {
    val request = new Request.Builder().url(url).build()
    client.newCall(request).execute().body().string() // @expect sink cs=hof,pattern,byname,future lib=com.squareup.okhttp3:okhttp
  }
}

final class ApiClient private (val base: String, val http: OkHttpClient)

object ApiClient {
  def apply(base: String): ApiClient = new ApiClient(base, new OkHttpClient.Builder().build()) // @expect sink cs=companion-apply lib=com.squareup.okhttp3:okhttp
}

object Retry {
  def retry[A](times: Int)(body: => A): A =
    try body // @expect frame cs=byname n=2
    catch { case _: Exception if times > 1 => retry(times - 1)(body) }
}
