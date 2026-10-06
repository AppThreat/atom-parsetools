package corpus.web

import scala.scalajs.js
import scala.scalajs.js.typedarray.Uint8Array

import org.scalajs.dom

object Api {
  def loadProfile(): js.Promise[dom.Response] =
    dom.fetch("https://api.example.com/v1/profile") // @expect outbound url=https://api.example.com/v1/profile client=scalajs-dom @expect sink cs=js-fetch lib=org.scala-js:scalajs-dom

  def stream(): dom.WebSocket =
    new dom.WebSocket("wss://stream.example.com/events") // @expect outbound url=wss://stream.example.com/events client=scalajs-dom

  def digest(data: Uint8Array): js.Promise[js.Any] =
    dom.crypto.subtle.digest("SHA-256", data).asInstanceOf[js.Promise[js.Any]] // @expect crypto alg=SHA-256 lib=org.scala-js:scalajs-dom

  def nodeMd5(text: String): String = {
    val crypto = js.Dynamic.global.require("crypto")
    crypto.createHash("md5").update(text).digest("hex").asInstanceOf[String] // @expect crypto alg=MD5 weak=true
  }

  def remember(token: String): Unit =
    dom.window.localStorage.setItem("token", token) // @expect use lib=org.scala-js:scalajs-dom
}
