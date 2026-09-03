# Lesson 6: Ruby ASTs without gem installs

## Learning Objective

Generate Ruby ASTs, see which files discovery actually finds in a Ruby project, and learn the semantic details (Sorbet sigs, magic comments, call operators) the JSON records beyond the tree itself.

## Pre-requisites

```text
Ruby 3.4.x or 4.0.x on the PATH (or ATOM_RUBY_HOME pointing at an install)
atom-parsetools installed
```

Nothing else: the ruby_ast_gen gem (2.0.1) and its pure-Ruby dependencies ship inside the package under `plugins/rubyastgen`, exposed to the interpreter through `GEM_PATH`. No `gem install`, no bundler. Confirm the machine is ready:

```shell
rbastgen --parser-info
```

The `Parser gem` and `Prism gem` lines name the versions actually loaded, the vendored `parser` and the runtime's `prism`. Note them when comparing output across machines.

## Getting started

Create a project that looks like a real Ruby repository: application code, a Sorbet signature, and the DSL files Ruby projects keep at their root.

```shell
mkdir hello-ruby && cd hello-ruby

cat > Gemfile << 'EOF'
# frozen_string_literal: true
source "https://rubygems.org"
gem "json"
EOF

cat > Rakefile << 'EOF'
task :default => :build

task :build do
  puts "building"
end
EOF

cat > app.rb << 'EOF'
# typed: true
# frozen_string_literal: true

sig { params(name: String).returns(String) }
def greet(name)
  "hi #{name}"
end

PERCENT = %w[a b c]
puts greet("world") if PERCENT.include?("a")
EOF
```

Parse it:

```shell
rbastgen -i . -o ruby-ast
```

## What discovery found

```shell
ls ruby-ast
```

Three AST files: `app.rb.json`, `Gemfile.json`, and `Rakefile.json`. The last two have no `.rb` extension, and that is deliberate. Ruby projects keep executable and declarative Ruby in `Rakefile`, `Gemfile`, `Capfile`, `Vagrantfile`, `Fastfile` and friends, matched by basename, plus extensions like `.gemspec`, `.rake`, `.ru`, `.rbi`, `.thor`, `.jbuilder`, `.axlsx`, and `.rabl`. A parser that only reads `*.rb` misses half the build logic of a typical gem, and build logic is exactly where dependency analysis wants to look.

The run also wrote `ruby_ast_gen_manifest.jsonl`:

```shell
cat ruby-ast/ruby_ast_gen_manifest.jsonl | python3 -m json.tool
```

One object: input and output, the backend used, counts of parsed, failed, skipped, excluded, and truncated files, plus threads and max depth. There is no diagnostics file, because nothing failed; a clean run removes any stale one from an earlier run.

## Reading the semantics

The point of this generator is not the tree, which any parser can produce, but the metadata a consumer would otherwise re-derive from positions:

```shell
python3 -c "
import json
d = json.load(open('ruby-ast/app.rb.json'))
for key in ('parser_backend', 'generator_version', 'ruby_version', 'magic_comments'):
    print(key, '=', d.get(key))
"
```

You will see `magic_comments` containing the Sorbet `typed: true` level and `frozen_string_literal: true`, and provenance keys naming the backend and versions. Inside the tree, the `def greet` node carries `has_sig: true` because a Sorbet `sig` block precedes it; the `%w` array node carries `percent_array`; calls carry `call_operator` and `has_parentheses`. Each of these is a small fact, and together they are the difference between a tree and something a type-aware consumer can use.

## Failure behavior, including the exit-code caveat

Per-file problems are reported and skipped, never fatal. But rbastgen has a caveat that belongs in every CI script you write: the wrapper does not propagate the generator's exit status. `--fail-on-error` is reported in the log, yet the wrapper still exits 0. Verify it:

```shell
printf 'def broken( %%^\n' > bad.rb
rbastgen -i . -o ruby-ast --fail-on-error; echo "exit: $?"
cat ruby-ast/ruby_ast_gen_diagnostics.jsonl
rm bad.rb
```

The exit prints 0, and the failure lives in the diagnostics record with its message, line, and column. A CI job that must fail on Ruby parse errors should read `files_failed` from the manifest, or invoke the gem directly via `RUBY_ASTGEN_BIN`.

## Where to go next

[Lesson 7](LESSON7.md) explains the two Ruby parsing backends, why the grammar ceiling follows the runtime's prism, and when to pin `--parser-target`.
