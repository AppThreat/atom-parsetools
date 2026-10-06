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

    /** The definition a call belongs to as the source reads: closures, local vals and the
      * statements of a template body resolve to the method or class around them.
      */
    def enclosingOf(owner: Symbol): String =
      def local(sym: Symbol): Boolean =
        sym.exists && !sym.isClassDef && !sym.isPackageDef && sym.maybeOwner.exists &&
          !sym.maybeOwner.isClassDef
      var sym = owner
      while sym.exists && (sym.isLocalDummy || sym.name.startsWith("$anonfun") ||
          (sym.isValDef && local(sym))) do
        sym = sym.maybeOwner
      val full = (if sym.exists then sym else owner).fullName
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
      // The compiler's own bookkeeping (source file, sealed children) is not source evidence.
      val sourceAnnotations = sym.annotations.filter(annotation =>
        try !annotation.tpe.typeSymbol.fullName.startsWith("scala.annotation.internal.")
        catch case _ => false
      )
      val annotations = sourceAnnotations.flatMap(annotation =>
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

    /** The value parameter names of a method, every parameter list flattened in declaration
      * order; type parameters have no argument position and stay out.
      */
    def paramNamesOf(sym: Symbol): Seq[String] =
      try
        paramSymbolsOf(sym).map(_.name.toString)
      catch case _ => Nil

    /** The symbols of a method's value parameters, matching `paramNamesOf` element for
      * element.
      */
    def paramSymbolsOf(sym: Symbol): Seq[Symbol] =
      try sym.paramSymss.flatten.filter(_.isTerm)
      catch case _ => Nil

    def callSymbol(fun: Tree): Symbol = fun match
      case apply: Apply => callSymbol(apply.fun)
      case typeApply: TypeApply => callSymbol(typeApply.fun)
      case select: Select => select.symbol
      case ident: Ident => ident.symbol
      case _ => Symbol.noSymbol

    /** The enclosing method a tree belongs to once anonymous functions fold away: the first
      * method or value definition on the owner chain that is not a lambda.
      */
    def enclosingMethodOf(owner: Symbol): Symbol =
      var sym = owner
      var guard = 0
      while sym.exists && guard < 64 do
        guard += 1
        if sym.isDefDef || sym.isValDef then
          if !sym.name.startsWith("$anonfun") && !sym.flags.is(Flags.Synthetic) then return sym
        sym = sym.maybeOwner
      Symbol.noSymbol

    /** True when a symbol is one of the parameters of the method that encloses a call. */
    def paramIndexOf(argSym: Symbol, enclosing: Symbol): Option[Int] =
      if !argSym.exists || !enclosing.exists then return None
      val params = paramSymbolsOf(enclosing)
      val found = params.indexOf(argSym)
      if found >= 0 then Some(found) else None

    /** The position of a by-name parameter of the enclosing method, when the symbol is one.
      * Evaluating such a parameter runs the argument expression the caller passed, so the
      * reference is an application of it.
      */
    def byNameIndexOf(argSym: Symbol, enclosing: Symbol): Option[Int] =
      val index = paramIndexOf(argSym, enclosing) match
        case Some(found) => found
        case None => return None
      val params = paramSymbolsOf(enclosing)
      if index >= params.length then return None
      val isByName =
        try
          // The by-name type tree has no public type in the reflection API; its tree class
          // name is the same on every release.
          params(index).tree match
            case paramDef: ValDef =>
              paramDef.tpt.getClass.getSimpleName == "ByNameTypeTree"
            case _ => false
        catch case _ => false
      if isByName then Some(index) else None

    /** Argument facts: string and number literals, references to constant vals, the position a
      * parameter of the enclosing method is passed at, identifiers that are neither, the literal
      * parts of interpolations, and calls whose own arguments are literals. Each fact carries the
      * position of the parameter it is passed to; the elements of a repeated argument share the
      * position of the repeated parameter.
      */
    def argumentFacts(arg: Tree, index: Int, enclosing: Symbol): List[String] = arg match
      case NamedArg(_, inner) => argumentFacts(inner, index, enclosing)
      case Typed(inner, _) => argumentFacts(inner, index, enclosing)
      case Repeated(elems, _) => elems.flatMap(argumentFacts(_, index, enclosing))
      case Literal(constant) =>
        constant.value match
          case s: String => List(s"""{"index":$index,"string":${ScalasemInspector.jsonStr(s)}}""")
          case v: Int => List(s"""{"index":$index,"int":$v}""")
          case v: Long => List(s"""{"index":$index,"long":$v}""")
          case v: Boolean => List(s"""{"index":$index,"boolean":$v}""")
          case _ => Nil
      case ident: Ident =>
        val sym = ident.symbol
        if !sym.exists then return Nil
        constantValue(sym) match
          case Some(s: String) =>
            List(
              s"""{"index":$index,"const":${ScalasemInspector.jsonStr(s)},"sym":${ScalasemInspector.jsonStr(sym.fullName)}}"""
            )
          case Some(v: Int) =>
            List(
              s"""{"index":$index,"const":$v,"sym":${ScalasemInspector.jsonStr(sym.fullName)}}"""
            )
          case _ => referenceArgFact(sym, index, enclosing)
      case select: Select =>
        val sym = select.symbol
        if !sym.exists || sym.isPackageDef then return Nil
        constantValue(sym) match
          case Some(s: String) =>
            List(
              s"""{"index":$index,"const":${ScalasemInspector.jsonStr(s)},"sym":${ScalasemInspector.jsonStr(sym.fullName)}}"""
            )
          case Some(v: Int) =>
            List(
              s"""{"index":$index,"const":$v,"sym":${ScalasemInspector.jsonStr(sym.fullName)}}"""
            )
          case _ => referenceArgFact(sym, index, enclosing)
      case _ => interpolatedParts(arg, index, enclosing)

    /** An argument that names a value: a parameter of the enclosing method carries its position,
      * any other value its identifier and symbol.
      */
    def referenceArgFact(sym: Symbol, index: Int, enclosing: Symbol): List[String] =
      paramIndexOf(sym, enclosing) match
        case Some(k) =>
          List(
            s"""{"index":$index,"param":${ScalasemInspector.jsonStr(sym.name.toString)},"paramIndex":$k}"""
          )
        case None =>
          List(
            s"""{"index":$index,"ident":${ScalasemInspector.jsonStr(sym.name.toString)},"sym":${ScalasemInspector.jsonStr(sym.fullName)}}"""
          )

    /** The literal and hole pieces of a string interpolation passed as an argument, for example
      * `uri"https://host/$path"`. A hole that is a constant or a parameter keeps its resolution.
      */
    def interpolatedParts(arg: Tree, index: Int, enclosing: Symbol): List[String] =
      var isInterpolation = false
      object Detect extends TreeTraverser:
        override def traverseTree(tree: Tree)(owner: Symbol): Unit =
          tree match
            case select: Select =>
              val ownerName = try select.symbol.maybeOwner.fullName catch case _ => ""
              if ownerName == "scala.StringContext" || ownerName == "scala.StringContext$" then
                isInterpolation = true
            case _ => ()
          super.traverseTree(tree)(owner)
      Detect.traverseTree(arg)(Symbol.spliceOwner)
      if !isInterpolation then return callArgFact(arg, index)
      var parts: List[String] = Nil
      object Parts extends TreeTraverser:
        override def traverseTree(tree: Tree)(owner: Symbol): Unit =
          if parts.isEmpty then
            tree match
              case seq: Repeated =>
                val literals = seq.elems.collect { case Literal(constant) =>
                  constant.value match
                    case s: String => ScalasemInspector.jsonStr(s)
                    case v: Int => v.toString
                    case v: Long => v.toString
                    case v: Boolean => v.toString
                    case _ => null
                }
                if literals.nonEmpty && !literals.contains(null) then parts = literals.toList
                else super.traverseTree(tree)(owner)
              case _ => super.traverseTree(tree)(owner)
      Parts.traverseTree(arg)(Symbol.spliceOwner)
      if parts.isEmpty then return callArgFact(arg, index)
      // The holes are the value arguments of the calls between the outermost one and the
      // StringContext application, whose own argument holds the literal parts. Implicit
      // conversion witnesses and defaults are methods and are not holes.
      val holeValue: Tree => Option[String] =
        case ident: Ident if ident.symbol.exists && !ident.symbol.isPackageDef =>
          if ident.symbol.isDefDef then None
          else
            Some(
              constantValue(ident.symbol) match
                case Some(s: String) =>
                  s"""{"const":${ScalasemInspector.jsonStr(s)},"sym":${ScalasemInspector.jsonStr(ident.symbol.fullName)}}"""
                case Some(v: Int) =>
                  s"""{"const":$v,"sym":${ScalasemInspector.jsonStr(ident.symbol.fullName)}}"""
                case _ =>
                  paramIndexOf(ident.symbol, enclosing) match
                    case Some(k) =>
                      s"""{"param":${ScalasemInspector.jsonStr(ident.symbol.name.toString)},"paramIndex":$k}"""
                    case None =>
                      s"""{"ident":${ScalasemInspector.jsonStr(ident.symbol.name.toString)}}"""
            )
        case select: Select if select.symbol.exists && !select.symbol.isPackageDef =>
          if select.symbol.isDefDef then None
          else
            Some(
              constantValue(select.symbol) match
                case Some(s: String) =>
                  s"""{"const":${ScalasemInspector.jsonStr(s)},"sym":${ScalasemInspector.jsonStr(select.symbol.fullName)}}"""
                case Some(v: Int) =>
                  s"""{"const":$v,"sym":${ScalasemInspector.jsonStr(select.symbol.fullName)}}"""
                case _ =>
                  s"""{"ident":${ScalasemInspector.jsonStr(select.symbol.name.toString)}}"""
            )
        case Literal(constant) =>
          constant.value match
            case s: String => Some(ScalasemInspector.jsonStr(s))
            case v: Int => Some(v.toString)
            case v: Long => Some(v.toString)
            case _ => None
        case _ => None
      val holeFacts = mutable.ArrayBuffer.empty[String]
      def collectHoles(tree: Tree, depth: Int): Unit =
        if depth < 12 && holeFacts.size < 16 then
          tree match
            case apply: Apply =>
              // The StringContext application carries the literal parts; every other call of
              // the chain carries holes, a vararg list of them included.
              val partsHolder =
                try
                  val target = callSymbol(apply.fun)
                  target.exists &&
                  (target.maybeOwner.fullName == "scala.StringContext" ||
                    target.maybeOwner.fullName == "scala.StringContext$")
                catch case _ => false
              if !partsHolder then
                for hole <- apply.args do
                  hole match
                    case Typed(Repeated(elems, _), _) =>
                      for elem <- elems do
                        holeValue(elem) match
                          case Some(fact) => holeFacts += fact
                          case None => ()
                    case other =>
                      holeValue(other) match
                        case Some(fact) => holeFacts += fact
                        case None => ()
              collectHoles(apply.fun, depth + 1)
            case typeApply: TypeApply => collectHoles(typeApply.fun, depth + 1)
            case typed: Typed => collectHoles(typed.expr, depth + 1)
            case _ => ()
      collectHoles(arg, 0)
      val pieces = mutable.ArrayBuffer.empty[String]
      for (literal, i) <- parts.zipWithIndex do
        pieces += literal
        if i < holeFacts.length then pieces += holeFacts(i)
      List(s"""{"index":$index,"parts":[${pieces.mkString(",")}]}""")

    /** A call argument that is itself a call with literal string arguments, for example
      * `toCString("jdbc:...")`: the literal arguments survive, the rest does not. The
      * literals of every argument list of the call count, and so does a literal receiver of
      * an extension method.
      */
    def callArgFact(arg: Tree, index: Int): List[String] = arg match
      case apply: Apply =>
        val sym = callSymbol(apply.fun)
        if !sym.exists then return Nil
        val literals = mutable.ArrayBuffer.empty[String]
        var cursor: Tree = apply
        var guard = 0
        while guard < 8 do
          guard += 1
          cursor match
            case call: Apply =>
              call.fun match
                case select: Select =>
                  select.qualifier match
                    case Literal(constant) =>
                      constant.value match
                        case text: String =>
                          literals += ScalasemInspector.jsonStr(text)
                        case _ => ()
                    case _ => ()
                case _ => ()
              literals ++= call.args.collect {
                case Literal(constant) if constant.value.isInstanceOf[String] =>
                  ScalasemInspector.jsonStr(constant.value.asInstanceOf[String])
              }
              cursor = call.fun
            case typeApply: TypeApply => cursor = typeApply.fun
            case _ => guard = 8
        if literals.isEmpty then Nil
        else
          List(
            s"""{"index":$index,"call":${ScalasemInspector.jsonStr(s"${sym.owner.fullName}.${sym.name}")},"args":[${literals.mkString(",")}]}"""
          )
      case typeApply: TypeApply => callArgFact(typeApply.fun, index)
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
          val enclosing = enclosingMethodOf(owner)
          val fields = mutable.ArrayBuffer.empty[String]
          fields += "\"kind\":\"call\""
          fields += s"\"file\":${ScalasemInspector.jsonStr(p.sourceFile.path)}"
          fields += s"\"line\":${p.startLine + 1}"
          fields += s"\"column\":${p.startColumn + 1}"
          if p.endLine >= p.startLine then
            fields += s"\"endLine\":${p.endLine + 1}"
          fields += s"\"caller\":${ScalasemInspector.jsonStr(enclosingOf(owner))}"
          fields += s"\"owner\":${ScalasemInspector.jsonStr(sym.owner.fullName)}"
          fields += s"\"name\":${ScalasemInspector.jsonStr(sym.name)}"
          val signature = signatureOf(sym)
          if signature.nonEmpty then
            fields += s"\"signature\":${ScalasemInspector.jsonStr(signature)}"
          // A call on a local value or parameter names its receiver, which is how dynamic
          // member access and builder receivers are followed.
          fun match
            case select: Select =>
              select.qualifier match
                case ident: Ident if ident.symbol.exists && !ident.symbol.isPackageDef =>
                  fields += s"""\"recv\":{""" +
                    s""""ident":${ScalasemInspector.jsonStr(ident.symbol.name.toString)},""" +
                    s""""sym":${ScalasemInspector.jsonStr(ident.symbol.fullName)}}"""
                case _ => ()
            case _ => ()
          val argFacts =
            args.zipWithIndex.flatMap((arg, index) => argumentFacts(arg, index, enclosing))
          if argFacts.nonEmpty then fields += s"\"args\":[${argFacts.mkString(",")}]"
          addFact(fields.toSeq*)

    /** One reference per symbol, owner and line is enough for every consumer. */
    def recordReference(p: Position, symbol: String, owner: String, kind: String): Unit =
      val key = s"${p.sourceFile.path}#${p.startLine + 1}#$owner#$symbol"
      if !refs.contains(key) then
        refs(key) = Seq(
          "\"kind\":\"ref\"",
          s"\"file\":${ScalasemInspector.jsonStr(p.sourceFile.path)}",
          s"\"line\":${p.startLine + 1}",
          s"\"column\":${p.startColumn + 1}",
          s"\"symbol\":${ScalasemInspector.jsonStr(symbol)}",
          s"\"owner\":${ScalasemInspector.jsonStr(owner)}",
          s"\"refKind\":${ScalasemInspector.jsonStr(kind)}",
        ).mkString("{", ",", "}")

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
      position(tree).foreach(p => recordReference(p, sym.fullName, sym.owner.fullName, kind))

    /** The members an import names, at the line of each selector. A wildcard import records the
      * package or object it opens, since that is the only name the source line carries.
      */
    def emitImportSelectors(imp: Import): Unit =
      val base = imp.expr.symbol
      if !base.exists then return
      def selectorPosition(selector: Selector): Option[Position] =
        try
          val p = selector match
            case s: SimpleSelector => Some(s.namePos)
            case r: RenameSelector => Some(r.fromPos)
            case _ => None
          p.filter(_.startLine >= 0).orElse(position(imp))
        catch case _ => position(imp)
      def memberName(name: String): String =
        val member =
          val tpe = try base.typeMember(name) catch case _ => Symbol.noSymbol
          if tpe.exists then tpe else try base.fieldMember(name) catch case _ => Symbol.noSymbol
        if member.exists then member.fullName else s"${base.fullName}.$name"
      for selector <- imp.selectors do
        selector match
          case s: SimpleSelector if s.name == "_" || s.name == "*" =>
            // `import a.b.*` names the package or object itself
            selectorPosition(s).foreach(p => recordReference(p, base.fullName, base.owner.fullName, "import"))
          case s: SimpleSelector =>
            selectorPosition(s).foreach(p => recordReference(p, memberName(s.name), base.fullName, "import"))
          case r: RenameSelector =>
            selectorPosition(r).foreach(p => recordReference(p, memberName(r.fromName), base.fullName, "import"))
          case _ => ()

    /** One extractor application in a pattern, with the literal and identifier patterns it
      * names. Route DSLs build their paths in patterns, so the literals are the path segments.
      */
    def emitPattern(unapply: Unapply): Unit =
      val sym = unapply.fun match
        case select: Select => select.symbol
        case typeApply: TypeApply =>
          typeApply.fun match
            case select: Select => select.symbol
            case _ => Symbol.noSymbol
        case _ => Symbol.noSymbol
      position(unapply) match
        case None => ()
        case Some(p) =>
          val literals = mutable.ArrayBuffer.empty[String]
          val idents = mutable.ArrayBuffer.empty[String]
          for pattern <- unapply.patterns do pattern match
            case Literal(constant) =>
              constant.value match
                case s: String => literals += ScalasemInspector.jsonStr(s)
                case v: Int => literals += v.toString
                case v: Long => literals += v.toString
                case v: Boolean => literals += v.toString
                case _ => ()
            case ident: Ident =>
              val target = ident.symbol
              if target.exists && !target.isPackageDef then
                idents += ScalasemInspector.jsonStr(target.name.toString)
            case _ => ()
          val fields = mutable.ArrayBuffer.empty[String]
          fields += "\"kind\":\"pattern\""
          fields += s"\"file\":${ScalasemInspector.jsonStr(p.sourceFile.path)}"
          fields += s"\"line\":${p.startLine + 1}"
          fields += s"\"column\":${p.startColumn + 1}"
          if sym.exists then
            fields += s"\"owner\":${ScalasemInspector.jsonStr(sym.owner.fullName)}"
            fields += s"\"name\":${ScalasemInspector.jsonStr(sym.name)}"
          if literals.nonEmpty then fields += s"\"args\":[${literals.mkString(",")}]"
          if idents.nonEmpty then fields += s"\"idents\":[${idents.mkString(",")}]"
          addFact(fields.toSeq*)

    /** The application of a by-name parameter: the argument runs here, in this method. */
    def emitByNameApplication(ident: Ident, owner: Symbol): Unit =
      val sym = ident.symbol
      if !sym.exists then return
      val enclosing = enclosingMethodOf(owner)
      byNameIndexOf(sym, enclosing) match
        case Some(index) =>
          position(ident) match
            case Some(p) =>
              addFact(
                "\"kind\":\"call\"",
                s"\"file\":${ScalasemInspector.jsonStr(p.sourceFile.path)}",
                s"\"line\":${p.startLine + 1}",
                s"\"column\":${p.startColumn + 1}",
                s"\"caller\":${ScalasemInspector.jsonStr(enclosingOf(owner))}",
                s"\"owner\":${ScalasemInspector.jsonStr(enclosing.fullName)}",
                s"\"name\":${ScalasemInspector.jsonStr(sym.name.toString)}",
                s"\"byName\":$index",
              )
            case None => ()
        case None => ()

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
          // The bodies the compiler generates (case class equality, enum lookups) hold no
          // source calls, only runtime helpers placed at the declaration's line. Anonymous
          // function bodies are source code: their calls fold up to the enclosing method.
          if defDef.name.startsWith("$anonfun") then
            super.traverseTree(tree)(owner)
          else if !defDef.symbol.flags.is(Flags.Synthetic) then
            emitDefinition(
              defDef.symbol,
              "def",
              position(defDef),
              extra = fields =>
                val names = paramNamesOf(defDef.symbol)
                if names.nonEmpty then
                  fields += s"\"params\":[${names.map(ScalasemInspector.jsonStr).mkString(",")}]"
            )
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
          emitImportSelectors(imp)
          super.traverseTree(tree)(owner)
        case other =>
          other match
            case ident: Ident =>
              emitReference(ident, "term")
              emitByNameApplication(ident, owner)
            case select: Select => emitReference(select, "term")
            case typeTree: TypeTree => emitReference(typeTree, "type")
            case unapply: Unapply => emitPattern(unapply)
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
      val parts = key.split('#')
      val owner = parts(parts.length - 2)
      val symbol = parts(parts.length - 1)
      if !isProjectOwner(owner) && !isProjectOwner(symbol) then facts += refs(key)
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
