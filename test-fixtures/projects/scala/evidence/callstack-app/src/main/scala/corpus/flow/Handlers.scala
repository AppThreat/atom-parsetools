package corpus.flow

import scala.concurrent.{ExecutionContext, Future}

object Handlers {
  def fetchAll(urls: List[String]): List[String] =
    urls.map(u => HttpGateway.get(u)) // @expect frame cs=hof n=2

  def handle(cmd: Command, repo: Repo): String = cmd match {
    case Fetch(url) => HttpGateway.get(url) // @expect frame cs=pattern n=2
    case Lookup(id) => repo.find(id).getOrElse("")
  }

  def parseName(raw: Option[String]): Option[String] =
    for {
      text <- raw
      json = ujson.read(text) // @expect sink cs=for-comp lib=com.lihaoyi:ujson
    } yield json("name").str

  def async(url: String)(implicit ec: ExecutionContext): Future[String] =
    Future(HttpGateway.get(url)) // @expect frame cs=future n=2
}
