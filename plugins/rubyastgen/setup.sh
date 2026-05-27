#! /usr/bin/env bash
set -e
export GEM_HOME=.
bundle install --binstubs=../bin --no-cache --standalone=frontend

# Clean up Ruby gems bloat
rm -rf bundle/ruby/*/bundler/gems/ruby_ast_gen-*/.git*
rm -rf bundle/ruby/*/cache

# Remove documentation and tests from all gems
find bundle/ruby/*/gems -type d \( -name "test" -o -name "tests" -o -name "spec" -o -name "doc" -o -name "docs" -o -name "example" -o -name "examples" \) -exec rm -rf {} + 2>/dev/null || true
find bundle/ruby/*/gems -type f \( -name "*.md" -o -name "*.txt" -o -name "*.gemspec" -o -name "Rakefile" -o -name "*.yml" -o -name "*.yaml" \) -delete 2>/dev/null || true

# Clean up documentation in extensions and bundler
find bundle/ruby/*/extensions -type f \( -name "*.md" -o -name "*.txt" \) -delete 2>/dev/null || true
find bundle/ruby/*/bundler -type f \( -name "*.md" -o -name "*.txt" \) -delete 2>/dev/null || true

