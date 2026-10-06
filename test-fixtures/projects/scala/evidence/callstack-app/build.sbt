// Call-stack ground-truth fixture: each scenario is an entry point -> project frames -> library sink.
// `// @expect frame cs=<id> n=<k>` marks frame k (1 = entry) and `// @expect sink cs=<id> lib=<g:a>` the library call.
ThisBuild / organization := "corpus.scala"
ThisBuild / version := "0.1.0"
lazy val scala3 = "3.3.7"
lazy val scala213 = "2.13.18"
ThisBuild / scalaVersion := scala3
ThisBuild / crossScalaVersions := Seq(scala3, scala213)

lazy val root = (project in file("."))
  .settings(
    name := "callstack-app",
    libraryDependencies ++= Seq(
      "com.lihaoyi" %% "upickle" % "4.4.3",
      "com.squareup.okhttp3" % "okhttp" % "4.12.0",
      "org.xerial" % "sqlite-jdbc" % "3.53.4.0",
      "org.apache.commons" % "commons-text" % "1.14.0"
    )
  )
