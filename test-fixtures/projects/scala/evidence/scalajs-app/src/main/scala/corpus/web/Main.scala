package corpus.web

import upickle.default._

final case class Profile(id: Int, name: String) derives ReadWriter

object Main {
  def main(args: Array[String]): Unit = {
    val profile = read[Profile]("""{"id":1,"name":"x"}""") // @expect use lib=com.lihaoyi:upickle
    println(profile)
    Api.loadProfile() // @expect frame cs=js-fetch n=1
    Api.remember(profile.name)
  }
}
