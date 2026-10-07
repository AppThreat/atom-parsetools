package corpus.mill

import java.security.MessageDigest

object WebApp extends cask.MainRoutes {
  @cask.get("/greet/:name") // @expect endpoint method=GET path=/greet/{name} fw=cask
  def greet(name: String): String = s"Hello $name"

  @cask.post("/webhook") // @expect endpoint method=POST path=/webhook fw=cask
  def webhook(request: cask.Request): String = {
    val sig = MessageDigest.getInstance("SHA-256").digest(request.bytes) // @expect crypto alg=SHA-256
    Notifier.forward(sig.length.toString) // @expect frame cs=mill-forward n=1
  }

  initialize()
}

object Notifier {
  def forward(body: String): String =
    requests.post("https://hooks.example.com/forward", data = body).text() // @expect outbound url=https://hooks.example.com/forward client=requests-scala @expect sink cs=mill-forward lib=com.lihaoyi:requests
}
