package corpus.flow

import upickle.default.{macroRW, ReadWriter}

case class User(id: Int, name: String)

object User {
  implicit val rw: ReadWriter[User] = macroRW
}

sealed trait Command
final case class Fetch(url: String) extends Command
final case class Lookup(id: Int) extends Command
