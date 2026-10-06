package corpus.flow

import java.sql.Connection

import org.sqlite.SQLiteDataSource

trait Repo {
  def find(id: Int): Option[String]
}

class SqliteRepo(path: String) extends Repo {
  private val ds = new SQLiteDataSource()
  ds.setUrl(s"jdbc:sqlite:$path")

  def find(id: Int): Option[String] = {
    val conn: Connection = ds.getConnection() // @expect sink cs=trait-dispatch lib=org.xerial:sqlite-jdbc
    try {
      val st = conn.prepareStatement("select name from users where id = ?")
      st.setInt(1, id)
      val rs = st.executeQuery()
      if (rs.next()) Some(rs.getString(1)) else None
    } finally conn.close()
  }
}
