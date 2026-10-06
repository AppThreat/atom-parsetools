package corpus.flow

import scala.concurrent.ExecutionContext.Implicits.global

import corpus.flow.Syntax._

object Main {
  def main(args: Array[String]): Unit = {
    val repo: Repo = new SqliteRepo("app.db")
    println(repo.find(1)) // @expect frame cs=trait-dispatch n=1
    println(Decoder.decode[User](args.head)) // @expect frame cs=typeclass n=1
    println(args.head.escaped) // @expect frame cs=extension n=1
    println(Handlers.fetchAll(args.toList)) // @expect frame cs=hof n=1
    println(Handlers.parseName(args.headOption)) // @expect frame cs=for-comp n=1
    println(Handlers.handle(Fetch(args.head), repo)) // @expect frame cs=pattern n=1
    println(Retry.retry(3)(HttpGateway.get(args.head))) // @expect frame cs=byname n=1
    println(Handlers.async(args.head)) // @expect frame cs=future n=1
    println(ApiClient(args.head).base) // @expect frame cs=companion-apply n=1
    println(traced(args.head))
  }
}
