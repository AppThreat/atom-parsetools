// Scala.js ground-truth fixture: scalajs-dom fetch/WebSocket/WebCrypto, Node crypto via js.Dynamic, upickle %%%.
ThisBuild / organization := "corpus.scala"
ThisBuild / version := "0.1.0"
ThisBuild / scalaVersion := "3.3.7"

lazy val root = (project in file("."))
  .enablePlugins(ScalaJSPlugin)
  .settings(
    name := "scalajs-app",
    scalaJSUseMainModuleInitializer := true,
    libraryDependencies ++= Seq(
      "org.scala-js" %%% "scalajs-dom" % "2.8.1",
      "com.lihaoyi" %%% "upickle" % "4.4.3"
    )
  )
