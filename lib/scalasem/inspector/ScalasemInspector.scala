import scala.collection.mutable
import scala.quoted.*
import scala.tasty.inspector.*

/** Emits compiler facts for a set of TASTy files as one JSON object per line.
  *
  * The Node side of scalasem normalises the paths, drops references to symbols the inspected
  * files define themselves and applies the report caps, so this helper stays a plain fact
  * dump: call sites, definitions, references, constants and diagnostics, each carrying the
  * source file and the 1-based line and column the compiler recorded.
  *
  * Only the public scala.quoted and scala.tasty.inspector APIs are used, so the same source
  * compiles with every Scala 3 release the helper is built against.
  */
object ScalasemInspector:

  def jsonStr(s: String): String =
    val sb = new StringBuilder(s.length + 2)
    sb += '"'
    var i = 0
    while i < s.length do
      s.charAt(i) match
        case '"' => sb ++= "\\\""
        case '\\' => sb ++= "\\\\"
        case '\n' => sb ++= "\\n"
        case '\r' => sb ++= "\\r"
        case '\t' => sb ++= "\\t"
        case c if c < ' ' => sb ++= f"\\u${c.toInt}%04x"
        case c => sb += c
      i += 1
    sb += '"'
    sb.result

  def main(args: Array[String]): Unit =
    val classpathFile = args.find(_.startsWith("--classpath-file="))
    if classpathFile.isEmpty then
      System.err.println("usage: ScalasemInspector --classpath-file=<file> <tasty file>...")
      sys.exit(2)
    val tastyFiles = args.filter(a => !a.startsWith("--")).toList
    val classpath = scala.io.Source
      .fromFile(classpathFile.get.stripPrefix("--classpath-file="))
      .mkString
      .trim
      .split(java.io.File.pathSeparatorChar)
      .toList
      .filter(_.nonEmpty)
    val collector = new FactCollector
    val ok =
      try TastyInspector.inspectAllTastyFiles(tastyFiles, Nil, classpath)(collector)
      catch case err: Throwable =>
        // A file the compiler cannot load aborts the run; whatever was collected is still
        // printed, and the caller retries the batch without the offending file.
        System.err.println(s"scalasem: ${err.getClass.getName}: ${Option(err.getMessage).getOrElse("")}")
        false
    collector.printFacts(ok)

/** Collects the facts of one inspection run. The facts are buffered so that the references can
  * be filtered against the symbols the inspected files define before anything is printed.
  */
final class FactCollector extends Inspector:
  private val facts = mutable.ArrayBuffer.empty[String]
  private val projectSymbols = mutable.Set.empty[String]
  private val refs = mutable.LinkedHashMap.empty[String, String]
  private var unresolvedSymbols = 0
  private var failedFiles = 0

  def inspect(using Quotes)(tastys: List[Tasty[quotes.type]]): Unit =
    import quotes.reflect.*

    def position(t: Tree): Option[Position] =
      try
        val p = t.pos
        if p.startLine >= 0 then Some(p) else None
      catch case _ => None

    def enclosingOf(owner: Symbol): String =
      val full = owner.fullName
      val anon = full.indexOf("$anonfun")
      if anon > 0 then full.substring(0, anon - 1) else full

    def flagsOf(sym: Symbol): Seq[String] =
      val fs = sym.flags
      Seq(
        "case" -> fs.is(Flags.Case),
        "given" -> fs.is(Flags.Given),
        "implicit" -> fs.is(Flags.Implicit),
        "inline" -> fs.is(Flags.Inline),
        "extension" -> fs.is(Flags.ExtensionMethod),
        "module" -> fs.is(Flags.Module),
        "trait" -> fs.is(Flags.Trait),
        "lazy" -> fs.is(Flags.Lazy),
        "final" -> fs.is(Flags.Final),
        "enum" -> fs.is(Flags.Enum),
        "synthetic" -> fs.is(Flags.Synthetic),
      ).collect { case (name, true) => name }

    def signatureOf(sym: Symbol): String =
      try
        val sig = sym.signature
        if sig == null then ""
        else s"(${sig.paramSigs.mkString(",")})${sig.resultSig}"
      catch case _ => ""

    def addFact(fields: String*): Unit = facts += fields.mkString("{", ",", "}")

    def annotationFacts(sym: Symbol): String =
      val annotations = sym.annotations.flatMap(annotation =>
        try
          val name = annotation.tpe.typeSymbol.fullName
          val args = mutable.ArrayBuffer.empty[String]
          object Gather extends TreeTraverser:
            override def traverseTree(tree: Tree)(owner: Symbol): Unit = tree match
              case Literal(constant) =>
                constant.value match
                  case s: String => args += ScalasemInspector.jsonStr(s)
                  case v: Int => args += v.toString
                  case v: Long => args += v.toString
                  case v: Boolean => args += v.toString
                  case _ => ()
              case _ => super.traverseTree(tree)(owner)
          Gather.traverseTree(annotation)(Symbol.spliceOwner)
          if args.isEmpty then List(s"""{"name":${ScalasemInspector.jsonStr(name)}}""")
          else
            List(s"""{"name":${ScalasemInspector.jsonStr(name)},"args":[${args.mkString(",")}]}""")
        catch case _ => Nil
      )
      if annotations.isEmpty then ""
      else s"\"annotations\":[${annotations.mkString(",")}]"

    def emitDefinition(
        sym: Symbol,
        kind: String,
        at: Option[Position],
        extra: mutable.ArrayBuffer[String] => Unit
    ): Unit =
      if !sym.exists then return
      val flags = flagsOf(sym)
      if flags.contains("synthetic") then return
      at match
        case None => ()
        case Some(p) =>
          val fields = mutable.ArrayBuffer.empty[String]
          fields += "\"kind\":\"def\""
          fields += s"\"defKind\":${ScalasemInspector.jsonStr(kind)}"
          fields += s"\"file\":${ScalasemInspector.jsonStr(p.sourceFile.path)}"
          fields += s"\"line\":${p.startLine + 1}"
          fields += s"\"column\":${p.startColumn + 1}"
          fields += s"\"endLine\":${p.endLine + 1}"
          fields += s"\"name\":${ScalasemInspector.jsonStr(sym.name)}"
          fields += s"\"owner\":${ScalasemInspector.jsonStr(sym.owner.fullName)}"
          fields += s"\"sym\":${ScalasemInspector.jsonStr(sym.fullName)}"
          if flags.nonEmpty then
            fields += s"\"flags\":[${flags.map(ScalasemInspector.jsonStr).mkString(",")}]"
          extra(fields)
          val signature = signatureOf(sym)
          if signature.nonEmpty then
            fields += s"\"signature\":${ScalasemInspector.jsonStr(signature)}"
          val annotations = annotationFacts(sym)
          if annotations.nonEmpty then fields += annotations
          addFact(fields.toSeq*)

    /** A val with a literal right hand side, resolvable across files. */
    def emitConstant(valDef: ValDef): Unit =
      valDef.rhs match
        case Some(Literal(constant)) =>
          constant.value match
            case s: String =>
              addFact(
                "\"kind\":\"const\"",
                s"\"file\":${ScalasemInspector.jsonStr(valDef.pos.sourceFile.path)}",
                s"\"line\":${valDef.pos.startLine + 1}",
                s"\"sym\":${ScalasemInspector.jsonStr(valDef.symbol.fullName)}",
                s"\"value\":${ScalasemInspector.jsonStr(s)}",
                "\"tpe\":\"string\"",
              )
            case v: Int =>
              addFact(
                "\"kind\":\"const\"",
                s"\"file\":${ScalasemInspector.jsonStr(valDef.pos.sourceFile.path)}",
                s"\"line\":${valDef.pos.startLine + 1}",
                s"\"sym\":${ScalasemInspector.jsonStr(valDef.symbol.fullName)}",
                s"\"value\":$v",
                "\"tpe\":\"int\"",
              )
            case _ => ()
        case _ => ()

    def callSymbol(fun: Tree): Symbol = fun match
      case apply: Apply => callSymbol(apply.fun)
      case typeApply: TypeApply => callSymbol(typeApply.fun)
      case select: Select => select.symbol
      case ident: Ident => ident.symbol
      case _ => Symbol.noSymbol

    /** Argument facts: string and number literals, references to constant vals, and the spread
      * of a repeated argument.
      */
    def argumentFacts(arg: Tree): List[String] = arg match
      case NamedArg(_, inner) => argumentFacts(inner)
      case Repeated(elems, _) => elems.flatMap(argumentFacts)
      case Literal(constant) =>
        constant.value match
          case s: String => List(s"""{"string":${ScalasemInspector.jsonStr(s)}}""")
          case v: Int => List(s"""{"int":$v}""")
          case v: Long => List(s"""{"long":$v}""")
          case v: Boolean => List(s"""{"boolean":$v}""")
          case _ => Nil
      case ident: Ident =>
        constantValue(ident.symbol) match
          case Some(s: String) =>
            List(
              s"""{"const":${ScalasemInspector.jsonStr(s)},"sym":${ScalasemInspector.jsonStr(ident.symbol.fullName)}}"""
            )
          case Some(v: Int) =>
            List(
              s"""{"const":$v,"sym":${ScalasemInspector.jsonStr(ident.symbol.fullName)}}"""
            )
          case _ => Nil
      case _ => Nil

    def constantValue(sym: Symbol): Option[Any] =
      if !sym.exists then return None
      try
        sym.tree match
          case valDef: ValDef =>
            valDef.rhs match
              case Some(Literal(constant)) => Some(constant.value)
              case _ => None
          case _ => None
      catch case _ => None

    def emitCall(tree: Tree, fun: Tree, owner: Symbol, args: List[Tree]): Unit =
      val sym = callSymbol(fun)
      if !sym.exists || sym.isLocalDummy then return
      position(tree) match
        case None => ()
        case Some(p) =>
          val fields = mutable.ArrayBuffer.empty[String]
          fields += "\"kind\":\"call\""
          fields += s"\"file\":${ScalasemInspector.jsonStr(p.sourceFile.path)}"
          fields += s"\"line\":${p.startLine + 1}"
          fields += s"\"column\":${p.startColumn + 1}"
          fields += s"\"caller\":${ScalasemInspector.jsonStr(enclosingOf(owner))}"
          fields += s"\"owner\":${ScalasemInspector.jsonStr(sym.owner.fullName)}"
          fields += s"\"name\":${ScalasemInspector.jsonStr(sym.name)}"
          val signature = signatureOf(sym)
          if signature.nonEmpty then
            fields += s"\"signature\":${ScalasemInspector.jsonStr(signature)}"
          val argFacts = args.flatMap(argumentFacts)
          if argFacts.nonEmpty then fields += s"\"args\":[${argFacts.mkString(",")}]"
          addFact(fields.toSeq*)

    def emitReference(tree: Tree, kind: String): Unit =
      val sym = tree match
        case ident: Ident => ident.symbol
        case select: Select => select.symbol
        case typeTree: TypeTree =>
          try typeTree.symbol
          catch case _ => Symbol.noSymbol
        case _ => Symbol.noSymbol
      if !sym.exists then
        if kind != "type" then unresolvedSymbols += 1
        return
      if sym.isLocalDummy || sym.flags.is(Flags.Package) then return
      position(tree) match
        case None => ()
        case Some(p) =>
          val ownerName = sym.owner.fullName
          // One reference per owner and line is enough for every consumer.
          val key = s"${p.sourceFile.path}#${p.startLine + 1}#$ownerName"
          if !refs.contains(key) then
            refs(key) = Seq(
              "\"kind\":\"ref\"",
              s"\"file\":${ScalasemInspector.jsonStr(p.sourceFile.path)}",
              s"\"line\":${p.startLine + 1}",
              s"\"column\":${p.startColumn + 1}",
              s"\"symbol\":${ScalasemInspector.jsonStr(sym.fullName)}",
              s"\"owner\":${ScalasemInspector.jsonStr(ownerName)}",
              s"\"refKind\":${ScalasemInspector.jsonStr(kind)}",
            ).mkString("{", ",", "}")

    object Walker extends TreeTraverser:
      override def traverseTree(tree: Tree)(owner: Symbol): Unit = tree match
        case apply: Apply =>
          emitCall(apply, apply.fun, owner, apply.args)
          traverseCallFun(apply.fun)(owner)
          apply.args.foreach(traverseTree(_)(owner))
        case typeApply: TypeApply =>
          emitCall(typeApply, typeApply.fun, owner, Nil)
          traverseCallFun(typeApply.fun)(owner)
          typeApply.args.foreach(traverseTree(_)(owner))
        case classDef: ClassDef =>
          emitDefinition(
            classDef.symbol,
            "class",
            position(classDef),
            extra = fields =>
              val parents = classDef.parents.flatMap(parent =>
                try
                  parent match
                    case typeTree: TypeTree => List(typeTree.tpe.typeSymbol.fullName)
                    case other => List(other.symbol.owner.fullName)
                catch case _ => Nil
              )
              if parents.nonEmpty then
                fields += s"\"parents\":[${parents.map(ScalasemInspector.jsonStr).mkString(",")}]"
          )
          if !classDef.symbol.flags.is(Flags.Synthetic) then
            projectSymbols += classDef.symbol.fullName
          super.traverseTree(tree)(owner)
        case defDef: DefDef =>
          if !defDef.name.startsWith("$anonfun") then
            emitDefinition(defDef.symbol, "def", position(defDef), extra = _ => ())
          super.traverseTree(tree)(owner)
        case valDef: ValDef =>
          if !valDef.name.startsWith("$anonfun") then
            emitDefinition(valDef.symbol, "val", position(valDef), extra = _ => ())
            emitConstant(valDef)
          super.traverseTree(tree)(owner)
        case typeDef: TypeDef =>
          emitDefinition(typeDef.symbol, "type", position(typeDef), extra = _ => ())
          super.traverseTree(tree)(owner)
        case imp: Import =>
          emitReference(imp.expr, "import")
          super.traverseTree(tree)(owner)
        case other =>
          other match
            case ident: Ident => emitReference(ident, "term")
            case select: Select => emitReference(select, "term")
            case typeTree: TypeTree => emitReference(typeTree, "type")
            case _ => ()
          super.traverseTree(tree)(owner)

      /** The function part of a call: a type application directly under an Apply belongs to
        * that call and is not reported as a call of its own.
        */
      private def traverseCallFun(fun: Tree)(owner: Symbol): Unit = fun match
        case typeApply: TypeApply =>
          traverseTree(typeApply.fun)(owner)
          typeApply.args.foreach(traverseTree(_)(owner))
        case other => traverseTree(other)(owner)

    for tasty <- tastys do
      try Walker.traverseTree(tasty.ast)(Symbol.spliceOwner)
      catch case err: Throwable =>
        // One file the walker cannot handle must not cost the whole batch.
        failedFiles += 1
        System.err.println(s"scalasem: ${err.getClass.getName}: ${Option(err.getMessage).getOrElse("")}")

  def printFacts(inspectorOk: Boolean): Unit =
    for key <- refs.keys do
      val owner = key.substring(key.lastIndexOf('#') + 1)
      if !isProjectOwner(owner) then facts += refs(key)
    if unresolvedSymbols > 0 then
      facts += s"""{"kind":"diag","code":"unresolved-symbols","count":$unresolvedSymbols}"""
    if failedFiles > 0 then
      facts += s"""{"kind":"diag","code":"walker-failed","count":$failedFiles}"""
    if !inspectorOk then facts += """{"kind":"diag","code":"inspector-errors"}"""
    for fact <- facts do println(fact)

  /** True when the owner chain starts at a symbol the inspected files define. */
  private def isProjectOwner(owner: String): Boolean =
    var name = owner
    while name.nonEmpty do
      if projectSymbols.contains(name) then return true
      name = if name.contains('.') then name.substring(0, name.lastIndexOf('.')) else ""
    false
