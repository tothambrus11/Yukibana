// Scala 3 compiler (upstream sources, see ../build.sh) cross-compiled to
// Scala.js, plus the LSP server in src/main/scala. Built by ../build.sh, which
// sets yukibana.upstream to the prepared upstream source tree.
import org.scalajs.linker.interface.{ESVersion, ModuleSplitStyle}

val upstream = file(sys.props.getOrElse("yukibana.upstream", sys.error("-Dyukibana.upstream=<dir> is required")))

val commonSettings = Def.settings(
  scalaVersion := "3.7.4",
  scalacOptions ++= Seq("-Yexplicit-nulls", "-source", "3.3", "-encoding", "UTF8",
    "-language:implicitConversions", "-nowarn"),
  target := file(sys.props.getOrElse("yukibana.target", "target")) / name.value,
)

// The compiler implements Java interfaces (scala3-interfaces and
// dotc/sbt/interfaces/*.java). Scala.js cannot compile Java, and a Scala
// trait would not typecheck the compiler's sources the same way (Java methods
// may be called with or without `()`). So the compiler is typechecked against
// the Java definitions, and the linker is given Scala.js IR for the same
// interfaces from this project: the IR of `def name: String` and of Java's
// `String name()` is the same method.
// It is compiled against the compiler (for the types in the sbt callbacks'
// signatures) and only its own IR is handed to the linker.
lazy val irShims = project.in(file("ir-shims"))
  .enablePlugins(ScalaJSPlugin)
  .dependsOn(root)
  .settings(
    commonSettings,
    name := "ir-shims",
    Compile / unmanagedSourceDirectories := Seq(baseDirectory.value / "src"),
  )

lazy val root = project.in(file("."))
  .enablePlugins(ScalaJSPlugin)
  .settings(
    commonSettings,
    name := "yukibana-scala-lsp",
    Compile / unmanagedSourceDirectories ++= Seq(
      upstream / "compiler",
      upstream / "tasty",
      upstream / "scalajs-ir",
    ),
    // Java libraries the compiler's sources mention. They are on the compile
    // classpath only so the sources typecheck; nothing reachable from the
    // language server may call into them (the linker would fail if it did).
    libraryDependencies ++= Seq(
      "org.scala-lang" % "scala3-interfaces" % "3.7.4",
      "org.scala-lang.modules" % "scala-asm" % "9.8.0-scala-1",
      "org.scala-sbt" % "compiler-interface" % "1.10.7",
      "org.jline" % "jline-reader" % "3.29.0",
      "org.jline" % "jline-terminal" % "3.29.0",
    ),
    Compile / fullClasspath := (LocalProject("irShims") / Compile / exportedProducts).value ++ (Compile / fullClasspath).value,
    scalaJSLinkerConfig ~= {
      _.withModuleKind(ModuleKind.ESModule)
        .withESFeatures(_.withESVersion(ESVersion.ES2021))
        .withSourceMap(false)
    },
  )

// What runner.js links into every program, before its main: the standard
// streams (stdout/stderr as they are written, stdin through the
// SharedArrayBuffer protocol of CONTRACT.md). Only compiled; build.sh puts its
// .sjsir into sjsir.bin with the library IR.
lazy val runtime = project.in(file("runtime"))
  .enablePlugins(ScalaJSPlugin)
  .settings(
    commonSettings,
    name := "yukibana-runtime",
    scalacOptions -= "-Yexplicit-nulls",
    Compile / unmanagedSourceDirectories := Seq(baseDirectory.value / "src"),
  )

// The Scala.js linker, compiled with Scala.js (upstream publishes it so:
// scalajs-linker_sjs1_2.13, the same version the compiler's back end emits
// IR for), behind one exported function. runner.js loads it as sjslinker.js.
lazy val linker = project.in(file("linker"))
  .enablePlugins(ScalaJSPlugin)
  .settings(
    commonSettings,
    name := "yukibana-sjs-linker",
    scalacOptions -= "-Yexplicit-nulls",
    Compile / unmanagedSourceDirectories := Seq(baseDirectory.value / "src"),
    libraryDependencies += ("org.scala-js" %%% "scalajs-linker" % "1.19.0").cross(CrossVersion.for3Use2_13),
    scalaJSLinkerConfig ~= {
      _.withModuleKind(ModuleKind.ESModule)
        .withESFeatures(_.withESVersion(ESVersion.ES2021))
        .withSourceMap(false)
    },
  )
