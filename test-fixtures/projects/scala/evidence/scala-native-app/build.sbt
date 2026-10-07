// Scala Native ground-truth fixture: @extern bindings to libcrypto and libcurl, posix calls, upickle %%%.
ThisBuild / organization := "corpus.scala"
ThisBuild / version := "0.1.0"
ThisBuild / scalaVersion := "3.3.7"

lazy val root = (project in file("."))
  .enablePlugins(ScalaNativePlugin)
  .settings(
    name := "scala-native-app",
    libraryDependencies ++= Seq("com.lihaoyi" %%% "upickle" % "4.4.3")
  )
